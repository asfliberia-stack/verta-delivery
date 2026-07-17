// server.js — Express + Socket.io backend for Railway.
// Single container: serves the static frontend AND the realtime API.
require('dotenv').config();
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const rateLimit = require('express-rate-limit');
const http = require('http');
const cors = require('cors');
const { Server } = require('socket.io');
const db = require('./db');
const { notifyNewOrder, sendMessage } = require('./notify');
const {
  hashPassword,
  comparePassword,
  signToken,
  requireAuth,
  requireAdmin,
  socketAuth,
} = require('./auth');

const PORT = process.env.PORT || 3000;

// The admin side keeps a single shared password (as in the original app),
// rather than per-admin email+password — set ADMIN_PASSWORD in Railway's
// Variables tab to change it. Defaults to "1Nigeria@" so the app works
// out of the box without any env config.
const DEFAULT_ADMIN_EMAIL = 'admin@vertadelivery.com';
const ADMIN_EMAIL = process.env.ADMIN_EMAIL || DEFAULT_ADMIN_EMAIL;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '1Nigeria@';

// Extra confirmation step for destructive actions (bulk order delete,
// expense delete) — required on top of already being logged in as admin.
// Matches the original app's behavior. Set DELETE_PASSWORD to override.
const DELETE_PASSWORD = process.env.DELETE_PASSWORD || 'SKY';

const app = express();

// Railway (and most hosts) put the app behind a reverse proxy — without
// this, express-rate-limit below would see every request as coming from
// the same proxy IP and either rate-limit all users together or refuse
// to start in strict mode. `1` trusts exactly one hop (Railway's edge).
app.set('trust proxy', 1);

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, '..', 'public')));

// Brute-force protection on the three password-checking endpoints
// (sender login, sender registration, admin login). Generous enough
// for a real person mistyping a password a few times, tight enough to
// blunt scripted guessing — each IP gets 10 attempts per 15 minutes
// across these endpoints combined.
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many attempts. Please wait a few minutes and try again.' },
});

const server = http.createServer(app);

// Socket.io on the same HTTP server/port — Railway only exposes one port
// per service, so frontend and websocket traffic share it. The frontend
// connects with `io({ auth: { token } })` (no URL) which resolves to
// same-origin automatically.
const io = new Server(server, {
  cors: { origin: '*' }, // tighten to your real domain once you have one
});

io.use(socketAuth); // every socket connection must present a valid JWT

// Room strategy:
//   - Each sender's sockets join `user:<their id>` — so a sender's own
//     browsers/devices sync with each other, and only see their own orders.
//   - Every admin socket joins `admins` — admins see every order from every
//     sender, live, across all their own devices too.
// An order event is therefore always emitted to two rooms: the owning
// sender's room, and `admins`.
function orderRooms(senderId) {
  return [`user:${senderId}`, 'admins'];
}

io.on('connection', (socket) => {
  const room = socket.user.role === 'admin' ? 'admins' : `user:${socket.user.id}`;
  socket.join(room);
  console.log(`[socket] ${socket.user.role} connected: ${socket.user.email} (${socket.id})`);

  socket.on('disconnect', () => {
    console.log(`[socket] disconnected: ${socket.user.email} (${socket.id})`);
  });

  // ---- Orders (create = sender only; everything else = admin only) ----

  socket.on('order:create', async (payload, ack) => {
    if (socket.user.role !== 'sender') {
      return ack && ack({ ok: false, error: 'Only senders can create orders' });
    }
    try {
      const order = await db.createOrder({
        id: `ORD-${Date.now().toString(36).toUpperCase()}`,
        senderId: socket.user.id,
        senderName: socket.user.businessName,
        pickupAddress: payload.pickupAddress,
        dropoffAddress: payload.dropoffAddress,
        itemDescription: payload.itemDescription,
        amount: null,
        status: 'pending',
      });
      orderRooms(order.senderId).forEach((r) => io.to(r).emit('order:created', order));
      ack && ack({ ok: true, order });
      notifyNewOrder(order); // fire-and-forget — never blocks the order response
    } catch (err) {
      console.error('order:create failed', err);
      ack && ack({ ok: false, error: 'Failed to create order' });
    }
  });

  socket.on('order:cancel', async ({ id }, ack) => {
    if (socket.user.role !== 'sender') {
      return ack && ack({ ok: false, error: 'Only the sender who placed an order can cancel it' });
    }
    try {
      const existing = await db.getOrder(id);
      if (!existing) return ack && ack({ ok: false, error: 'Order not found' });
      if (existing.senderId !== socket.user.id) {
        return ack && ack({ ok: false, error: 'You can only cancel your own orders' });
      }
      if (existing.status !== 'pending') {
        return ack && ack({ ok: false, error: 'Only pending orders (not yet accepted by an agent) can be cancelled' });
      }
      const order = await db.updateOrder(id, { status: 'cancelled' });
      orderRooms(order.senderId).forEach((r) => io.to(r).emit('order:updated', order));
      ack && ack({ ok: true, order });
    } catch (err) {
      console.error('order:cancel failed', err);
      ack && ack({ ok: false, error: 'Failed to cancel order' });
    }
  });

  socket.on('order:update', async ({ id, fields }, ack) => {
    if (socket.user.role !== 'admin') {
      return ack && ack({ ok: false, error: 'Only admins can update orders' });
    }
    try {
      const order = await db.updateOrder(id, fields);
      orderRooms(order.senderId).forEach((r) => io.to(r).emit('order:updated', order));
      ack && ack({ ok: true, order });
    } catch (err) {
      console.error('order:update failed', err);
      ack && ack({ ok: false, error: 'Failed to update order' });
    }
  });

  socket.on('order:accept', async ({ id, amount, acceptedBy }, ack) => {
    if (socket.user.role !== 'admin') {
      return ack && ack({ ok: false, error: 'Only admins can accept orders' });
    }
    try {
      const order = await db.updateOrder(id, {
        amount,
        acceptedBy,
        status: 'accepted',
        acceptedAt: new Date().toISOString(),
      });
      orderRooms(order.senderId).forEach((r) => io.to(r).emit('order:updated', order));
      ack && ack({ ok: true, order });
    } catch (err) {
      console.error('order:accept failed', err);
      ack && ack({ ok: false, error: 'Failed to accept order' });
    }
  });

  socket.on('order:delete-bulk', async ({ ids, password }, ack) => {
    if (socket.user.role !== 'admin') {
      return ack && ack({ ok: false, error: 'Only admins can delete orders' });
    }
    if (!password || password !== DELETE_PASSWORD) {
      return ack && ack({ ok: false, error: 'Incorrect delete password' });
    }
    try {
      // Look up owning senders before deleting so we know which rooms to notify.
      const affected = (await Promise.all(ids.map((id) => db.getOrder(id)))).filter(Boolean);
      await db.deleteOrders(ids);
      const senderIds = [...new Set(affected.map((o) => o.senderId))];
      senderIds.forEach((sid) => io.to(`user:${sid}`).emit('order:deleted', { ids }));
      io.to('admins').emit('order:deleted', { ids });
      ack && ack({ ok: true });
    } catch (err) {
      console.error('order:delete-bulk failed', err);
      ack && ack({ ok: false, error: 'Failed to delete orders' });
    }
  });

  // ---- Expenses (admin only, not tied to a sender) ----

  socket.on('expense:create', async (payload, ack) => {
    if (socket.user.role !== 'admin') {
      return ack && ack({ ok: false, error: 'Only admins can add expenses' });
    }
    try {
      const expense = await db.createExpense({ ...payload, id: `expense-${Date.now()}` });
      io.to('admins').emit('expense:created', expense);
      ack && ack({ ok: true, expense });
    } catch (err) {
      console.error('expense:create failed', err);
      ack && ack({ ok: false, error: 'Failed to add expense' });
    }
  });

  socket.on('expense:delete', async ({ id, password }, ack) => {
    if (socket.user.role !== 'admin') {
      return ack && ack({ ok: false, error: 'Only admins can delete expenses' });
    }
    if (!password || password !== DELETE_PASSWORD) {
      return ack && ack({ ok: false, error: 'Incorrect delete password' });
    }
    try {
      await db.deleteExpense(id);
      io.to('admins').emit('expense:deleted', { id });
      ack && ack({ ok: true });
    } catch (err) {
      console.error('expense:delete failed', err);
      ack && ack({ ok: false, error: 'Failed to delete expense' });
    }
  });

  // ---- Fleet Directory (agents) — admin-managed, admin-only --------

  socket.on('agent:create', async ({ name, phone }, ack) => {
    if (socket.user.role !== 'admin') {
      return ack && ack({ ok: false, error: 'Only admins can add agents' });
    }
    if (!name || !name.trim() || !phone || !phone.trim()) {
      return ack && ack({ ok: false, error: 'Name and phone are required' });
    }
    try {
      const agent = await db.createAgent({ id: crypto.randomUUID(), name: name.trim(), phone: phone.trim() });
      io.to('admins').emit('agent:created', agent);
      ack && ack({ ok: true, agent });
    } catch (err) {
      console.error('agent:create failed', err);
      ack && ack({ ok: false, error: 'Failed to add agent' });
    }
  });

  socket.on('agent:update', async ({ id, name, phone }, ack) => {
    if (socket.user.role !== 'admin') {
      return ack && ack({ ok: false, error: 'Only admins can edit agents' });
    }
    if (!name || !name.trim() || !phone || !phone.trim()) {
      return ack && ack({ ok: false, error: 'Name and phone are required' });
    }
    try {
      const agent = await db.updateAgent(id, { name: name.trim(), phone: phone.trim() });
      if (!agent) return ack && ack({ ok: false, error: 'Agent not found' });
      io.to('admins').emit('agent:updated', agent);
      ack && ack({ ok: true, agent });
    } catch (err) {
      console.error('agent:update failed', err);
      ack && ack({ ok: false, error: 'Failed to update agent' });
    }
  });
});

// ============================================================
// REST: auth + one-time initial state load
// ============================================================

app.post('/api/auth/register', authLimiter, async (req, res) => {
  const { businessName, email, password, phone } = req.body || {};
  if (!businessName || !email || !password || !phone) {
    return res.status(400).json({ error: 'businessName, email, phone, and password are required' });
  }
  if (password.length < 8) {
    return res.status(400).json({ error: 'Password must be at least 8 characters' });
  }
  try {
    const existing = await db.getUserByEmail(email);
    if (existing) return res.status(409).json({ error: 'An account with that email already exists' });

    const passwordHash = await hashPassword(password);
    const user = await db.createUser({
      id: crypto.randomUUID(),
      businessName,
      email,
      phone,
      passwordHash,
      role: 'sender', // public registration always creates senders; admins are seeded (see below)
    });
    const token = signToken(user);
    res.json({ token, user: { id: user.id, businessName: user.businessName, email: user.email, role: user.role } });
  } catch (err) {
    console.error('register failed', err);
    res.status(500).json({ error: 'Registration failed' });
  }
});

app.post('/api/auth/login', authLimiter, async (req, res) => {
  const { email, password } = req.body || {};
  if (!email || !password) return res.status(400).json({ error: 'Email and password are required' });
  try {
    const user = await db.getUserByEmail(email);
    if (!user) return res.status(401).json({ error: 'Invalid email or password' });
    const match = await comparePassword(password, user.passwordHash);
    if (!match) return res.status(401).json({ error: 'Invalid email or password' });
    const token = signToken(user);
    res.json({ token, user: { id: user.id, businessName: user.businessName, email: user.email, role: user.role } });
  } catch (err) {
    console.error('login failed', err);
    res.status(500).json({ error: 'Login failed' });
  }
});

// Forgot password, step 1: request a code. Always responds with the same
// generic message regardless of whether the email exists — this
// prevents an attacker from using this endpoint to discover which
// emails are registered. The code itself only actually gets sent if a
// matching account with a phone number exists and Twilio is configured.
const GENERIC_FORGOT_PASSWORD_RESPONSE = {
  ok: true,
  message: 'If an account exists for that email with a phone number on file, a reset code has been sent to it.',
};

app.post('/api/auth/forgot-password', authLimiter, async (req, res) => {
  const { email } = req.body || {};
  if (!email) return res.status(400).json({ error: 'Email is required' });
  try {
    const user = await db.getUserByEmail(email);
    if (user && user.phone) {
      const code = crypto.randomInt(100000, 1000000).toString(); // 6 digits
      const codeHash = await hashPassword(code);
      const expiresAt = new Date(Date.now() + 10 * 60 * 1000); // 10 minutes
      await db.createPasswordReset({ id: crypto.randomUUID(), userId: user.id, codeHash, expiresAt });

      const sent = await sendMessage(
        user.phone,
        `Your Verta Delivery Service password reset code is: ${code}\nIt expires in 10 minutes. If you didn't request this, ignore this message.`
      );
      if (!sent) {
        console.warn(`[forgot-password] Could not deliver reset code to ${user.phone} — is Twilio configured? (see server/notify.js)`);
      }
    } else if (user && !user.phone) {
      console.warn(`[forgot-password] ${email} has no phone on file — cannot send a reset code`);
    }
    // Same response either way — see comment above.
    res.json(GENERIC_FORGOT_PASSWORD_RESPONSE);
  } catch (err) {
    console.error('forgot-password failed', err);
    // Still don't leak anything specific on error.
    res.json(GENERIC_FORGOT_PASSWORD_RESPONSE);
  }
});

// Forgot password, step 2: verify the code and set a new password.
app.post('/api/auth/reset-password', authLimiter, async (req, res) => {
  const { email, code, newPassword } = req.body || {};
  if (!email || !code || !newPassword) {
    return res.status(400).json({ error: 'Email, code, and new password are required' });
  }
  if (newPassword.length < 8) {
    return res.status(400).json({ error: 'Password must be at least 8 characters' });
  }
  try {
    const user = await db.getUserByEmail(email);
    if (!user) return res.status(400).json({ error: 'Invalid or expired code' });

    const reset = await db.getActivePasswordReset(user.id);
    if (!reset) return res.status(400).json({ error: 'Invalid or expired code' });

    const match = await comparePassword(code, reset.code_hash);
    if (!match) return res.status(400).json({ error: 'Invalid or expired code' });

    const passwordHash = await hashPassword(newPassword);
    await db.updateUserPassword(user.id, passwordHash);
    await db.markPasswordResetUsed(reset.id);

    // Log the user in immediately as a convenience — they just proved
    // phone ownership via the code, which is a stronger check than a
    // typed password alone.
    const freshUser = await db.getUserById(user.id);
    const token = signToken(freshUser);
    res.json({ ok: true, token, user: { id: freshUser.id, businessName: freshUser.businessName, email: freshUser.email, role: freshUser.role } });
  } catch (err) {
    console.error('reset-password failed', err);
    res.status(500).json({ error: 'Failed to reset password' });
  }
});

// Admin login: a single shared password (matches the original app's UX),
// checked against the seeded admin account server-side. Returns a real JWT
// so the rest of the app (REST + sockets) treats admins exactly like any
// other authenticated role.
app.post('/api/auth/admin-login', authLimiter, async (req, res) => {
  const { password } = req.body || {};
  if (!password) return res.status(400).json({ error: 'Password is required' });
  try {
    const admin = await db.getUserByEmail(ADMIN_EMAIL);
    if (!admin) return res.status(500).json({ error: 'Admin account is not set up yet' });
    const match = await comparePassword(password, admin.passwordHash);
    if (!match) return res.status(401).json({ error: 'Incorrect password' });
    const token = signToken(admin);
    res.json({ token, user: { id: admin.id, businessName: admin.businessName, email: admin.email, role: admin.role } });
  } catch (err) {
    console.error('admin-login failed', err);
    res.status(500).json({ error: 'Login failed' });
  }
});

app.get('/api/me', requireAuth, async (req, res) => {
  const user = await db.getUserById(req.user.id);
  if (!user) return res.status(401).json({ error: 'Account no longer exists' });
  res.json({ user: { id: user.id, businessName: user.businessName, email: user.email, role: user.role } });
});

// Role-scoped bootstrap load: senders get only their own orders; admins get
// everything. Every update after this arrives over the socket in realtime.
app.get('/api/state', requireAuth, async (req, res) => {
  try {
    if (req.user.role === 'admin') {
      const [orders, expenses, agents] = await Promise.all([db.getAllOrders(), db.getAllExpenses(), db.getAllAgents()]);
      res.json({ orders, expenses, agents });
    } else {
      const orders = await db.getOrdersBySender(req.user.id);
      res.json({ orders, expenses: [], agents: [] });
    }
  } catch (err) {
    console.error('GET /api/state failed', err);
    res.status(500).json({ error: 'Failed to load state' });
  }
});

app.get('/health', (req, res) => res.json({ ok: true }));

async function seedAdminIfConfigured() {
  // Always ensure the admin account exists — defaults to
  // admin@vertadelivery.com / 1Nigeria@ unless overridden via env vars,
  // so the app works immediately with no Railway config required.
  const existing = await db.getUserByEmail(ADMIN_EMAIL);
  if (existing) return; // already seeded
  const passwordHash = await hashPassword(ADMIN_PASSWORD);
  await db.createUser({
    id: crypto.randomUUID(),
    businessName: 'Verta Delivery Services',
    email: ADMIN_EMAIL,
    passwordHash,
    role: 'admin',
  });
  console.log(`[seed] Created admin account for ${ADMIN_EMAIL}`);
}

// The five agents that used to be a hardcoded client-side constant — now
// real, editable rows. Seeded once so upgrading to this version doesn't
// change anything an admin currently sees; from then on the Fleet
// Directory is fully admin-managed (add/edit) via the UI.
const DEFAULT_AGENTS = [
  { name: 'Titus', phone: '0772558553' },
  { name: 'Emmanuel', phone: '0760566696' },
  { name: 'Augustine', phone: '0772558559' },
  { name: 'Boima', phone: '0778643650' },
  { name: 'Arthur', phone: '0772558557' },
];

async function seedAgentsIfEmpty() {
  const count = await db.countAgents();
  if (count > 0) return; // already seeded (or admin has since managed the list)
  for (const agent of DEFAULT_AGENTS) {
    await db.createAgent({ id: crypto.randomUUID(), name: agent.name, phone: agent.phone });
  }
  console.log(`[seed] Seeded ${DEFAULT_AGENTS.length} default agents`);
}

db.init()
  .then(seedAdminIfConfigured)
  .then(seedAgentsIfEmpty)
  .then(() => {
    server.listen(PORT, () => console.log(`Verta Delivery server listening on :${PORT}`));
  })
  .catch((err) => {
    console.error('Failed to initialize database', err);
    process.exit(1);
  });
