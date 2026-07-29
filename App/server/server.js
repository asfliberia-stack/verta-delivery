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
  signImpersonationToken,
  requireAuth,
  requireAdmin,
  requireSuperAdmin,
  requireVendor,
  isAdminLike,
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
// Default express.json() limit is 100kb — too small for base64 image/
// document uploads (product photos, business logos, vendor registration
// documents). Raised to comfortably cover the largest of those with
// room for JSON overhead and two documents in one request.
app.use(express.json({ limit: '10mb' }));
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
  const room = isAdminLike(socket.user.role)
    ? 'admins'
    : socket.user.role === 'vendor'
      ? `vendor:${socket.user.id}`
      : `user:${socket.user.id}`;
  socket.join(room);
  console.log(`[socket] ${socket.user.role} connected: ${socket.user.email} (${socket.id})`);

  socket.on('disconnect', () => {
    console.log(`[socket] disconnected: ${socket.user.email} (${socket.id})`);
  });

  // ---- Orders (create = sender only; everything else = admin only) ----

  socket.on('order:create', async (payload, ack) => {
    const isSender = socket.user.role === 'sender';
    const isAdmin = isAdminLike(socket.user.role);
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
    if (!isAdminLike(socket.user.role)) {
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
    if (!isAdminLike(socket.user.role)) {
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
    if (!isAdminLike(socket.user.role)) {
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
    if (!isAdminLike(socket.user.role)) {
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
    if (!isAdminLike(socket.user.role)) {
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
    if (!isAdminLike(socket.user.role)) {
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
    if (!isAdminLike(socket.user.role)) {
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
    if (!isAdminLike(socket.user.role)) {
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
    res.json({ token, user: { id: user.id, businessName: user.businessName, email: user.email, role: user.role, approvalStatus: user.approvalStatus } });
  } catch (err) {
    console.error('register failed', err);
    res.status(500).json({ error: 'Registration failed' });
  }
});

// Vendor self-registration — creates a real account (so the applicant
// can log in and see their status) but starts 'pending': requireVendor
// blocks every actual vendor action (products, orders, etc.) until a
// Super Admin approves it. That approval UI doesn't exist yet — this
// endpoint is the intake side of that workflow; the review side is a
// separate, later piece of work.
const MAX_DOCUMENT_BYTES = 2 * 1024 * 1024; // ~2MB raw per document — these are photos of real paperwork, larger than a product photo
const VALID_ID_DOCUMENT_TYPES = ['passport', 'national_id', 'drivers_license'];

app.post('/api/auth/register-vendor', authLimiter, async (req, res) => {
  const { businessName, email, password, phone, businessRegistrationDoc, idDocumentType, idDocumentDoc } = req.body || {};
  if (!businessName || !email || !password || !phone) {
    return res.status(400).json({ error: 'Business name, email, phone, and password are required' });
  }
  if (password.length < 8) {
    return res.status(400).json({ error: 'Password must be at least 8 characters' });
  }
  if (!businessRegistrationDoc || !idDocumentDoc || !idDocumentType) {
    return res.status(400).json({ error: 'Business registration document and a government ID are required for vendor applications' });
  }
  if (!VALID_ID_DOCUMENT_TYPES.includes(idDocumentType)) {
    return res.status(400).json({ error: 'Invalid ID document type' });
  }
  if (businessRegistrationDoc.length > MAX_DOCUMENT_BYTES * 1.4 || idDocumentDoc.length > MAX_DOCUMENT_BYTES * 1.4) {
    return res.status(400).json({ error: 'Each document must be under ~2MB — please use a smaller photo or scan.' });
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
      role: 'vendor',
      approvalStatus: 'pending',
      businessRegistrationDoc,
      idDocumentType,
      idDocumentDoc,
      appliedAt: new Date().toISOString(),
    });

    // Real notification attempt — logged clearly rather than faked.
    // This app has no email service configured (no SMTP/SendGrid/etc),
    // so an actual email to onlib231@gmail.com can't be sent yet; once
    // one is wired in, this is the one place that needs to change.
    console.log(`[vendor-application] New vendor application from "${businessName}" (${email}) — would notify onlib231@gmail.com if an email service were configured. Review via the database (users table, approval_status='pending') until the Super Admin approval UI is built.`);

    const token = signToken(user);
    res.json({
      token,
      user: { id: user.id, businessName: user.businessName, email: user.email, role: user.role, approvalStatus: user.approvalStatus },
    });
  } catch (err) {
    console.error('register-vendor failed', err);
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
    res.json({ token, user: { id: user.id, businessName: user.businessName, email: user.email, role: user.role, approvalStatus: user.approvalStatus } });
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
  res.json({ user: { id: user.id, businessName: user.businessName, email: user.email, role: user.role, approvalStatus: user.approvalStatus } });
});

// Role-scoped bootstrap load: senders get only their own orders; admins get
// everything. Every update after this arrives over the socket in realtime.
app.get('/api/state', requireAuth, async (req, res) => {
  try {
    const settings = await db.getSettings();
    if (isAdminLike(req.user.role)) {
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
// Super Admin only — platform-wide Overview. Genuinely cross-cutting
// data (vendors, customers, marketplace AND delivery totals) — this is
// what makes the Super Admin console a real oversight view rather than
// a relabeled copy of the Manage Agent operations dashboard.
// ============================================================
app.get('/api/super-admin/overview', requireAuth, requireSuperAdmin, async (req, res) => {
  try {
    const [vendors, marketplaceStats, customers, deliveryOrders] = await Promise.all([
      db.getVendors(),
      db.getMarketplacePlatformStats(),
      db.getCustomers(),
      db.getAllOrders(),
    ]);
    const deliveryRevenue = deliveryOrders
      .filter(o => o.status === 'delivered')
      .reduce((sum, o) => sum + (o.amount || 0), 0);
    res.json({
      vendorCounts: {
        total: vendors.length,
        approved: vendors.filter(v => v.approvalStatus === 'approved').length,
        pending: vendors.filter(v => v.approvalStatus === 'pending').length,
        rejected: vendors.filter(v => v.approvalStatus === 'rejected').length,
      },
      totalCustomers: customers.length,
      marketplace: marketplaceStats,
      delivery: {
        totalOrders: deliveryOrders.length,
        totalRevenue: deliveryRevenue,
      },
    });
  } catch (err) {
    console.error('GET /api/super-admin/overview failed', err);
    res.status(500).json({ error: 'Failed to load overview' });
  }
});

// ============================================================
// Super Admin only — Vendors oversight panel. Lists every real vendor
// account (role = 'vendor'), their approval status, and real
// marketplace-wide stats. This previously (incorrectly) listed Manage
// Agent accounts and unrelated Delivery-service stats — fixed to show
// actual vendor data now that real vendor accounts exist.
// ============================================================
app.get('/api/super-admin/vendors', requireAuth, requireSuperAdmin, async (req, res) => {
  try {
    const [vendors, platformStats] = await Promise.all([
      db.getVendors(), db.getMarketplacePlatformStats(),
    ]);
    res.json({ vendors, platformTotals: platformStats });
  } catch (err) {
    console.error('GET /api/super-admin/vendors failed', err);
    res.status(500).json({ error: 'Failed to load vendors' });
  }
});

// Real Manage Agent account summary — for the Super Admin Console's
// "Manage Agent" tab. There's only one such account today (the shared
// ADMIN_EMAIL/ADMIN_PASSWORD login), so this just surfaces it.
app.get('/api/super-admin/manage-agent', requireAuth, requireSuperAdmin, async (req, res) => {
  try {
    const admin = await db.getUserByEmail(ADMIN_EMAIL);
    if (!admin) return res.status(404).json({ error: 'Manage Agent account not found' });
    res.json({ businessName: admin.businessName, email: admin.email, createdAt: admin.createdAt });
  } catch (err) {
    console.error('GET /api/super-admin/manage-agent failed', err);
    res.status(500).json({ error: 'Failed to load Manage Agent account' });
  }
});

// A pending vendor's submitted documents — fetched on demand (not
// included in the list above) since they're base64 images/PDFs and
// would bloat that response for every vendor just to review one.
app.get('/api/super-admin/vendors/:id/documents', requireAuth, requireSuperAdmin, async (req, res) => {
  try {
    const docs = await db.getVendorApplicationDocuments(req.params.id);
    if (!docs) return res.status(404).json({ error: 'Vendor not found' });
    res.json(docs);
  } catch (err) {
    console.error('GET /api/super-admin/vendors/:id/documents failed', err);
    res.status(500).json({ error: 'Failed to load documents' });
  }
});

app.post('/api/super-admin/vendors/:id/approve', requireAuth, requireSuperAdmin, async (req, res) => {
  try {
    const vendor = await db.setVendorApprovalStatus(req.params.id, 'approved');
    if (!vendor) return res.status(404).json({ error: 'Vendor not found' });
    res.json({ ok: true, vendor: { id: vendor.id, businessName: vendor.businessName, approvalStatus: vendor.approvalStatus } });
  } catch (err) {
    console.error('POST vendor approve failed', err);
    res.status(500).json({ error: 'Failed to approve vendor' });
  }
});

app.post('/api/super-admin/vendors/:id/reject', requireAuth, requireSuperAdmin, async (req, res) => {
  try {
    const vendor = await db.setVendorApprovalStatus(req.params.id, 'rejected');
    if (!vendor) return res.status(404).json({ error: 'Vendor not found' });
    res.json({ ok: true, vendor: { id: vendor.id, businessName: vendor.businessName, approvalStatus: vendor.approvalStatus } });
  } catch (err) {
    console.error('POST vendor reject failed', err);
    res.status(500).json({ error: 'Failed to reject vendor' });
  }
});

// "Enter Dashboard" — lets a Super Admin operate a vendor's real
// dashboard (same UI the vendor themselves uses, full read/write) for
// oversight/support purposes. Real safeguards, not just a relabeled
// login:
//   - Requires requireSuperAdmin (only Super Admin can mint this).
//   - The token is short-lived (1 hour — see signImpersonationToken),
//     not a normal 30-day session.
//   - Carries `impersonatedBy` so every action taken shows up in
//     server logs traceable back to the real Super Admin, not silently
//     attributed to the vendor with no trail.
//   - If the vendor isn't approved yet, this still works, but
//     enterApp() will show that vendor's own pending/rejected status
//     screen (same as the vendor would see) rather than the operational
//     dashboard — reviewing a pending application is what the Vendors
//     panel's document review is for, not this.
app.post('/api/super-admin/vendors/:id/impersonate', requireAuth, requireSuperAdmin, async (req, res) => {
  try {
    const vendor = await db.getUserById(req.params.id);
    if (!vendor || vendor.role !== 'vendor') return res.status(404).json({ error: 'Vendor not found' });
    const superAdmin = await db.getUserById(req.user.id);
    const token = signImpersonationToken(vendor, superAdmin);
    console.log(`[impersonation] Super Admin ${superAdmin.email} entered vendor dashboard for "${vendor.businessName}" (${vendor.email})`);
    res.json({
      token,
      user: { id: vendor.id, businessName: vendor.businessName, email: vendor.email, role: vendor.role, approvalStatus: vendor.approvalStatus },
    });
  } catch (err) {
    console.error('POST vendor impersonate failed', err);
    res.status(500).json({ error: 'Failed to enter vendor dashboard' });
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

// ============================================================
// Marketplace (ONLib) — vendor product management
// ============================================================

app.get('/api/vendor/products', requireAuth, requireVendor, async (req, res) => {
  try {
    const products = await db.getProductsByVendor(req.user.id);
    res.json({ products });
  } catch (err) {
    console.error('GET /api/vendor/products failed', err);
    res.status(500).json({ error: 'Failed to load products' });
  }
});

const MAX_PRODUCT_IMAGE_BYTES = 700 * 1024; // same limit/reasoning as the business logo upload

app.post('/api/vendor/products', requireAuth, requireVendor, async (req, res) => {
  const { name, description, price, category, imageDataUrl, stockQuantity } = req.body || {};
  if (!name || !name.trim() || price === undefined || isNaN(Number(price)) || Number(price) < 0) {
    return res.status(400).json({ error: 'A name and a valid non-negative price are required' });
  }
  if (imageDataUrl && imageDataUrl.length > MAX_PRODUCT_IMAGE_BYTES) {
    return res.status(400).json({ error: 'Product image is too large — please use an image under ~500KB.' });
  }
  try {
    const product = await db.createProduct({
      id: crypto.randomUUID(),
      vendorId: req.user.id,
      name: name.trim(),
      description,
      price: Number(price),
      category,
      imageDataUrl,
      stockQuantity: Number(stockQuantity) || 0,
    });
    res.json({ ok: true, product });
  } catch (err) {
    console.error('POST /api/vendor/products failed', err);
    res.status(500).json({ error: 'Failed to create product' });
  }
});

app.put('/api/vendor/products/:id', requireAuth, requireVendor, async (req, res) => {
  try {
    const existing = await db.getProductById(req.params.id);
    if (!existing) return res.status(404).json({ error: 'Product not found' });
    if (existing.vendorId !== req.user.id) return res.status(403).json({ error: 'Not your product' });
    if (req.body.imageDataUrl && req.body.imageDataUrl.length > MAX_PRODUCT_IMAGE_BYTES) {
      return res.status(400).json({ error: 'Product image is too large — please use an image under ~500KB.' });
    }
    const product = await db.updateProduct(req.params.id, req.body || {});
    res.json({ ok: true, product });
  } catch (err) {
    console.error('PUT /api/vendor/products failed', err);
    res.status(500).json({ error: 'Failed to update product' });
  }
});

app.delete('/api/vendor/products/:id', requireAuth, requireVendor, async (req, res) => {
  try {
    const existing = await db.getProductById(req.params.id);
    if (!existing) return res.status(404).json({ error: 'Product not found' });
    if (existing.vendorId !== req.user.id) return res.status(403).json({ error: 'Not your product' });
    await db.deleteProduct(req.params.id);
    res.json({ ok: true });
  } catch (err) {
    console.error('DELETE /api/vendor/products failed', err);
    res.status(500).json({ error: 'Failed to delete product' });
  }
});

app.get('/api/vendor/sales-overview', requireAuth, requireVendor, async (req, res) => {
  try {
    const overview = await db.getVendorSalesOverview(req.user.id, 30);
    res.json(overview);
  } catch (err) {
    console.error('GET /api/vendor/sales-overview failed', err);
    res.status(500).json({ error: 'Failed to load sales overview' });
  }
});

app.get('/api/vendor/daily-sales', requireAuth, requireVendor, async (req, res) => {
  try {
    const days = await db.getVendorDailySales(req.user.id, 30);
    res.json({ days });
  } catch (err) {
    console.error('GET /api/vendor/daily-sales failed', err);
    res.status(500).json({ error: 'Failed to load sales chart' });
  }
});

app.get('/api/vendor/purchases', requireAuth, requireVendor, async (req, res) => {
  try {
    const purchases = await db.getPurchasesByVendor(req.user.id);
    res.json({ purchases });
  } catch (err) {
    console.error('GET /api/vendor/purchases failed', err);
    res.status(500).json({ error: 'Failed to load orders' });
  }
});

// Real customers — who has actually bought from this vendor, derived
// from purchase records. Not a "leads" concept (no such data exists).
app.get('/api/vendor/customers', requireAuth, requireVendor, async (req, res) => {
  try {
    const customers = await db.getVendorCustomers(req.user.id);
    res.json({ customers });
  } catch (err) {
    console.error('GET /api/vendor/customers failed', err);
    res.status(500).json({ error: 'Failed to load customers' });
  }
});

// Real order-status breakdown — used for the dashboard's donut chart in
// place of the mockup's "Sales by Channel" (no traffic-source tracking
// exists in this app; status IS real, tracked data).
app.get('/api/vendor/order-status-breakdown', requireAuth, requireVendor, async (req, res) => {
  try {
    const breakdown = await db.getVendorOrderStatusBreakdown(req.user.id);
    res.json({ breakdown });
  } catch (err) {
    console.error('GET /api/vendor/order-status-breakdown failed', err);
    res.status(500).json({ error: 'Failed to load order status breakdown' });
  }
});

// ============================================================
// Marketplace — customer storefront + checkout
// ============================================================

// Public — no requireAuth. The marketplace homepage is the default
// landing page for guests, so browsing must work with no login at all.
// Checkout still requires a real sender account (checked below).
app.get('/api/marketplace/products', async (req, res) => {
  try {
    const products = await db.getActiveProductsForStorefront();
    res.json({ products });
  } catch (err) {
    console.error('GET /api/marketplace/products failed', err);
    res.status(500).json({ error: 'Failed to load products' });
  }
});

// Public — the Stores tab, real vendor list with real aggregate ratings.
app.get('/api/marketplace/stores', async (req, res) => {
  try {
    const stores = await db.getStorefrontVendors();
    res.json({ stores });
  } catch (err) {
    console.error('GET /api/marketplace/stores failed', err);
    res.status(500).json({ error: 'Failed to load stores' });
  }
});

app.get('/api/marketplace/products/:id/reviews', async (req, res) => {
  try {
    const reviews = await db.getProductReviews(req.params.id);
    res.json({ reviews });
  } catch (err) {
    console.error('GET /api/marketplace/products/:id/reviews failed', err);
    res.status(500).json({ error: 'Failed to load reviews' });
  }
});

// Only a customer who actually bought this product can review it —
// verified server-side, not just hidden in the UI.
app.post('/api/marketplace/products/:id/reviews', requireAuth, async (req, res) => {
  if (req.user.role !== 'sender') {
    return res.status(403).json({ error: 'Only customers can leave reviews' });
  }
  const { rating, comment } = req.body || {};
  if (!rating || rating < 1 || rating > 5) {
    return res.status(400).json({ error: 'A rating from 1 to 5 is required' });
  }
  try {
    const purchased = await db.hasCustomerPurchasedProduct(req.user.id, req.params.id);
    if (!purchased) {
      return res.status(403).json({ error: 'You can only review products you have purchased' });
    }
    const review = await db.upsertProductReview({
      id: crypto.randomUUID(), productId: req.params.id, customerId: req.user.id, rating, comment,
    });
    res.json({ ok: true, review });
  } catch (err) {
    console.error('POST reviews failed', err);
    res.status(500).json({ error: 'Failed to save review' });
  }
});

// Checkout — pay-on-delivery (no payment gateway integrated yet) and
// automatically creates a real delivery order for fulfillment. Both are
// defaults, not confirmed decisions — see README.
app.post('/api/marketplace/checkout', requireAuth, async (req, res) => {
  if (req.user.role !== 'sender') {
    return res.status(403).json({ error: 'Only customers can check out' });
  }
  const { vendorId, items, pickupAddress, dropoffAddress } = req.body || {};
  if (!vendorId || !Array.isArray(items) || items.length === 0) {
    return res.status(400).json({ error: 'A vendor and at least one item are required' });
  }
  if (!pickupAddress || !dropoffAddress) {
    return res.status(400).json({ error: 'Pickup and dropoff addresses are required' });
  }
  try {
    const result = await db.checkout({
      customerId: req.user.id,
      customerName: req.user.businessName,
      vendorId,
      items,
      pickupAddress,
      dropoffAddress,
      createDeliveryOrder: true,
    });
    io.to(`vendor:${vendorId}`).emit('purchase:created', result);
    if (result.deliveryOrderId) {
      const deliveryOrder = await db.getOrder(result.deliveryOrderId);
      if (deliveryOrder) {
        orderRooms(deliveryOrder.senderId).forEach((r) => io.to(r).emit('order:created', deliveryOrder));
        notifyNewOrder(deliveryOrder);
      }
    }
    res.json({ ok: true, ...result });
  } catch (err) {
    console.error('POST /api/marketplace/checkout failed', err);
    res.status(400).json({ error: err.message || 'Checkout failed' });
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

// Super Admin — a distinct role that oversees every Manage Agent
// (admin) account. Defaults to the requested credentials; override via
// env vars in Railway if you want to change them without redeploying
// code.
const SUPER_ADMIN_EMAIL = process.env.SUPER_ADMIN_EMAIL || 'asfliberia@gmail.com';
const SUPER_ADMIN_PASSWORD = process.env.SUPER_ADMIN_PASSWORD || '1Liberia';

async function seedSuperAdminIfConfigured() {
  const existing = await db.getUserByEmail(SUPER_ADMIN_EMAIL);
  if (existing) return; // already seeded
  const passwordHash = await hashPassword(SUPER_ADMIN_PASSWORD);
  await db.createUser({
    id: crypto.randomUUID(),
    businessName: 'Super Admin',
    email: SUPER_ADMIN_EMAIL,
    passwordHash,
    role: 'super_admin',
  });
  console.log(`[seed] Created super admin account for ${SUPER_ADMIN_EMAIL}`);
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

// Marketplace's first real vendor. Defaults to the requested name and a
// generated login; override via env vars before first boot if you want
// a different email/password.
const VENDOR_EMAIL = process.env.VENDOR_EMAIL || 'girleefashion@golib.test';
const VENDOR_PASSWORD = process.env.VENDOR_PASSWORD || 'GirleeFashion1';

async function seedVendorIfConfigured() {
  const existing = await db.getUserByEmail(VENDOR_EMAIL);
  if (existing) return; // already seeded
  const passwordHash = await hashPassword(VENDOR_PASSWORD);
  await db.createUser({
    id: crypto.randomUUID(),
    businessName: 'Girlee Fashion',
    email: VENDOR_EMAIL,
    passwordHash,
    role: 'vendor',
  });
  console.log(`[seed] Created vendor account "Girlee Fashion" for ${VENDOR_EMAIL}`);
}

db.init()
  .then(seedAdminIfConfigured)
  .then(seedSuperAdminIfConfigured)
  .then(seedVendorIfConfigured)
  .then(seedAgentsIfEmpty)
  .then(() => {
    server.listen(PORT, () => console.log(`Verta Delivery server listening on :${PORT}`));
  })
  .catch((err) => {
    console.error('Failed to initialize database', err);
    process.exit(1);
  });
