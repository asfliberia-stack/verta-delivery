-- Verta Delivery Service - PostgreSQL schema (Railway)
-- Run once against your Railway Postgres instance (server.js does this
-- automatically on boot).

CREATE TABLE IF NOT EXISTS users (
    id            TEXT PRIMARY KEY,
    business_name TEXT NOT NULL,
    email         TEXT NOT NULL UNIQUE,
    phone         TEXT,
    password_hash TEXT NOT NULL,
    role          TEXT NOT NULL DEFAULT 'sender' CHECK (role IN ('sender', 'admin', 'super_admin', 'vendor')),
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- CREATE TABLE IF NOT EXISTS above only applies to brand-new databases —
-- an already-existing `users` table (from before this update) won't
-- automatically gain the `phone` column, so this migrates it explicitly.
-- Existing senders will have phone = NULL until they add one; password
-- reset simply won't be available to them until then (see README).
ALTER TABLE users ADD COLUMN IF NOT EXISTS phone TEXT;

-- Vendor self-registration approval workflow. Existing/seeded accounts
-- (customers, Manage Agent, Super Admin, and the seeded Girlee Fashion
-- vendor) default to 'approved' so nothing already working is affected —
-- only a NEW self-registered vendor starts 'pending'. Documents stored
-- as base64 in Postgres, same pattern as product/logo images elsewhere
-- in this app, for the same reason (Railway wipes its filesystem on
-- redeploy, so a file path would silently break).
ALTER TABLE users ADD COLUMN IF NOT EXISTS approval_status TEXT NOT NULL DEFAULT 'approved'
    CHECK (approval_status IN ('pending', 'approved', 'rejected'));
ALTER TABLE users ADD COLUMN IF NOT EXISTS business_registration_doc TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS id_document_type TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS id_document_doc TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS applied_at TIMESTAMPTZ;
-- Set when a Super Admin rejects a vendor/delivery-company application
-- (required at that point — see the reject endpoints in server.js) so
-- the applicant knows why, not just that they were turned down.
-- Cleared automatically on a later approval (see
-- setVendorApprovalStatus/setDeliveryCompanyApprovalStatus in db.js),
-- so a fresh approval never carries a stale rejection explanation.
ALTER TABLE users ADD COLUMN IF NOT EXISTS rejection_reason TEXT;

-- Existing databases already have a `role` CHECK constraint that only
-- allows 'sender'/'admin' — CREATE TABLE IF NOT EXISTS above won't touch
-- it on an already-existing table, so this widens it explicitly to the
-- full current set of roles in one step (the Postgres-assigned default
-- name for an inline column CHECK constraint is `<table>_<column>_check`).
-- IMPORTANT: this must always list every role the app currently uses.
-- Narrowing this list on a live database with rows already using a role
-- being removed will crash on boot — Postgres validates ADD CONSTRAINT
-- against every existing row, not just new ones going forward.
ALTER TABLE users DROP CONSTRAINT IF EXISTS users_role_check;
ALTER TABLE users ADD CONSTRAINT users_role_check CHECK (role IN ('sender', 'admin', 'super_admin', 'vendor', 'delivery_company'));

-- Bumped whenever an admin uses "Logout All Devices" (Settings > Security).
-- Every JWT embeds the token_version that was current when it was issued;
-- requireAuth/socketAuth reject a token whose version doesn't match the
-- user's current value, which is what makes "logout everywhere" possible
-- without a full session-table rewrite of the stateless JWT auth this app
-- already uses.
ALTER TABLE users ADD COLUMN IF NOT EXISTS token_version INTEGER NOT NULL DEFAULT 0;

-- Single-row table: one business, one set of settings. Logo is stored as
-- a data URL (base64) directly in the row rather than a file path —
-- Railway's filesystem is wiped on every redeploy, so a path-based
-- upload would silently break; a small logo image living in Postgres
-- doesn't have that problem. Kept deliberately small (see server.js for
-- the upload size limit enforced on save).
CREATE TABLE IF NOT EXISTS settings (
    id                 TEXT PRIMARY KEY DEFAULT 'business',
    business_name      TEXT,
    business_email     TEXT,
    business_phone     TEXT,
    business_address   TEXT,
    business_description TEXT,
    logo_data_url      TEXT,
    opening_time       TEXT,
    closing_time       TEXT,
    open_days          TEXT[],
    currency           TEXT NOT NULL DEFAULT 'USD',
    timezone           TEXT NOT NULL DEFAULT 'Africa/Monrovia',
    updated_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Real, Super-Admin-editable Privacy Policy / Terms of Service text.
-- NULL until customized — the app falls back to sensible default
-- content until an admin actually edits and saves their own.
ALTER TABLE settings ADD COLUMN IF NOT EXISTS privacy_policy TEXT;
ALTER TABLE settings ADD COLUMN IF NOT EXISTS terms_of_service TEXT;

-- Real login history — logged on every successful login (sender or
-- admin). Device/browser are parsed from the request's User-Agent
-- header; there's no city/location field because that needs a paid
-- IP-geolocation service this app doesn't have — showing a fabricated
-- "Monrovia" for every row would be worse than not showing one.
CREATE TABLE IF NOT EXISTS login_history (
    id         TEXT PRIMARY KEY,
    user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    ip_address TEXT,
    device     TEXT,
    browser    TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_login_history_user_id ON login_history (user_id, created_at DESC);

-- Real per-device "Active Sessions" revocation. Each login_history row
-- IS the session — its id gets embedded in the JWT issued at that
-- login, and requireAuth checks revoked_at on every request. NULL
-- means still active; set means that one specific token now rejects
-- regardless of its expiry, without affecting any other device's
-- session (unlike "Logout All Devices", which bumps token_version and
-- invalidates everything at once).
ALTER TABLE login_history ADD COLUMN IF NOT EXISTS revoked_at TIMESTAMPTZ;

-- Password reset codes, sent via SMS/WhatsApp (server/notify.js) to the
-- phone number a sender registered with. Each code is single-use and
-- expires — old/used rows are harmless to keep around (no cleanup job
-- needed for the volumes this app deals with), but see README if you
-- want to prune them later.
CREATE TABLE IF NOT EXISTS password_resets (
    id         TEXT PRIMARY KEY,
    user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    code_hash  TEXT NOT NULL,
    expires_at TIMESTAMPTZ NOT NULL,
    used       BOOLEAN NOT NULL DEFAULT false,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_password_resets_user_id ON password_resets (user_id);

CREATE TABLE IF NOT EXISTS orders (
    id               TEXT PRIMARY KEY,
    sender_id        TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    sender_name      TEXT NOT NULL,
    pickup_address   TEXT NOT NULL,
    dropoff_address  TEXT NOT NULL,
    item_description TEXT NOT NULL,
    amount           NUMERIC(10, 2),
    status           TEXT NOT NULL DEFAULT 'pending',
    accepted_by      TEXT,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    accepted_at      TIMESTAMPTZ,
    picked_up_at     TIMESTAMPTZ,
    delivered_at     TIMESTAMPTZ
);

-- Real payment method, set when an order is accepted (not fabricated
-- display data). NULL until then, same pattern as `amount`.
ALTER TABLE orders ADD COLUMN IF NOT EXISTS payment_method TEXT;

-- True when an admin placed this order on a customer's behalf (phone/
-- walk-in order) rather than the customer placing it themselves.
ALTER TABLE orders ADD COLUMN IF NOT EXISTS placed_by_admin BOOLEAN NOT NULL DEFAULT false;

CREATE TABLE IF NOT EXISTS expenses (
    id          TEXT PRIMARY KEY,
    date        TIMESTAMPTZ NOT NULL,
    amount      NUMERIC(10, 2) NOT NULL,
    description TEXT NOT NULL,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Delivery agents (Fleet Directory). Separate from `users` on purpose —
-- agents aren't login accounts, just a managed contact/roster list that
-- admins can add to and edit. `accepted_by` on orders stores the agent's
-- NAME as free text (not a foreign key), so renaming an agent here won't
-- retroactively change historical order records — see README for the
-- tradeoff this implies.
CREATE TABLE IF NOT EXISTS agents (
    id         TEXT PRIMARY KEY,
    name       TEXT NOT NULL,
    phone      TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- "On Duty / Off Duty" — explicitly set by an admin in the Fleet
-- Directory, NOT automatic connection/GPS presence (agents don't have
-- logins or devices reporting to this app). Named "duty_status" rather
-- than reusing the word "online" to keep that distinction honest in the
-- data model itself, even though the UI may still show it as an
-- Online/Offline-style badge.
ALTER TABLE agents ADD COLUMN IF NOT EXISTS duty_status TEXT NOT NULL DEFAULT 'off_duty' CHECK (duty_status IN ('on_duty', 'off_duty'));

-- Multi-provider delivery: which company (a user with role =
-- 'delivery_company', OR the existing 'admin' account representing
-- Verta Delivery Service's own in-house fleet — see the backward-
-- compat migration in server.js) this agent belongs to, and which
-- company actually fulfilled a given order. Nullable — existing
-- agents get backfilled in server.js on boot (needs the real
-- ADMIN_EMAIL value, which can be overridden per-deployment via an
-- env var, so it can't be safely hardcoded in this static SQL file).
ALTER TABLE agents ADD COLUMN IF NOT EXISTS delivery_company_id TEXT REFERENCES users(id);
ALTER TABLE orders ADD COLUMN IF NOT EXISTS delivery_company_id TEXT REFERENCES users(id);

-- Pricing presets (Settings > Pricing) — named, reusable delivery price
-- points an admin defines once (e.g. "Standard - $2.50"), offered as
-- quick-select options when accepting an order. Not an automatic
-- distance/zone pricing engine — this app has no mapping/geocoding data
-- to base that on, so this is real, admin-defined reference pricing
-- rather than a calculator pretending to know actual distances.
CREATE TABLE IF NOT EXISTS price_presets (
    id         TEXT PRIMARY KEY,
    label      TEXT NOT NULL,
    amount     NUMERIC(10, 2) NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_orders_created_at ON orders (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_orders_sender_id ON orders (sender_id);
CREATE INDEX IF NOT EXISTS idx_expenses_date ON expenses (date DESC);
CREATE INDEX IF NOT EXISTS idx_users_email ON users (email);

-- ============================================================
-- Marketplace foundation (ONLib) — vendors sell products, customers
-- (existing sender accounts) buy them. This is the real data model
-- the marketplace needs; the UI on top of it is a first, functional
-- slice, not the full mockup (no promos/wishlist/messages/reviews yet).
--
-- Two decisions were defaulted rather than asked a third time (flagged
-- in README): checkout is pay-on-delivery (no payment gateway exists),
-- and a purchase automatically creates a real delivery order in the
-- existing `orders` table for fulfillment — matching "Shop & Delivery"
-- branding and letting this reuse the whole existing agent/delivery
-- pipeline instead of building a second one.
-- ============================================================

CREATE TABLE IF NOT EXISTS products (
    id            TEXT PRIMARY KEY,
    vendor_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name          TEXT NOT NULL,
    description   TEXT,
    price         NUMERIC(10, 2) NOT NULL,
    category      TEXT,
    image_data_url TEXT, -- same pattern as the business logo: stored in
                          -- Postgres directly, not a file path, since
                          -- Railway's filesystem is wiped on redeploy
    stock_quantity INTEGER NOT NULL DEFAULT 0,
    is_active     BOOLEAN NOT NULL DEFAULT true,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Additional product photos, beyond the one primary photo stored on
-- products.image_data_url — lets the PDP show a real multi-image
-- gallery instead of being capped at a single picture. position
-- controls display order (lower shows first, after the primary image).
CREATE TABLE IF NOT EXISTS product_images (
    id            TEXT PRIMARY KEY,
    product_id    TEXT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
    image_data_url TEXT NOT NULL,
    position      INTEGER NOT NULL DEFAULT 0,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_product_images_product_id ON product_images (product_id);
CREATE INDEX IF NOT EXISTS idx_products_vendor_id ON products (vendor_id);

-- Storefront home-screen hero carousel. Super Admin manages up to 3
-- slides here; the storefront falls back to a single hardcoded
-- "Discover Amazing Products" slide when this table is empty (fresh
-- installs, or every slide temporarily removed), so the home screen is
-- never left with an empty banner area.
CREATE TABLE IF NOT EXISTS home_banners (
    id            TEXT PRIMARY KEY,
    position      INTEGER NOT NULL DEFAULT 0,
    eyebrow       TEXT,
    headline      TEXT NOT NULL,
    subtext       TEXT,
    cta_text      TEXT NOT NULL DEFAULT 'Shop Now',
    cta_link      TEXT,
    image_data_url TEXT,
    is_active     BOOLEAN NOT NULL DEFAULT true,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_home_banners_position ON home_banners (position);

-- A purchase is a shopping-cart checkout — one customer, one vendor
-- (carts don't mix vendors, so multi-vendor carts split into separate
-- purchases at checkout), optionally linked to the delivery order
-- created to fulfill it.
CREATE TABLE IF NOT EXISTS purchases (
    id              TEXT PRIMARY KEY,
    customer_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    vendor_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    total_amount    NUMERIC(10, 2) NOT NULL,
    delivery_order_id TEXT REFERENCES orders(id) ON DELETE SET NULL,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_purchases_vendor_id ON purchases (vendor_id);
CREATE INDEX IF NOT EXISTS idx_purchases_customer_id ON purchases (customer_id);

-- Marketplace checkout payment tracking. Not to be confused with
-- orders.payment_method above (added earlier) — that one records how a
-- delivery agent collected payment in person when accepting/completing
-- an ordinary delivery order; this one tracks online payment for a
-- marketplace purchase itself, before any delivery even happens.
-- 'cod' (pay on delivery, the original/default behavior — payment_status
-- stays 'not_applicable' since nothing digital is tracked for it) or
-- 'momo' (MTN Mobile Money — payment_status starts 'pending' at
-- checkout and is flipped to 'successful' or 'failed' once MTN
-- confirms; see db.checkout()/voidFailedPayment() and server.js's
-- /api/marketplace/checkout/momo routes).
ALTER TABLE purchases ADD COLUMN IF NOT EXISTS payment_method TEXT NOT NULL DEFAULT 'cod';
ALTER TABLE purchases ADD COLUMN IF NOT EXISTS payment_status TEXT NOT NULL DEFAULT 'not_applicable';
ALTER TABLE purchases ADD COLUMN IF NOT EXISTS momo_reference_id TEXT;
ALTER TABLE purchases ADD COLUMN IF NOT EXISTS momo_phone TEXT;
-- Held here only while a Mobile Money payment is pending — the real
-- delivery order (and its own pickup_address/dropoff_address columns
-- on `orders`) isn't created until payment succeeds, so it never shows
-- up in the live delivery queue for an order nobody has actually paid
-- for yet. Cleared back to NULL once the real order is created.
ALTER TABLE purchases ADD COLUMN IF NOT EXISTS pending_pickup_address TEXT;
ALTER TABLE purchases ADD COLUMN IF NOT EXISTS pending_dropoff_address TEXT;

CREATE TABLE IF NOT EXISTS purchase_items (
    id            TEXT PRIMARY KEY,
    purchase_id   TEXT NOT NULL REFERENCES purchases(id) ON DELETE CASCADE,
    product_id    TEXT REFERENCES products(id) ON DELETE SET NULL,
    product_name  TEXT NOT NULL, -- snapshot at time of purchase, survives product edits/deletion
    unit_price    NUMERIC(10, 2) NOT NULL,
    quantity      INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_purchase_items_purchase_id ON purchase_items (purchase_id);

-- Real product ratings (mobile mockup shows star ratings on every
-- product card — this makes them genuine rather than fabricated
-- numbers). A customer can only review a product they actually bought
-- (checked in server.js), one review per product per customer.
CREATE TABLE IF NOT EXISTS product_reviews (
    id          TEXT PRIMARY KEY,
    product_id  TEXT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
    customer_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    rating      INTEGER NOT NULL CHECK (rating BETWEEN 1 AND 5),
    comment     TEXT,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (product_id, customer_id)
);
CREATE INDEX IF NOT EXISTS idx_product_reviews_product_id ON product_reviews (product_id);

-- Real wishlist — one row per (customer, product) they've saved.
CREATE TABLE IF NOT EXISTS wishlist_items (
    id          TEXT PRIMARY KEY,
    customer_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    product_id  TEXT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (customer_id, product_id)
);
CREATE INDEX IF NOT EXISTS idx_wishlist_items_customer_id ON wishlist_items (customer_id);

-- Real saved addresses — customers can keep a few labeled delivery
-- addresses (e.g. "Home", "Office") instead of typing one at checkout
-- every time. Only one can be the default per customer, enforced in
-- application logic (unset the others, then set the new one) rather
-- than a DB constraint, since "exactly one default, or none" is easier
-- to express that way than as a partial unique index.
CREATE TABLE IF NOT EXISTS saved_addresses (
    id          TEXT PRIMARY KEY,
    customer_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    label       TEXT NOT NULL,
    address     TEXT NOT NULL,
    is_default  BOOLEAN NOT NULL DEFAULT false,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_saved_addresses_customer_id ON saved_addresses (customer_id);

-- Real in-app messaging between a customer and a vendor. One
-- conversation per (customer, vendor) pair — reused for every future
-- exchange between the same two people rather than starting a new
-- thread each time.
CREATE TABLE IF NOT EXISTS conversations (
    id          TEXT PRIMARY KEY,
    customer_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    vendor_id   TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (customer_id, vendor_id)
);
CREATE INDEX IF NOT EXISTS idx_conversations_customer_id ON conversations (customer_id);
CREATE INDEX IF NOT EXISTS idx_conversations_vendor_id ON conversations (vendor_id);

CREATE TABLE IF NOT EXISTS messages (
    id              TEXT PRIMARY KEY,
    conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    sender_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    body            TEXT NOT NULL,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    read_at         TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_messages_conversation_id ON messages (conversation_id, created_at);

-- Real vendor promotions — a percentage discount on one of the
-- vendor's own products, active for a real date range. Capped at 90%
-- as a sanity guard rail (not a business rule, just a safeguard
-- against an obvious data-entry mistake like typing 100 by accident).
-- "Deals" (customer-facing) is just the set of products with a
-- currently-active row here — same data, two views.
CREATE TABLE IF NOT EXISTS promotions (
    id               TEXT PRIMARY KEY,
    vendor_id        TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    product_id       TEXT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
    discount_percent NUMERIC(5,2) NOT NULL CHECK (discount_percent > 0 AND discount_percent <= 90),
    starts_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    ends_at          TIMESTAMPTZ NOT NULL,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_promotions_product_id ON promotions (product_id);
CREATE INDEX IF NOT EXISTS idx_promotions_vendor_id ON promotions (vendor_id);

-- Real high-intent buyer interaction tracking for vendors. buyer_id is
-- nullable — a guest can trigger PHONE_CLICK (viewing a vendor's
-- contact info doesn't require an account); every other type here
-- currently requires login, so those always have a buyer_id.
CREATE TABLE IF NOT EXISTS leads (
    id         TEXT PRIMARY KEY,
    vendor_id  TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    buyer_id   TEXT REFERENCES users(id) ON DELETE SET NULL,
    product_id TEXT REFERENCES products(id) ON DELETE SET NULL,
    type       TEXT NOT NULL CHECK (type IN ('PHONE_CLICK', 'MESSAGE_SENT', 'QUOTE_REQUEST', 'CHECKOUT_STARTED')),
    status     TEXT NOT NULL DEFAULT 'NEW' CHECK (status IN ('NEW', 'CONTACTED', 'CONVERTED', 'ARCHIVED')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_leads_vendor_id ON leads (vendor_id, created_at DESC);

-- Vendor's physical store address, optional — powers a real "Get
-- Directions" feature (a plain Google Maps search-query link, no API
-- key needed). NULL until a vendor fills it in via Settings. Kept —
-- this is real, separate infrastructure from leads above, not a
-- duplicate of it.
ALTER TABLE users ADD COLUMN IF NOT EXISTS store_address TEXT;

-- Real profile photo, any role — stored as a data URL like the
-- business logo already is (see MAX_PROFILE_IMAGE_BYTES in server.js
-- for the size cap enforced on upload).
ALTER TABLE users ADD COLUMN IF NOT EXISTS profile_image_url TEXT;

-- Real account suspension, any role — separate concept from
-- approval_status (a rejected vendor never got approved; a disabled
-- account was working fine and is now being suspended). Login is
-- blocked while true; disabling also bumps token_version so any
-- already-logged-in session is invalidated immediately, not just new
-- login attempts.
ALTER TABLE users ADD COLUMN IF NOT EXISTS is_disabled BOOLEAN NOT NULL DEFAULT false;

-- Granular per-feature permission control — Super Admin cutting off
-- specific capabilities for a Manage Agent account, separate from
-- disabling the whole account above. Deliberately excludes personal
-- account security actions (change own password/email, view own
-- login history) — those stay controllable by the account holder no
-- matter what, since stripping them away could otherwise be used to
-- prevent someone from securing their own account. Values are feature
-- keys like 'fleet', 'expenses', 'business_settings', etc. — see the
-- FEATURE_KEYS list in server.js for the authoritative set.
ALTER TABLE users ADD COLUMN IF NOT EXISTS disabled_features TEXT[] NOT NULL DEFAULT '{}';

-- Real "follow a store" — same pattern as wishlist_items, just for
-- stores instead of products.
CREATE TABLE IF NOT EXISTS store_follows (
    id          TEXT PRIMARY KEY,
    customer_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    vendor_id   TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (customer_id, vendor_id)
);
CREATE INDEX IF NOT EXISTS idx_store_follows_customer_id ON store_follows (customer_id);
CREATE INDEX IF NOT EXISTS idx_store_follows_vendor_id ON store_follows (vendor_id);

-- ============================================================
-- Commission & payout tracking (Super Admin) — real, calculated from
-- actual purchase/order data, not fabricated display numbers. Two
-- concepts, deliberately kept separate:
--   - a commission RATE (percent): how much of a vendor's or delivery
--     company's revenue the platform keeps. Configurable globally,
--     with an optional per-account override.
--   - a payout: a real, recorded event of the platform actually
--     paying a vendor/delivery company their net share for a given
--     period. Recording one is how Super Admin marks money as paid;
--     nothing here moves real money — this is a ledger, same spirit
--     as expenses/price_presets elsewhere in this file.
-- ============================================================

-- Single-row table, same pattern as `settings` above.
CREATE TABLE IF NOT EXISTS platform_settings (
    id                              TEXT PRIMARY KEY DEFAULT 'platform',
    marketplace_commission_percent  NUMERIC(5,2) NOT NULL DEFAULT 10,
    delivery_commission_percent     NUMERIC(5,2) NOT NULL DEFAULT 15,
    updated_at                      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Optional per-account override — NULL means "use the platform
-- default above". Only meaningful for role = 'vendor' (marketplace)
-- or role = 'delivery_company' (delivery) accounts.
ALTER TABLE users ADD COLUMN IF NOT EXISTS commission_rate_override NUMERIC(5,2);

-- A real, recorded payout event. gross/commission/net are snapshotted
-- at the time it's recorded (not recalculated later), so a later
-- platform commission-rate change never silently rewrites a payout
-- that's already gone out in real life.
CREATE TABLE IF NOT EXISTS payouts (
    id                TEXT PRIMARY KEY,
    recipient_type    TEXT NOT NULL CHECK (recipient_type IN ('vendor', 'delivery_company')),
    recipient_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    period_start      TIMESTAMPTZ NOT NULL,
    period_end        TIMESTAMPTZ NOT NULL,
    gross_amount      NUMERIC(10, 2) NOT NULL,
    commission_rate   NUMERIC(5, 2) NOT NULL,
    commission_amount NUMERIC(10, 2) NOT NULL,
    net_amount        NUMERIC(10, 2) NOT NULL,
    notes             TEXT,
    created_by        TEXT REFERENCES users(id) ON DELETE SET NULL,
    created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_payouts_recipient_id ON payouts (recipient_id, created_at DESC);

-- ============================================================
-- Audit log — a real, append-only record of sensitive Super Admin
-- actions (approvals, disables, permission/commission changes,
-- payouts, account edits). The app never updates or deletes rows
-- here — that's the whole point of an audit trail.
-- ============================================================
CREATE TABLE IF NOT EXISTS audit_log (
    id           TEXT PRIMARY KEY,
    actor_id     TEXT REFERENCES users(id) ON DELETE SET NULL,
    actor_name   TEXT NOT NULL,
    actor_role   TEXT NOT NULL,
    action       TEXT NOT NULL,
    target_type  TEXT,
    target_id    TEXT,
    target_label TEXT,
    details      JSONB NOT NULL DEFAULT '{}',
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_audit_log_created_at ON audit_log (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_log_actor_id ON audit_log (actor_id, created_at DESC);

-- ============================================================
-- Platform-wide settings — extends the single-row platform_settings
-- table above (commission rates) with the remaining "there's nowhere
-- to set this" gaps: a default delivery fee (a suggested starting
-- amount, not enforced — admins can still enter any amount when
-- accepting an order), a free-text description of the service area
-- shown to guests/customers, and a real maintenance-mode switch.
-- maintenance_mode is enforced server-side (blocks new order/purchase
-- creation for everyone except super_admin — see server.js) and is
-- exposed publicly via GET /api/config, unauthenticated, same as
-- privacyPolicy/termsOfService already are, so guests see the
-- maintenance banner before ever logging in.
-- ============================================================
ALTER TABLE platform_settings ADD COLUMN IF NOT EXISTS default_delivery_fee NUMERIC(10, 2);
ALTER TABLE platform_settings ADD COLUMN IF NOT EXISTS service_area TEXT;
ALTER TABLE platform_settings ADD COLUMN IF NOT EXISTS maintenance_mode BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE platform_settings ADD COLUMN IF NOT EXISTS maintenance_message TEXT;

-- ============================================================
-- Disputes — the last of the original Super Admin gaps: a real,
-- structured way for a customer to report a problem with an order and
-- for a Super Admin to resolve it, optionally with a refund.
--
-- Deliberately references EITHER a delivery order OR a marketplace
-- purchase, not always both, since either can be disputed on its own
-- (a plain sender-to-recipient delivery has no purchase at all) — the
-- CHECK constraint below just requires at least one to be set. Which
-- one is set also decides who a refund is attributed to: a
-- purchase-linked dispute nets against that purchase's vendor (see
-- getPayoutSummary in db.js), an order-only dispute nets against that
-- order's delivery company. A marketplace order that also has its own
-- linked delivery order (purchases.delivery_order_id) can only be
-- disputed via the purchase — resolving it doesn't separately dock the
-- delivery company, since the complaint in that flow is about the
-- vendor's product/fulfillment, not the delivery itself.
--
-- No update/delete on open disputes here beyond the one resolve step
-- (open -> resolved | rejected) — same "small, real, honest" shape as
-- the rejection-reason and payout features: a required explanation is
-- always shown back to the person it affects, and refund_amount is
-- only ever set alongside status = 'resolved'.
-- ============================================================
CREATE TABLE IF NOT EXISTS disputes (
    id              TEXT PRIMARY KEY,
    order_id        TEXT REFERENCES orders(id) ON DELETE SET NULL,
    purchase_id     TEXT REFERENCES purchases(id) ON DELETE SET NULL,
    customer_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    category        TEXT NOT NULL DEFAULT 'other' CHECK (category IN ('wrong_item', 'damaged', 'never_arrived', 'overcharged', 'other')),
    description     TEXT NOT NULL,
    status          TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'resolved', 'rejected')),
    resolution_note TEXT,
    refund_amount   NUMERIC(10, 2),
    resolved_by     TEXT REFERENCES users(id) ON DELETE SET NULL,
    resolved_at     TIMESTAMPTZ,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    CHECK (order_id IS NOT NULL OR purchase_id IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS idx_disputes_customer_id ON disputes (customer_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_disputes_status ON disputes (status, created_at DESC);
