-- Verta Delivery Service - PostgreSQL schema (Railway)
-- Run once against your Railway Postgres instance (server.js does this
-- automatically on boot).

CREATE TABLE IF NOT EXISTS users (
    id            TEXT PRIMARY KEY,
    business_name TEXT NOT NULL,
    email         TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    role          TEXT NOT NULL DEFAULT 'sender' CHECK (role IN ('sender', 'admin')),
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

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

CREATE INDEX IF NOT EXISTS idx_orders_created_at ON orders (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_orders_sender_id ON orders (sender_id);
CREATE INDEX IF NOT EXISTS idx_expenses_date ON expenses (date DESC);
CREATE INDEX IF NOT EXISTS idx_users_email ON users (email);
