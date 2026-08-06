// momo.js — MTN Mobile Money (MoMo) Collections API client, using
// Node 18's built-in fetch directly (same approach as notify.js's
// Twilio client — no SDK dependency, just signed HTTPS calls).
//
// WHERE TO ADD YOUR CREDENTIALS:
// Set these in server/.env (local) or Railway's Variables tab (production).
// None of this crashes the app if left unset — Mobile Money checkout
// just quietly stays unavailable (customers still see Pay on Delivery),
// so you can add this later without breaking anything else.
//
//   MOMO_SUBSCRIPTION_KEY  — "Ocp-Apim-Subscription-Key" from your product
//                            subscription on momodeveloper.mtn.com
//   MOMO_API_USER          — the API user id (a UUID) provisioned for your
//                            app — see server/scripts/momo-provision-sandbox.js
//                            for a one-time script that creates one against
//                            MTN's public sandbox
//   MOMO_API_KEY           — the API key generated for that API user
//   MOMO_TARGET_ENVIRONMENT — "sandbox" or "production" (defaults to "sandbox")
//   MOMO_BASE_URL          — defaults to MTN's public sandbox host; MTN
//                            Liberia will give you a production base URL
//                            (and the rest of these credentials) once
//                            you're approved — see README → "Mobile Money
//                            (MTN)" for how to request that
//   MOMO_CURRENCY          — defaults to "EUR", which is what MTN's sandbox
//                            requires regardless of your real target
//                            currency; MTN Liberia will tell you the real
//                            currency code to use once you have a
//                            production account (see README)
//
// See README.md → "Mobile Money (MTN)" for full setup instructions, and
// for the honest caveats about what's confirmed vs. best-effort here —
// MTN's public documentation for this API is notably sparse/inconsistent
// (confirmed by cross-referencing several independent developer writeups
// while building this), so a few details (the exact webhook payload
// shape, in particular) couldn't be pinned down with confidence and are
// handled defensively rather than assumed.

const {
  MOMO_SUBSCRIPTION_KEY,
  MOMO_API_USER,
  MOMO_API_KEY,
  MOMO_TARGET_ENVIRONMENT = 'sandbox',
  MOMO_BASE_URL = 'https://sandbox.momodeveloper.mtn.com',
  MOMO_CURRENCY = 'EUR',
} = process.env;

const isConfigured = Boolean(MOMO_SUBSCRIPTION_KEY && MOMO_API_USER && MOMO_API_KEY);

if (!isConfigured) {
  console.log(
    '[momo] MTN MoMo credentials not set — Mobile Money checkout is disabled (Pay on Delivery still works). ' +
    'Set MOMO_SUBSCRIPTION_KEY, MOMO_API_USER, and MOMO_API_KEY to enable it (see README).'
  );
}

// Same reasoning as notify.js's Twilio client: fetch() has no default
// timeout, so a slow/unresponsive path to MTN would otherwise hang the
// request indefinitely instead of failing with a clear, timely error.
async function fetchWithTimeout(url, options, timeoutMs = 15000) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timeoutId);
  }
}

// Access tokens are valid for ~1 hour (per MTN's docs) — cached
// in-memory and refreshed a little early (30s of slack) rather than
// re-authenticating on every single request-to-pay/status call.
let cachedToken = null; // { accessToken, expiresAt }

async function getAccessToken() {
  if (!isConfigured) throw new Error('Mobile Money is not configured on this server yet.');
  if (cachedToken && cachedToken.expiresAt > Date.now() + 30_000) {
    return cachedToken.accessToken;
  }
  const basicAuth = Buffer.from(`${MOMO_API_USER}:${MOMO_API_KEY}`).toString('base64');
  const res = await fetchWithTimeout(`${MOMO_BASE_URL}/collection/token/`, {
    method: 'POST',
    headers: {
      'Authorization': `Basic ${basicAuth}`,
      'Ocp-Apim-Subscription-Key': MOMO_SUBSCRIPTION_KEY,
    },
  });
  if (!res.ok) {
    throw new Error(`Failed to authenticate with MTN MoMo (HTTP ${res.status}) — check MOMO_API_USER/MOMO_API_KEY/MOMO_SUBSCRIPTION_KEY.`);
  }
  const data = await res.json();
  cachedToken = {
    accessToken: data.access_token,
    expiresAt: Date.now() + (Number(data.expires_in) || 3600) * 1000,
  };
  return cachedToken.accessToken;
}

// Initiates a "Request to Pay" — this sends a prompt to the customer's
// phone; they approve it there. amount is a plain number (dollars/major
// units, not cents — MTN's API takes decimal strings, not integer minor
// units, unlike e.g. Stripe). referenceId must be a fresh UUID per
// attempt — the caller generates it so it can be recorded against the
// purchase before this call is made (see server.js's checkout/momo
// route), since a network failure here shouldn't leave an
// unidentifiable in-flight payment.
async function requestToPay({ referenceId, amount, externalId, payerMsisdn, payerMessage, payeeNote }) {
  const token = await getAccessToken();
  const res = await fetchWithTimeout(`${MOMO_BASE_URL}/collection/v1_0/requesttopay`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Ocp-Apim-Subscription-Key': MOMO_SUBSCRIPTION_KEY,
      'X-Reference-Id': referenceId,
      'X-Target-Environment': MOMO_TARGET_ENVIRONMENT,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      amount: Number(amount).toFixed(2),
      currency: MOMO_CURRENCY,
      externalId: String(externalId),
      payer: { partyIdType: 'MSISDN', partyId: payerMsisdn },
      payerMessage: (payerMessage || '').slice(0, 160),
      payeeNote: (payeeNote || '').slice(0, 160),
    }),
  });
  // A successful request-to-pay call returns 202 Accepted with no body
  // — it only means the prompt was sent, not that the customer has
  // approved it yet. Actual outcome comes from getRequestToPayStatus.
  if (res.status !== 202) {
    let detail = '';
    try { detail = JSON.stringify(await res.json()); } catch (_) { /* no JSON body */ }
    throw new Error(`MTN MoMo declined the payment request (HTTP ${res.status})${detail ? `: ${detail}` : ''}`);
  }
  return { referenceId };
}

// Polls the real status of a previously-initiated request-to-pay.
// status is one of PENDING / SUCCESSFUL / FAILED per every source
// consulted while building this (consistent across independent
// writeups, unlike the webhook payload shape — see the module comment
// above). reason/raw are included for logging/debugging since the
// exact failure-reason field name isn't confirmed.
async function getRequestToPayStatus(referenceId) {
  const token = await getAccessToken();
  const res = await fetchWithTimeout(`${MOMO_BASE_URL}/collection/v1_0/requesttopay/${referenceId}`, {
    method: 'GET',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Ocp-Apim-Subscription-Key': MOMO_SUBSCRIPTION_KEY,
      'X-Target-Environment': MOMO_TARGET_ENVIRONMENT,
    },
  });
  if (!res.ok) {
    throw new Error(`Failed to check MTN MoMo payment status (HTTP ${res.status})`);
  }
  const data = await res.json();
  return { status: data.status, reason: data.reason || data.errorReason || null, raw: data };
}

module.exports = { isConfigured, getAccessToken, requestToPay, getRequestToPayStatus };
