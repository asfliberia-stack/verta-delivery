# Verta Delivery Service — Realtime, multi-user, Railway-ready

Firebase is gone. The app now has real accounts:

- **Senders** register/log in and see only their own orders, synced live
  across every browser/tab/device they're logged into.
- **Admins** log in with a single shared password and see *every* sender's
  orders in one dashboard — accept, track status, delete, manage expenses.

Realtime sync runs through one Node.js service: **Express + Socket.io +
PostgreSQL**, deployable to Railway or runnable locally (including inside
TRAE IDE).

## Architecture

```
Sender's browser tabs ──┐
(their own devices)     ├─ wss:// (Socket.io, room "user:<id>") ─┐
                         │                                        │
Admin's browser tabs ────┴─ wss:// (Socket.io, room "admins") ────┼──► Railway service ──► Postgres
(sees every sender)                                                │    (Express serves        (users, orders,
                                                    HTTP /api/*  ───┘     the static frontend      expenses)
                                                (login/register,          on the same port)
                                                 one-time state load)
```

- **One Railway service** runs `server/server.js` — it serves the static
  frontend (`public/index.html`) *and* runs Socket.io, on the same port
  (Railway only exposes one public port per service).
- **One Railway Postgres plugin**, attached to that service. Railway
  injects `DATABASE_URL` automatically.
- **Auth is JWT-based.** On login/register the server returns a signed
  token; the frontend stores it (`localStorage`) and sends it as
  `Authorization: Bearer <token>` on REST calls and as
  `socket.handshake.auth.token` when opening the realtime connection.
  Every Socket.io connection is authenticated — there's no anonymous access.
- **Room strategy:**
  - Each sender's sockets join `user:<their id>` — so a sender's own
    devices sync with each other, and only ever receive their own orders.
  - Every admin socket joins `admins` — admins see every order from every
    sender, live, and their own multiple admin sessions sync too.
  - Every order event is emitted to *both* the owning sender's room and
    `admins`, so both sides get a live update from a single action.

## Logging in

- **Senders**: register with a business name, email, and password (public
  self-registration). Only `role = 'sender'` accounts can be created this
  way.
- **Admin**: one shared password, same as the original app —
  **`1Nigeria@`** by default. No email needed on the login form; the
  server checks it against a seeded admin account automatically created
  on first boot. Change it by setting `ADMIN_PASSWORD` (and optionally
  `ADMIN_EMAIL`) in your environment before first boot — see
  `server/.env.example`.

## Deploying to Railway

1. Push this project to a GitHub repo.
2. Railway: **New Project → Deploy from GitHub repo**.
3. **Add a Postgres plugin** (`New → Database → PostgreSQL`) — Railway
   wires `DATABASE_URL` into your service automatically.
4. On your service, open **Variables** and set:
   - `JWT_SECRET` — required, any long random string
     (`node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"`)
   - `ADMIN_PASSWORD` — optional, defaults to `1Nigeria@` if unset
   - `ADMIN_EMAIL` — optional, defaults to `admin@vertadelivery.com`
   - (`PORT` / `DATABASE_URL` are set automatically by Railway)
5. Deploy. On boot, `server.js` runs `schema.sql` to create tables if
   needed, then seeds the admin account if it doesn't exist yet.
6. Open the Railway-provided URL.

## Running locally / in TRAE IDE

This is a plain Node.js project — TRAE (or VS Code, or any terminal) can
run it with no special config:

```bash
# from the project root
npm install          # installs server/ dependencies via postinstall
cd server
cp .env.example .env
# edit server/.env — at minimum set JWT_SECRET and DATABASE_URL
cd ..
npm start            # runs the server from the project root
```

Then open `http://localhost:3000`.

**In TRAE IDE specifically:**
1. Open this project folder in TRAE.
2. Open its integrated terminal.
3. Run `npm install`, then set up `server/.env` (copy from
   `server/.env.example` and fill in `JWT_SECRET` + `DATABASE_URL`).
4. Run `npm start` (or `npm run dev` for auto-restart on file changes via
   Node's built-in `--watch`).
5. Open `http://localhost:3000` in a browser preview or your normal
   browser — TRAE doesn't need anything beyond a working `npm start`.

You'll need a Postgres database to point `DATABASE_URL` at. Easiest
options for local/TRAE dev:
- Run Postgres locally (`postgres.app`, Docker: `docker run -p 5432:5432 -e POSTGRES_PASSWORD=postgres postgres`), or
- Create a Railway Postgres plugin and copy its **public** connection
  string from Railway's dashboard into your local `.env` — you don't have
  to run the app on Railway to use its database.

## What changed from the shared-login version

- Added a `users` table (`business_name`, `email`, `password_hash`,
  `role`). `orders` now has `sender_id` referencing it.
- Removed the old shared "Delivery Agent Login" password modal — replaced
  with real sender registration/login and a password-only admin login
  (kept as **one shared password**, `1Nigeria@` by default, per your
  request — matching the original app's UX, but now checked server-side
  against a real hashed account instead of a string in client JS).
- `GET /api/state` is now role-scoped: senders get only their own orders;
  admins get everything (orders + expenses).
- Socket.io connections require a valid JWT (`io({ auth: { token } })`);
  unauthenticated sockets are rejected.
- New REST endpoints: `POST /api/auth/register`, `POST /api/auth/login`,
  `POST /api/auth/admin-login`, `GET /api/me`.
- `order:create` is sender-only (senderId/senderName taken from the
  authenticated user, never trusted from the client). `order:update`,
  `order:accept`, `order:delete-bulk`, `expense:create`, `expense:delete`
  are admin-only — enforced server-side in the Socket.io handlers, not
  just hidden in the UI.
- Added root-level `package.json` so `npm install && npm start` works
  from the project root in any IDE/terminal, TRAE included.

## Security notes

- Passwords are hashed with bcrypt (`bcryptjs`), never stored or logged
  in plaintext.
- `JWT_SECRET` must be set — the server refuses to boot without it rather
  than silently signing tokens with a guessable default.
- The admin password is intentionally a single shared secret (matching
  your original app's design), not a per-admin account system. If you
  later want individually attributable admin logins, that's a small
  extension of the existing `users.role = 'admin'` model — just remove
  the `/api/auth/admin-login` shortcut and have admins register/log in
  like senders, with `role` set manually in the database.

## Setting up WhatsApp/SMS notifications (new order alerts)

Every time a sender places a new order, the server can now fire off an
instant WhatsApp or SMS message to **+231881405696**. It's implemented in
`server/notify.js` using Twilio's REST API directly (no extra npm
dependency — just Node 18's built-in `fetch`).

**Where to add your API keys:** `server/.env` (local) or your Railway
service's **Variables** tab (production). Add these four:

| Variable | What it is |
|---|---|
| `TWILIO_ACCOUNT_SID` | From your Twilio Console dashboard homepage |
| `TWILIO_AUTH_TOKEN` | Same page, right below the Account SID |
| `TWILIO_FROM_NUMBER` | The Twilio number (or WhatsApp sandbox number) you're sending *from* |
| `NOTIFY_TO_NUMBER` | Already defaults to `+231881405696` — only set this if you want a different number |
| `NOTIFY_CHANNEL` | `whatsapp` (default) or `sms` |

**Nothing breaks if you skip this.** With no Twilio credentials set, the
app just logs `[notify] Twilio credentials not set...` once at boot and
silently skips sending — order creation, sync, everything else works
exactly the same either way.

### Step-by-step: getting it working

1. **Create a Twilio account** at [twilio.com/try-twilio](https://www.twilio.com/try-twilio)
   (free trial credit is enough to test this).
2. On your Twilio Console dashboard, copy your **Account SID** and
   **Auth Token** into `TWILIO_ACCOUNT_SID` / `TWILIO_AUTH_TOKEN`.
3. **For WhatsApp (recommended first — works immediately, no approval wait):**
   - Go to **Messaging → Try it out → Send a WhatsApp message** in the
     Twilio Console. Twilio gives you a sandbox number (something like
     `+1 415 523 8886`) and a join code (like `join happy-tiger`).
   - Set `TWILIO_FROM_NUMBER=whatsapp:+14155238886` (use Twilio's actual
     sandbox number, keep the `whatsapp:` prefix).
   - From the WhatsApp number that should *receive* alerts
     (+231881405696), send that join code as a WhatsApp message to the
     Twilio sandbox number. This links your number to the sandbox — a
     one-time step, required by WhatsApp/Meta, not optional.
   - Leave `NOTIFY_CHANNEL=whatsapp`.
4. **For plain SMS instead (simpler, no linking step, costs a bit per
   message, works everywhere immediately):**
   - Buy/use a Twilio phone number under **Phone Numbers** in the console.
   - Set `TWILIO_FROM_NUMBER` to that number in E.164 format, e.g.
     `+15551234567` (no `whatsapp:` prefix).
   - Set `NOTIFY_CHANNEL=sms`.
5. Restart the server (or redeploy on Railway). Place a test order as a
   sender — you should get the message within a few seconds.
6. **Going to production on WhatsApp:** the sandbox is fine for testing
   but is rate-limited and requires that one-time join step per number.
   For a permanent setup, apply for a WhatsApp Business sender through
   Twilio's console (**Messaging → Senders → WhatsApp senders**) — this
   removes the sandbox join-code requirement. This takes Meta a few days
   to approve; SMS has no equivalent approval step.

### What triggers a notification

Right now, exactly one event: **a sender creates a new order**
(`order:create` in `server/server.js`, wired to `notifyNewOrder()` in
`server/notify.js`). The message includes the order ID, sender's business
name, pickup/dropoff addresses, and item description. If you also want a
notification when an order is *accepted* or *delivered*, that's a small
addition to the `order:update` / `order:accept` handlers in
`server/server.js` — say the word and I'll wire that in too.

## Monthly Report PDF

Alongside the existing daily report button, the admin dashboard now has a
**🗓️ Monthly Report** button in the header. It opens a small dialog to
pick a year and month, then generates a PDF (`generateMonthlyReportPDF` in
`public/index.html`) containing:

- Monthly totals (orders, delivered count, order amount, expenses, net)
- An agent summary aggregated across the whole month
- A day-by-day itemized breakdown of every order and expense in that
  month, reusing the same date-filtering/grouping logic as the existing
  Order History view — so the numbers always match what you see on screen.

It's entirely additive: the original daily report button and its PDF
format are untouched.

## Restored: delete password ("SKY")

Deleting a placed order (bulk delete) or a recorded expense now requires
entering a password — defaults to **`SKY`**, overridable via
`DELETE_PASSWORD` in `server/.env` / Railway Variables. This is enforced
**server-side** in the Socket.io handlers (`order:delete-bulk`,
`expense:delete` in `server/server.js`), not just hidden behind a UI
prompt — so it can't be bypassed by calling the socket event directly.
An empty or incorrect password blocks the deletion and shows an error in
the same modal, letting you retry.
