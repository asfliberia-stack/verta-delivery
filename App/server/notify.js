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
    // fetch() has no default timeout — without this, a slow or
    // unresponsive network path to Twilio can hang indefinitely rather
    // than failing with a clear error. Same reasoning as the SMTP
    // timeouts above.
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 10000);
    let res;
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          Authorization: 'Basic ' + Buffer.from(`${ACCOUNT_SID}:${AUTH_TOKEN}`).toString('base64'),
        },
        body,
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timeoutId);
    }
    if (!res.ok) {
      const errText = await res.text();
      console.error(`[notify] Twilio send failed (${res.status}):`, errText);
      return false;
    }
    console.log(`[notify] Sent ${CHANNEL} message to ${toNumber}`);
    return true;
  } catch (err) {
    if (err.name === 'AbortError') {
      console.error('[notify] Twilio request timed out after 10s — check for network/firewall restrictions on outbound HTTPS from this host');
    } else {
      console.error('[notify] Failed to send message', err);
    }
    return false;
  }
}

// ---- Email (generic SMTP, via nodemailer) ---------------------------
// Works with Gmail, a custom business domain, or a dedicated
// transactional service (SendGrid, Resend, etc.) — anything that
// speaks SMTP, rather than locking this app into one specific vendor.
//
// WHERE TO ADD YOUR CREDENTIALS:
// Set these in server/.env (local) or Railway's Variables tab
// (production). Same graceful-no-op pattern as the SMS/WhatsApp
// section above — leave unset and emails just quietly don't send,
// nothing else in the app breaks.
//
//   SMTP_HOST       — e.g. smtp.gmail.com
//   SMTP_PORT       — e.g. 587 (defaults to 587 if unset)
//   SMTP_USER       — the account you're sending FROM
//   SMTP_PASS       — that account's password (for Gmail specifically,
//                     this must be a 16-character "App Password", not
//                     your normal login password — see README)
//   EMAIL_FROM      — the "From" address shown to recipients (defaults
//                     to SMTP_USER if unset)
//   NOTIFY_EMAIL_TO — where business notifications (e.g. new vendor
//                     applications) get sent (defaults to
//                     onlib231@gmail.com, same as elsewhere in this app)

const nodemailer = require('nodemailer');

const SMTP_HOST = process.env.SMTP_HOST;
const SMTP_PORT = Number(process.env.SMTP_PORT) || 587;
const SMTP_USER = process.env.SMTP_USER;
const SMTP_PASS = process.env.SMTP_PASS;
const EMAIL_FROM = process.env.EMAIL_FROM || SMTP_USER;
const NOTIFY_EMAIL_TO = process.env.NOTIFY_EMAIL_TO || 'onlib231@gmail.com';

const isEmailConfigured = Boolean(SMTP_HOST && SMTP_USER && SMTP_PASS);

let transporter = null;
if (isEmailConfigured) {
  transporter = nodemailer.createTransport({
    host: SMTP_HOST,
    port: SMTP_PORT,
    secure: SMTP_PORT === 465, // 465 = implicit TLS; 587 (the common default) uses STARTTLS instead
    auth: { user: SMTP_USER, pass: SMTP_PASS },
    // Without explicit timeouts, a blocked or unresponsive SMTP
    // connection (some hosting providers restrict outbound SMTP by
    // default) can hang indefinitely rather than failing with a clear
    // error — which from the user's side just looks like a request
    // that never finishes. 10 seconds is generous for a real SMTP
    // handshake; anything slower than that is effectively not working.
    connectionTimeout: 10000,
    greetingTimeout: 10000,
    socketTimeout: 10000,
  });
} else {
  console.log(
    '[notify] SMTP credentials not set — email notifications are disabled. ' +
    'Set SMTP_HOST, SMTP_USER, and SMTP_PASS to enable them (see README).'
  );
}

// Generic send — usable for anything that needs to email an arbitrary
// address, same role sendMessage() plays for SMS/WhatsApp above.
async function sendEmail(to, subject, text) {
  if (!isEmailConfigured) return false;
  if (!to) return false;
  try {
    await transporter.sendMail({ from: EMAIL_FROM, to, subject, text });
    console.log(`[notify] Sent email to ${to}: "${subject}"`);
    return true;
  } catch (err) {
    if (err.code === 'ETIMEDOUT' || err.code === 'ESOCKET') {
      console.error(`[notify] SMTP connection to ${SMTP_HOST}:${SMTP_PORT} timed out — check for network/firewall restrictions on outbound SMTP from this host, or that the port is actually open.`);
    } else {
      console.error('[notify] Failed to send email', err);
    }
    return false;
  }
}

// The one place in this app that currently just logs to console instead
// of actually notifying anyone — a new vendor application.
async function notifyNewVendorApplication(businessName, email, applicationType = 'vendor') {
  if (!isEmailConfigured) return;
  const label = applicationType === 'delivery_company' ? 'delivery company' : 'vendor';
  const reviewLocation = applicationType === 'delivery_company' ? 'Delivery Companies' : 'Vendors';
  const subject = `New ${label} application: ${businessName}`;
  const text =
    `A new ${label} application was submitted.\n\n` +
    `Business: ${businessName}\n` +
    `Email: ${email}\n\n` +
    `Review it in the Super Admin console under ${reviewLocation}.`;
  await sendEmail(NOTIFY_EMAIL_TO, subject, text);
}

module.exports = { notifyNewOrder, sendMessage, isConfigured, sendEmail, notifyNewVendorApplication, isEmailConfigured };
