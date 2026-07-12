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
