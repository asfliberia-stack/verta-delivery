// notify.js — sends an instant WhatsApp or SMS notification when a new
// order is placed, using Twilio's REST API directly (no SDK dependency —
// just a signed HTTPS POST, using Node 18's built-in fetch).
//
// WHERE TO ADD YOUR API KEYS:
// Set these in server/.env (local) or Railway's Variables tab (production).
// None of this crashes the app if left unset — notifications just quietly
// no-op with a console warning, so you can add this later without breaking
// anything else.
//
//   TWILIO_ACCOUNT_SID   — from your Twilio Console dashboard
//   TWILIO_AUTH_TOKEN    — from your Twilio Console dashboard
//   TWILIO_FROM_NUMBER   — the Twilio number/sandbox you send FROM
//   NOTIFY_TO_NUMBER     — the number you want alerts sent TO (defaults to
//                          +231881405696, your number, but can be overridden)
//   NOTIFY_CHANNEL       — "whatsapp" or "sms" (defaults to "whatsapp")
//
// See README.md → "Setting up WhatsApp/SMS notifications" for full,
// step-by-step Twilio setup instructions (sandbox joining code, number
// formats, going to production, etc).

const ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID;
const AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN;
const FROM_NUMBER = process.env.TWILIO_FROM_NUMBER;
const TO_NUMBER = process.env.NOTIFY_TO_NUMBER || '+231881405696';
const CHANNEL = (process.env.NOTIFY_CHANNEL || 'whatsapp').toLowerCase(); // 'whatsapp' | 'sms'

const isConfigured = Boolean(ACCOUNT_SID && AUTH_TOKEN && FROM_NUMBER);

if (!isConfigured) {
  console.log(
    '[notify] Twilio credentials not set — order notifications are disabled. ' +
    'Set TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, and TWILIO_FROM_NUMBER to enable them (see README).'
  );
}

// Twilio's WhatsApp channel requires the "whatsapp:" prefix on both the
// From and To numbers; plain SMS uses bare E.164 numbers. This is the only
// difference between the two send paths.
function formatNumber(number) {
  if (CHANNEL === 'whatsapp') {
    return number.startsWith('whatsapp:') ? number : `whatsapp:${number}`;
  }
  return number.replace(/^whatsapp:/, '');
}

async function notifyNewOrder(order) {
  if (!isConfigured) return; // silently skip — nothing else in the app depends on this

  const message =
    `New Verta Delivery order!\n` +
    `Order: ${order.id}\n` +
    `From: ${order.senderName}\n` +
    `Pickup: ${order.pickupAddress}\n` +
    `Dropoff: ${order.dropoffAddress}\n` +
    `Item: ${order.itemDescription}`;

  await sendMessage(TO_NUMBER, message);
}

// Generic send, usable for anything that needs to reach an arbitrary
// phone number — currently just password reset codes (server.js), sent
// to whatever number that specific user registered with, as opposed to
// notifyNewOrder above which always goes to the fixed business owner
// number (NOTIFY_TO_NUMBER).
async function sendMessage(toNumber, message) {
  if (!isConfigured) return false;
  if (!toNumber) return false;

  const url = `https://api.twilio.com/2010-04-01/Accounts/${ACCOUNT_SID}/Messages.json`;
  const body = new URLSearchParams({
    From: formatNumber(FROM_NUMBER),
    To: formatNumber(toNumber),
    Body: message,
  });

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Authorization: 'Basic ' + Buffer.from(`${ACCOUNT_SID}:${AUTH_TOKEN}`).toString('base64'),
      },
      body,
    });
    if (!res.ok) {
      const errText = await res.text();
      console.error(`[notify] Twilio send failed (${res.status}):`, errText);
      return false;
    }
    console.log(`[notify] Sent ${CHANNEL} message to ${toNumber}`);
    return true;
  } catch (err) {
    console.error('[notify] Failed to send message', err);
    return false;
  }
}

module.exports = { notifyNewOrder, sendMessage, isConfigured };
