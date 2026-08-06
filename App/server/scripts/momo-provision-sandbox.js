#!/usr/bin/env node
// momo-provision-sandbox.js — one-time setup script that creates an API
// user + API key against MTN's public MoMo sandbox. Run this ONCE to get
// the MOMO_API_USER / MOMO_API_KEY values that go in your environment
// variables (server/.env locally, or Railway's Variables tab in
// production) — the app itself never creates these automatically,
// since provisioning is a one-time credential-setup step, not something
// that should run on every server boot.
//
// USAGE:
//   1. Sign up at https://momodeveloper.mtn.com, subscribe to the
//      "Collections" product, and copy its Primary Key — that's your
//      MOMO_SUBSCRIPTION_KEY.
//   2. Run:
//        MOMO_SUBSCRIPTION_KEY=your-key-here node server/scripts/momo-provision-sandbox.js
//      (optionally add MOMO_CALLBACK_URL=https://yourapp.example.com/api/payments/momo/callback
//      — see README's "Mobile Money (MTN)" section for why this is
//      best-effort/optional; polling works fine without it)
//   3. Copy the printed MOMO_API_USER and MOMO_API_KEY values into your
//      environment alongside MOMO_SUBSCRIPTION_KEY.
//
// This targets the SANDBOX ONLY (sandbox.momodeveloper.mtn.com). For a
// real production Liberia merchant account, MTN Liberia (Lonestar Cell
// MTN) provisions your credentials directly through their own process —
// see README for how to request that. This script has no path to
// production credentials; there's no "prod" flag to flip.

const crypto = require('crypto');

const SANDBOX_BASE_URL = 'https://sandbox.momodeveloper.mtn.com';
const SUBSCRIPTION_KEY = process.env.MOMO_SUBSCRIPTION_KEY;
const CALLBACK_URL = process.env.MOMO_CALLBACK_URL || 'https://example.com/api/payments/momo/callback';

async function main() {
  if (!SUBSCRIPTION_KEY) {
    console.error('Missing MOMO_SUBSCRIPTION_KEY. Set it to your Collections product\'s Primary Key from momodeveloper.mtn.com, then re-run this script.');
    process.exit(1);
  }

  const apiUserId = crypto.randomUUID();
  console.log(`Creating sandbox API user ${apiUserId}...`);

  const createUserRes = await fetch(`${SANDBOX_BASE_URL}/v1_0/apiuser`, {
    method: 'POST',
    headers: {
      'X-Reference-Id': apiUserId,
      'Ocp-Apim-Subscription-Key': SUBSCRIPTION_KEY,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ providerCallbackHost: CALLBACK_URL }),
  });
  if (createUserRes.status !== 201) {
    const body = await createUserRes.text().catch(() => '');
    console.error(`Failed to create API user (HTTP ${createUserRes.status}): ${body}`);
    console.error('Double-check MOMO_SUBSCRIPTION_KEY is your Collections product\'s Primary Key, not a different product\'s.');
    process.exit(1);
  }

  console.log('Creating API key...');
  const createKeyRes = await fetch(`${SANDBOX_BASE_URL}/v1_0/apiuser/${apiUserId}/apikey`, {
    method: 'POST',
    headers: { 'Ocp-Apim-Subscription-Key': SUBSCRIPTION_KEY },
  });
  if (createKeyRes.status !== 201) {
    const body = await createKeyRes.text().catch(() => '');
    console.error(`Failed to create API key (HTTP ${createKeyRes.status}): ${body}`);
    process.exit(1);
  }
  const { apiKey } = await createKeyRes.json();

  console.log('\nDone. Add these to server/.env (local) or Railway\'s Variables tab (production):\n');
  console.log(`MOMO_SUBSCRIPTION_KEY=${SUBSCRIPTION_KEY}`);
  console.log(`MOMO_API_USER=${apiUserId}`);
  console.log(`MOMO_API_KEY=${apiKey}`);
  console.log(`MOMO_TARGET_ENVIRONMENT=sandbox`);
  console.log(`MOMO_BASE_URL=${SANDBOX_BASE_URL}`);
  console.log(`MOMO_CURRENCY=EUR  # sandbox only accepts EUR regardless of your real target currency\n`);
  console.log('Restart the app after setting these — Mobile Money checkout will then be available (see the "Mobile Money (MTN)" section in README for how it behaves, and its honest caveats).');
}

main().catch((err) => {
  console.error('Unexpected error:', err);
  process.exit(1);
});
