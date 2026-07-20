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

// Small, honest User-Agent parser for login history — covers the common
// cases (not a full device-detection library) rather than pretending to
// be exhaustive. Falls back to "Unknown" instead of guessing.
function parseUserAgent(ua) {
  if (!ua) return { device: 'Unknown', browser: 'Unknown' };
  let device = 'Desktop';
  if (/iPhone/i.test(ua)) device = 'iPhone';
  else if (/iPad/i.test(ua)) device = 'iPad';
  else if (/Android/i.test(ua)) device = 'Android';
  else if (/Macintosh/i.test(ua)) device = 'Mac';
  else if (/Windows/i.test(ua)) device = 'Windows';
  else if (/Linux/i.test(ua)) device = 'Linux';

  let browser = 'Unknown';
  if (/Edg\//i.test(ua)) browser = 'Edge';
  else if (/Chrome\//i.test(ua) && !/Chromium/i.test(ua)) browser = 'Chrome';
  else if (/CriOS/i.test(ua)) browser = 'Chrome';
  else if (/Firefox\//i.test(ua)) browser = 'Firefox';
  else if (/Safari\//i.test(ua) && !/Chrome/i.test(ua)) browser = 'Safari';

  return { device, browser };
}

async function recordLoginHistory(req, userId) {
  try {
    const { device, browser } = parseUserAgent(req.headers['user-agent']);
    await db.recordLogin({ id: crypto.randomUUID(), userId, ipAddress: req.ip, device, browser });
  } catch (err) {
    // Login history is a convenience, never a reason to fail a login.
    console.error('recordLoginHistory failed', err);
  }
}

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
    const isSender = socket.user.role === 'sender';
    const isAdmin = socket.user.role === 'admin';
    if (!isSender && !isAdmin) {
      return ack && ack({ ok: false, error: 'Not allowed to create orders' });
    }
    try {
      let senderId = socket.user.id;
      let senderName = socket.user.businessName;
      if (isAdmin) {
        // Admin is placing this on a customer's behalf (phone/walk-in
        // order) — look up the real customer record rather than trusting
        // any name the client might send, same principle as everywhere
        // else in this app.
        if (!payload.senderId) {
          return ack && ack({ ok: false, error: 'Please choose which customer this order is for' });
        }
        const customer = await db.getUserById(payload.senderId);
        if (!customer || customer.role !== 'sender') {
          return ack && ack({ ok: false, error: 'Customer not found' });
        }
        senderId = customer.id;
        senderName = customer.businessName;
      }
      const order = await db.createOrder({
        id: `ORD-${Date.now().toString(36).toUpperCase()}`,
        senderId,
        senderName,
        pickupAddress: payload.pickupAddress,
        dropoffAddress: payload.dropoffAddress,
        itemDescription: payload.itemDescription,
        amount: null,
        status: 'pending',
        placedByAdmin: isAdmin,
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

  socket.on('order:accept', async ({ id, amount, acceptedBy, paymentMethod }, ack) => {
    if (socket.user.role !== 'admin') {
      return ack && ack({ ok: false, error: 'Only admins can accept orders' });
    }
    try {
      const order = await db.updateOrder(id, {
        amount,
        acceptedBy,
        paymentMethod: paymentMethod || null,
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

  // "On Duty / Off Duty" — explicitly admin-set, not automatic presence
  // (see the duty_status comment in schema.sql for why).
  socket.on('agent:set-duty-status', async ({ id, dutyStatus }, ack) => {
    if (socket.user.role !== 'admin') {
      return ack && ack({ ok: false, error: 'Only admins can change agent duty status' });
    }
    if (dutyStatus !== 'on_duty' && dutyStatus !== 'off_duty') {
      return ack && ack({ ok: false, error: 'Invalid duty status' });
    }
    try {
      const agent = await db.updateAgentDutyStatus(id, dutyStatus);
      if (!agent) return ack && ack({ ok: false, error: 'Agent not found' });
      io.to('admins').emit('agent:updated', agent);
      ack && ack({ ok: true, agent });
    } catch (err) {
      console.error('agent:set-duty-status failed', err);
      ack && ack({ ok: false, error: 'Failed to update duty status' });
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
    await recordLoginHistory(req, user.id);
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
    await recordLoginHistory(req, user.id);
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
    await recordLoginHistory(req, freshUser.id);
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
    await recordLoginHistory(req, admin.id);
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
    const settings = await db.getSettings();
    if (req.user.role === 'admin') {
      const [orders, expenses, agents, pricePresets] = await Promise.all([
        db.getAllOrders(), db.getAllExpenses(), db.getAllAgents(), db.getAllPricePresets(),
      ]);
      res.json({ orders, expenses, agents, settings, pricePresets });
    } else {
      const orders = await db.getOrdersBySender(req.user.id);
      res.json({ orders, expenses: [], agents: [], settings, pricePresets: [] });
    }
  } catch (err) {
    console.error('GET /api/state failed', err);
    res.status(500).json({ error: 'Failed to load state' });
  }
});

// ============================================================
// Admin Settings page — Business Profile, Security, Backup & Restore.
// Every route below requires both requireAuth AND requireAdmin: senders
// can't reach any of this even with a valid token.
// ============================================================

const MAX_LOGO_BYTES = 700 * 1024; // ~700KB — logo lives as a data URL in
// Postgres (see schema.sql), so this keeps row size sane. A data URL is
// ~33% larger than the raw file, so this allows roughly a 500KB image.

app.put('/api/admin/settings', requireAuth, requireAdmin, async (req, res) => {
  const fields = req.body || {};
  if (fields.logoDataUrl && fields.logoDataUrl.length > MAX_LOGO_BYTES) {
    return res.status(400).json({ error: 'Logo image is too large — please use an image under ~500KB.' });
  }
  if (fields.openDays && !Array.isArray(fields.openDays)) {
    return res.status(400).json({ error: 'openDays must be a list of day names' });
  }
  try {
    const settings = await db.upsertSettings(fields);
    io.to('admins').emit('settings:updated', settings); // live-sync to any other open admin sessions
    res.json({ ok: true, settings });
  } catch (err) {
    console.error('PUT /api/admin/settings failed', err);
    res.status(500).json({ error: 'Failed to save settings' });
  }
});

app.post('/api/admin/change-email', requireAuth, requireAdmin, authLimiter, async (req, res) => {
  const { newEmail, currentPassword } = req.body || {};
  if (!newEmail || !currentPassword) {
    return res.status(400).json({ error: 'New email and current password are required' });
  }
  try {
    const admin = await db.getUserById(req.user.id);
    const match = await comparePassword(currentPassword, admin.passwordHash);
    if (!match) return res.status(401).json({ error: 'Current password is incorrect' });

    const existing = await db.getUserByEmail(newEmail);
    if (existing && existing.id !== admin.id) {
      return res.status(409).json({ error: 'That email is already in use' });
    }
    const updated = await db.updateUserEmail(admin.id, newEmail);
    const token = signToken(updated); // token embeds email, so it must be reissued
    res.json({ ok: true, token, user: { id: updated.id, businessName: updated.businessName, email: updated.email, role: updated.role } });
  } catch (err) {
    console.error('change-email failed', err);
    res.status(500).json({ error: 'Failed to change email' });
  }
});

app.post('/api/admin/change-password', requireAuth, requireAdmin, authLimiter, async (req, res) => {
  const { currentPassword, newPassword } = req.body || {};
  if (!currentPassword || !newPassword) {
    return res.status(400).json({ error: 'Current and new password are required' });
  }
  if (newPassword.length < 8) {
    return res.status(400).json({ error: 'New password must be at least 8 characters' });
  }
  try {
    const admin = await db.getUserById(req.user.id);
    const match = await comparePassword(currentPassword, admin.passwordHash);
    if (!match) return res.status(401).json({ error: 'Current password is incorrect' });
    const passwordHash = await hashPassword(newPassword);
    await db.updateUserPassword(admin.id, passwordHash);
    res.json({ ok: true });
  } catch (err) {
    console.error('change-password failed', err);
    res.status(500).json({ error: 'Failed to change password' });
  }
});

app.get('/api/admin/login-history', requireAuth, requireAdmin, async (req, res) => {
  try {
    const history = await db.getLoginHistory(req.user.id, 20);
    res.json({ history });
  } catch (err) {
    console.error('GET /api/admin/login-history failed', err);
    res.status(500).json({ error: 'Failed to load login history' });
  }
});

// "Logout All Devices" — bumps token_version, which invalidates every
// JWT issued before this call (see checkTokenVersion in auth.js). Then
// immediately re-issues a fresh token for THIS request, so the admin
// doing this isn't accidentally logged out of their own current session.
app.post('/api/admin/logout-all-devices', requireAuth, requireAdmin, authLimiter, async (req, res) => {
  try {
    const updated = await db.bumpTokenVersion(req.user.id);
    const token = signToken(updated);
    res.json({ ok: true, token });
  } catch (err) {
    console.error('logout-all-devices failed', err);
    res.status(500).json({ error: 'Failed to log out other devices' });
  }
});

app.get('/api/admin/export', requireAuth, requireAdmin, async (req, res) => {
  try {
    const data = await db.exportAllData();
    const filename = `verta-delivery-export-${new Date().toISOString().slice(0, 10)}.json`;
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader('Content-Type', 'application/json');
    res.send(JSON.stringify(data, null, 2));
  } catch (err) {
    console.error('GET /api/admin/export failed', err);
    res.status(500).json({ error: 'Failed to export data' });
  }
});

// ============================================================
// Customers page — real aggregated data (order counts, total spent)
// per customer, joined from users + orders. Read-only.
// ============================================================
app.get('/api/admin/customers', requireAuth, requireAdmin, async (req, res) => {
  try {
    const customers = await db.getCustomers();
    res.json({ customers });
  } catch (err) {
    console.error('GET /api/admin/customers failed', err);
    res.status(500).json({ error: 'Failed to load customers' });
  }
});

// ============================================================
// Pricing presets — admin-defined reference price points, offered as
// quick-select options in the Accept Order flow. Not an automatic
// distance/zone calculator (no mapping data backs this app).
// ============================================================
app.post('/api/admin/price-presets', requireAuth, requireAdmin, async (req, res) => {
  const { label, amount } = req.body || {};
  if (!label || !label.trim() || amount === undefined || amount === null || isNaN(Number(amount)) || Number(amount) < 0) {
    return res.status(400).json({ error: 'A label and a valid non-negative amount are required' });
  }
  try {
    const preset = await db.createPricePreset({ id: crypto.randomUUID(), label: label.trim(), amount: Number(amount) });
    io.to('admins').emit('price-preset:created', preset);
    res.json({ ok: true, preset });
  } catch (err) {
    console.error('POST /api/admin/price-presets failed', err);
    res.status(500).json({ error: 'Failed to save price preset' });
  }
});

app.delete('/api/admin/price-presets/:id', requireAuth, requireAdmin, async (req, res) => {
  try {
    await db.deletePricePreset(req.params.id);
    io.to('admins').emit('price-preset:deleted', { id: req.params.id });
    res.json({ ok: true });
  } catch (err) {
    console.error('DELETE /api/admin/price-presets failed', err);
    res.status(500).json({ error: 'Failed to delete price preset' });
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
