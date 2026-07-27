-- Verta Delivery Service - PostgreSQL schema (Railway)
-- Run once against your Railway Postgres instance (server.js does this
-- automatically on boot).

CREATE TABLE IF NOT EXISTS users (
    id            TEXT PRIMARY KEY,
    business_name TEXT NOT NULL,
    email         TEXT NOT NULL UNIQUE,
    phone         TEXT,
    password_hash TEXT NOT NULL,
    role          TEXT NOT NULL DEFAULT 'sender' CHECK (role IN ('sender', 'admin')),
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- CREATE TABLE IF NOT EXISTS above only applies to brand-new databases —
-- an already-existing `users` table (from before this update) won't
-- automatically gain the `phone` column, so this migrates it explicitly.
-- Existing senders will have phone = NULL until they add one; password
-- reset simply won't be available to them until then (see README).
ALTER TABLE users ADD COLUMN IF NOT EXISTS phone TEXT;

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
