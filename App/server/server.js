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
const { notifyNewOrder, sendMessage, notifyNewVendorApplication, sendEmail } = require('./notify');
const { OAuth2Client } = require('google-auth-library');
const {
  hashPassword,
  comparePassword,
  signToken,
  signImpersonationToken,
  verifyToken,
  requireAuth,
  requireAdmin,
  requireSuperAdmin,
  requireVendor,
  requireDeliveryCompany,
  isAdminLike,
  socketAuth,
} = require('./auth');

const PORT = process.env.PORT || 3000;

// Sign in with Google — optional, same graceful-degradation pattern as
// Twilio below. Unset means the feature simply isn't available yet;
// nothing else in the app depends on it.
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || '';
const googleClient = GOOGLE_CLIENT_ID ? new OAuth2Client(GOOGLE_CLIENT_ID) : null;

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
    const sessionId = crypto.randomUUID();
    await db.recordLogin({ id: sessionId, userId, ipAddress: req.ip, device, browser });
    return sessionId;
  } catch (err) {
    // Login history is a convenience, never a reason to fail a login —
    // a null sessionId just means this token won't support individual
    // revocation (falls back to "Logout All Devices" only).
    console.error('recordLoginHistory failed', err);
    return null;
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
      const agent = await db.getAgentByName(acceptedBy);
      const order = await db.updateOrder(id, {
        amount,
        acceptedBy,
        paymentMethod: paymentMethod || null,
        status: 'accepted',
        acceptedAt: new Date().toISOString(),
        deliveryCompanyId: agent ? agent.deliveryCompanyId : null,
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
    if (!isAdminLike(socket.user.role) && socket.user.role !== 'delivery_company') {
      return ack && ack({ ok: false, error: 'Only admins can add agents' });
    }
    if (!name || !name.trim() || !phone || !phone.trim()) {
      return ack && ack({ ok: false, error: 'Name and phone are required' });
    }
    try {
      const agent = await db.createAgent({ id: crypto.randomUUID(), name: name.trim(), phone: phone.trim(), deliveryCompanyId: socket.user.id });
      io.to('admins').emit('agent:created', agent);
      ack && ack({ ok: true, agent });
    } catch (err) {
      console.error('agent:create failed', err);
      ack && ack({ ok: false, error: 'Failed to add agent' });
    }
  });

  socket.on('agent:update', async ({ id, name, phone }, ack) => {
    if (!isAdminLike(socket.user.role) && socket.user.role !== 'delivery_company') {
      return ack && ack({ ok: false, error: 'Only admins can edit agents' });
    }
    if (!name || !name.trim() || !phone || !phone.trim()) {
      return ack && ack({ ok: false, error: 'Name and phone are required' });
    }
    try {
      if (socket.user.role === 'delivery_company') {
        const existing = await db.getAgentById(id);
        if (!existing || existing.deliveryCompanyId !== socket.user.id) {
          return ack && ack({ ok: false, error: 'Agent not found' });
        }
      }
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
    if (!isAdminLike(socket.user.role) && socket.user.role !== 'delivery_company') {
      return ack && ack({ ok: false, error: 'Only admins can change agent duty status' });
    }
    if (dutyStatus !== 'on_duty' && dutyStatus !== 'off_duty') {
      return ack && ack({ ok: false, error: 'Invalid duty status' });
    }
    try {
      if (socket.user.role === 'delivery_company') {
        const existing = await db.getAgentById(id);
        if (!existing || existing.deliveryCompanyId !== socket.user.id) {
          return ack && ack({ ok: false, error: 'Agent not found' });
        }
      }
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
    const sessionId = await recordLoginHistory(req, user.id);
    const token = signToken(user, sessionId);
    res.json({ token, user: { id: user.id, businessName: user.businessName, email: user.email, phone: user.phone, storeAddress: user.storeAddress, profileImageUrl: user.profileImageUrl, role: user.role, approvalStatus: user.approvalStatus } });
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

    // Real notification attempt — fire-and-forget, never blocks the
    // response. If SMTP isn't configured yet, notify.js quietly no-ops
    // and this line just doesn't do anything; nothing else depends on it.
    notifyNewVendorApplication(businessName, email);
    console.log(`[vendor-application] New vendor application from "${businessName}" (${email}) — review via the Super Admin console under Vendors.`);

    const sessionId = await recordLoginHistory(req, user.id);
    const token = signToken(user, sessionId);
    res.json({
      token,
      user: { id: user.id, businessName: user.businessName, email: user.email, phone: user.phone, storeAddress: user.storeAddress, profileImageUrl: user.profileImageUrl, role: user.role, approvalStatus: user.approvalStatus },
    });
  } catch (err) {
    console.error('register-vendor failed', err);
    res.status(500).json({ error: 'Registration failed' });
  }
});

// Delivery company self-registration — same real approval workflow as
// vendor registration above, mirrored exactly (same document
// requirements, same pending-until-approved status), just scoped to
// role = 'delivery_company'.
app.post('/api/auth/register-delivery-company', authLimiter, async (req, res) => {
  const { businessName, email, password, phone, businessRegistrationDoc, idDocumentType, idDocumentDoc } = req.body || {};
  if (!businessName || !email || !password || !phone) {
    return res.status(400).json({ error: 'Business name, email, phone, and password are required' });
  }
  if (password.length < 8) {
    return res.status(400).json({ error: 'Password must be at least 8 characters' });
  }
  if (!businessRegistrationDoc || !idDocumentDoc || !idDocumentType) {
    return res.status(400).json({ error: 'Business registration document and a government ID are required for delivery company applications' });
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
      role: 'delivery_company',
      approvalStatus: 'pending',
      businessRegistrationDoc,
      idDocumentType,
      idDocumentDoc,
      appliedAt: new Date().toISOString(),
    });

    notifyNewVendorApplication(businessName, email, 'delivery_company');
    console.log(`[delivery-company-application] New delivery company application from "${businessName}" (${email}) — review via the Super Admin console under Delivery Companies.`);

    const sessionId = await recordLoginHistory(req, user.id);
    const token = signToken(user, sessionId);
    res.json({
      token,
      user: { id: user.id, businessName: user.businessName, email: user.email, phone: user.phone, storeAddress: user.storeAddress, profileImageUrl: user.profileImageUrl, role: user.role, approvalStatus: user.approvalStatus },
    });
  } catch (err) {
    console.error('register-delivery-company failed', err);
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

    const sessionId = await recordLoginHistory(req, user.id);
    const token = signToken(user, sessionId);
    res.json({ token, user: { id: user.id, businessName: user.businessName, email: user.email, phone: user.phone, storeAddress: user.storeAddress, profileImageUrl: user.profileImageUrl, role: user.role, approvalStatus: user.approvalStatus } });
  } catch (err) {
    console.error('login failed', err);
    res.status(500).json({ error: 'Login failed' });
  }
});

// Public, non-secret config the frontend needs — safe to expose since
// a Google Client ID is meant to be embedded in frontend code (unlike
// a client secret, which this flow never uses or stores).
// Public, non-secret config the frontend needs before a person is
// even logged in — Google Client ID, and the real Privacy Policy /
// Terms of Service content, since guests need to be able to read
// these too (e.g. from the App Chooser or before creating an
// account), not just users who are already signed in.
app.get('/api/config', async (req, res) => {
  try {
    const settings = await db.getSettings();
    res.json({
      googleClientId: GOOGLE_CLIENT_ID || null,
      privacyPolicy: settings.privacyPolicy || null,
      termsOfService: settings.termsOfService || null,
    });
  } catch (err) {
    console.error('GET /api/config failed', err);
    res.json({ googleClientId: GOOGLE_CLIENT_ID || null, privacyPolicy: null, termsOfService: null });
  }
});

// Sign in with Google — verifies the ID token Google's own frontend
// library hands back, server-side, using Google's public keys (no
// client secret involved). Finds an existing account by email, or
// creates a new customer account if this is a first-time sign-in.
app.post('/api/auth/google', authLimiter, async (req, res) => {
  if (!googleClient) {
    return res.status(501).json({ error: 'Google Sign-In is not configured on this server yet.' });
  }
  const { credential } = req.body || {};
  if (!credential) return res.status(400).json({ error: 'Missing Google credential' });
  try {
    const ticket = await googleClient.verifyIdToken({ idToken: credential, audience: GOOGLE_CLIENT_ID });
    const payload = ticket.getPayload();
    if (!payload || !payload.email_verified) {
      return res.status(401).json({ error: "This Google account's email isn't verified" });
    }

    let user = await db.getUserByEmail(payload.email);
    if (!user) {
      // First time signing in with this email — create a real customer
      // account. No phone number (Google doesn't provide one) — same
      // nullable-phone state existing senders can already be in; they
      // can add one later via Settings. Password is a random, never-
      // shown value (this account simply signs in via Google going
      // forward, unless they later use "Forgot password" to set a real one).
      const randomPassword = crypto.randomBytes(32).toString('hex');
      const passwordHash = await hashPassword(randomPassword);
      user = await db.createUser({
        id: crypto.randomUUID(),
        businessName: payload.name || payload.email.split('@')[0],
        email: payload.email,
        phone: null,
        passwordHash,
        role: 'sender',
      });
    }

    const sessionId = await recordLoginHistory(req, user.id);
    const token = signToken(user, sessionId);
    res.json({ token, user: { id: user.id, businessName: user.businessName, email: user.email, phone: user.phone, storeAddress: user.storeAddress, profileImageUrl: user.profileImageUrl, role: user.role, approvalStatus: user.approvalStatus } });
  } catch (err) {
    console.error('Google sign-in failed', err);
    res.status(401).json({ error: 'Google sign-in failed — the token could not be verified' });
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
    if (user) {
      const code = crypto.randomInt(100000, 1000000).toString(); // 6 digits
      const codeHash = await hashPassword(code);
      const expiresAt = new Date(Date.now() + 10 * 60 * 1000); // 10 minutes
      await db.createPasswordReset({ id: crypto.randomUUID(), userId: user.id, codeHash, expiresAt });

      const messageBody = `Your Verta Delivery Service password reset code is: ${code}\nIt expires in 10 minutes. If you didn't request this, ignore this message.`;

      // Two independent delivery paths — SMS (if a phone is on file)
      // and email (always, since email is the account identifier and
      // is always present, unlike phone — accounts created via Google
      // Sign-In in particular never have a phone number on file at
      // all). Either one succeeding gets the user their code; both are
      // attempted regardless of the other.
      const deliveryAttempts = [];
      if (user.phone) {
        deliveryAttempts.push(
          sendMessage(user.phone, messageBody).then(sent => {
            if (!sent) console.warn(`[forgot-password] Could not deliver reset code by SMS/WhatsApp to ${user.phone} — is Twilio configured? (see server/notify.js)`);
            return sent;
          })
        );
      } else {
        console.warn(`[forgot-password] ${email} has no phone on file — skipping SMS, trying email instead`);
      }
      deliveryAttempts.push(
        sendEmail(email, 'Your Verta Delivery Service password reset code', messageBody).then(sent => {
          if (!sent) console.warn(`[forgot-password] Could not deliver reset code by email to ${email} — is SMTP configured? (see server/notify.js)`);
          return sent;
        })
      );
      const results = await Promise.all(deliveryAttempts);
      if (!results.some(Boolean)) {
        console.warn(`[forgot-password] Neither SMS nor email delivered a reset code to ${email} — check TWILIO_* and SMTP_* environment variables are actually set.`);
      }
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
    const sessionId = await recordLoginHistory(req, freshUser.id);
    const token = signToken(freshUser, sessionId);
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

    const sessionId = await recordLoginHistory(req, admin.id);
    const token = signToken(admin, sessionId);
    res.json({ token, user: { id: admin.id, businessName: admin.businessName, email: admin.email, role: admin.role } });
  } catch (err) {
    console.error('admin-login failed', err);
    res.status(500).json({ error: 'Login failed' });
  }
});

app.get('/api/me', requireAuth, async (req, res) => {
  const user = await db.getUserById(req.user.id);
  if (!user) return res.status(401).json({ error: 'Account no longer exists' });
  res.json({ user: { id: user.id, businessName: user.businessName, email: user.email, phone: user.phone, storeAddress: user.storeAddress, profileImageUrl: user.profileImageUrl, role: user.role, approvalStatus: user.approvalStatus } });
});

// Self-service profile edit — any authenticated user updating their own
// name/phone (customer, vendor, admin, or super admin). Email and
// password stay on their existing separate flows.
app.put('/api/me/profile', requireAuth, async (req, res) => {
  const { businessName, phone, storeAddress } = req.body || {};
  if (!businessName || !businessName.trim()) {
    return res.status(400).json({ error: 'Name cannot be empty' });
  }
  try {
    const updated = await db.updateUserProfile(req.user.id, {
      businessName: businessName.trim(),
      phone: phone ? phone.trim() : null,
      storeAddress: req.user.role === 'vendor' && storeAddress !== undefined ? (storeAddress.trim() || null) : undefined,
    });
    res.json({ user: { id: updated.id, businessName: updated.businessName, email: updated.email, phone: updated.phone, storeAddress: updated.storeAddress, role: updated.role } });
  } catch (err) {
    console.error('PUT /api/me/profile failed', err);
    res.status(500).json({ error: 'Failed to update profile' });
  }
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

const MAX_PROFILE_IMAGE_BYTES = 700 * 1024; // same reasoning as the logo above

// Real profile photo upload — any authenticated role, always the
// caller's own account (never takes a target user id in the URL).
app.put('/api/me/profile-image', requireAuth, async (req, res) => {
  const { imageDataUrl } = req.body || {};
  if (imageDataUrl && imageDataUrl.length > MAX_PROFILE_IMAGE_BYTES) {
    return res.status(400).json({ error: 'Image is too large — please use one under ~500KB.' });
  }
  try {
    const updated = await db.updateProfileImage(req.user.id, imageDataUrl || null);
    res.json({
      user: {
        id: updated.id, businessName: updated.businessName, email: updated.email, phone: updated.phone,
        storeAddress: updated.storeAddress, profileImageUrl: updated.profileImageUrl,
        role: updated.role, approvalStatus: updated.approvalStatus,
      },
    });
  } catch (err) {
    console.error('PUT /api/me/profile-image failed', err);
    res.status(500).json({ error: 'Failed to update profile image' });
  }
});

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

// Real per-device revoke — ends exactly one session (identified by its
// login_history row id), unlike "Logout All Devices" below which ends
// every session at once. Ownership-checked in db.revokeSession, so this
// can only revoke a session that's actually yours.
app.post('/api/admin/login-history/:id/revoke', requireAuth, requireAdmin, async (req, res) => {
  try {
    const revoked = await db.revokeSession(req.params.id, req.user.id);
    if (!revoked) return res.status(404).json({ error: 'Session not found, not yours, or already signed out' });
    res.json({ ok: true });
  } catch (err) {
    console.error('POST /api/admin/login-history/:id/revoke failed', err);
    res.status(500).json({ error: 'Failed to revoke session' });
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

// Restore — dry-run validation only, changes nothing. Real execution is
// a separate, explicit second step (see below).
app.post('/api/admin/restore/validate', requireAuth, requireAdmin, async (req, res) => {
  try {
    const result = await db.validateRestorePayload(req.body);
    res.json(result);
  } catch (err) {
    console.error('POST /api/admin/restore/validate failed', err);
    res.status(500).json({ error: 'Failed to validate the file' });
  }
});

// Restore — actually applies it. Re-validates from scratch server-side
// (never trusts that the client's earlier /validate call is still
// accurate) before touching anything.
app.post('/api/admin/restore/execute', requireAuth, requireAdmin, async (req, res) => {
  try {
    const validation = await db.validateRestorePayload(req.body);
    if (!validation.valid) {
      return res.status(400).json({ error: validation.errors.join(' ') });
    }
    const result = await db.restoreFromExport(req.body);
    console.log(`[restore] ${req.user.email} restored ${result.ordersRestored} orders, ${result.expensesRestored} expenses, ${result.agentsRestored} agents`);
    res.json({ ok: true, ...result });
  } catch (err) {
    console.error('POST /api/admin/restore/execute failed', err);
    res.status(500).json({ error: 'Restore failed — no changes were made (the whole operation is one transaction, so a failure partway through rolls back completely).' });
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

// Super Admin creating a customer account directly — same reasoning
// as Add Vendor: no documents needed, immediately usable, useful for
// onboarding someone (e.g. over the phone) without making them
// self-register.
app.post('/api/super-admin/customers', requireAuth, requireSuperAdmin, async (req, res) => {
  const { businessName, email, phone, password } = req.body || {};
  if (!businessName || !email || !password) {
    return res.status(400).json({ error: 'Name, email, and password are required' });
  }
  if (password.length < 8) {
    return res.status(400).json({ error: 'Password must be at least 8 characters' });
  }
  try {
    const existing = await db.getUserByEmail(email);
    if (existing) return res.status(409).json({ error: 'An account with that email already exists' });

    const passwordHash = await hashPassword(password);
    const customer = await db.createUser({
      id: crypto.randomUUID(),
      businessName,
      email,
      phone: phone || null,
      passwordHash,
      role: 'sender',
    });
    res.json({ customer });
  } catch (err) {
    console.error('POST /api/super-admin/customers failed', err);
    res.status(500).json({ error: 'Failed to create customer' });
  }
});

app.put('/api/super-admin/customers/:id', requireAuth, requireSuperAdmin, async (req, res) => {
  const { businessName, email, phone } = req.body || {};
  if (!businessName || !email) {
    return res.status(400).json({ error: 'Name and email are required' });
  }
  try {
    const existing = await db.getUserByEmail(email);
    if (existing && existing.id !== req.params.id) {
      return res.status(409).json({ error: 'Another account already uses that email' });
    }
    const updated = await db.updateCustomerByAdmin(req.params.id, { businessName, email, phone });
    if (!updated) return res.status(404).json({ error: 'Customer not found' });
    res.json({ customer: updated });
  } catch (err) {
    console.error('PUT /api/super-admin/customers/:id failed', err);
    res.status(500).json({ error: 'Failed to update customer' });
  }
});

// Real, irreversible delete — cascades to the customer's entire order
// and purchase history. requireSuperAdmin only; the frontend requires
// a typed confirmation before ever calling this.
app.delete('/api/super-admin/customers/:id', requireAuth, requireSuperAdmin, async (req, res) => {
  try {
    const deleted = await db.deleteCustomer(req.params.id);
    if (!deleted) return res.status(404).json({ error: 'Customer not found' });
    res.json({ ok: true });
  } catch (err) {
    console.error('DELETE /api/super-admin/customers/:id failed', err);
    res.status(500).json({ error: 'Failed to delete customer' });
  }
});

// A real, deliberately separate action from the general edit endpoint
// above — resetting someone's password is more sensitive than
// updating their name/phone, so it gets its own explicit confirmation
// step on the frontend rather than being bundled into casual editing.
app.put('/api/super-admin/customers/:id/password', requireAuth, requireSuperAdmin, async (req, res) => {
  const { password } = req.body || {};
  if (!password || password.length < 8) {
    return res.status(400).json({ error: 'Password must be at least 8 characters' });
  }
  try {
    const target = await db.getUserById(req.params.id);
    if (!target || target.role !== 'sender') return res.status(404).json({ error: 'Customer not found' });
    const passwordHash = await hashPassword(password);
    await db.updateUserPassword(req.params.id, passwordHash);
    res.json({ ok: true });
  } catch (err) {
    console.error('PUT /api/super-admin/customers/:id/password failed', err);
    res.status(500).json({ error: 'Failed to reset password' });
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
    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    const newCustomersLast7Days = customers.filter(c => new Date(c.createdAt) >= sevenDaysAgo).length;
    res.json({
      vendorCounts: {
        total: vendors.length,
        approved: vendors.filter(v => v.approvalStatus === 'approved').length,
        pending: vendors.filter(v => v.approvalStatus === 'pending').length,
        rejected: vendors.filter(v => v.approvalStatus === 'rejected').length,
      },
      totalCustomers: customers.length,
      newCustomersLast7Days,
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

// Super Admin creating a vendor account directly — no business/ID
// documents required, unlike public self-registration, since the
// Super Admin creating this account IS the approval. Skips the
// pending-review queue entirely.
app.post('/api/super-admin/vendors', requireAuth, requireSuperAdmin, async (req, res) => {
  const { businessName, email, phone, password } = req.body || {};
  if (!businessName || !email || !password) {
    return res.status(400).json({ error: 'Business name, email, and password are required' });
  }
  if (password.length < 8) {
    return res.status(400).json({ error: 'Password must be at least 8 characters' });
  }
  try {
    const existing = await db.getUserByEmail(email);
    if (existing) return res.status(409).json({ error: 'An account with that email already exists' });

    const passwordHash = await hashPassword(password);
    const vendor = await db.createUser({
      id: crypto.randomUUID(),
      businessName,
      email,
      phone: phone || null,
      passwordHash,
      role: 'vendor',
      approvalStatus: 'approved',
    });
    res.json({ vendor });
  } catch (err) {
    console.error('POST /api/super-admin/vendors failed', err);
    res.status(500).json({ error: 'Failed to create vendor' });
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

// Delivery Companies — Super Admin oversight, mirroring the Vendors
// endpoints above exactly.
app.get('/api/super-admin/delivery-companies', requireAuth, requireSuperAdmin, async (req, res) => {
  try {
    const deliveryCompanies = await db.getDeliveryCompanies();
    res.json({ deliveryCompanies });
  } catch (err) {
    console.error('GET /api/super-admin/delivery-companies failed', err);
    res.status(500).json({ error: 'Failed to load delivery companies' });
  }
});

app.get('/api/super-admin/delivery-companies/:id/documents', requireAuth, requireSuperAdmin, async (req, res) => {
  try {
    const docs = await db.getDeliveryCompanyApplicationDocuments(req.params.id);
    if (!docs) return res.status(404).json({ error: 'Delivery company not found' });
    res.json(docs);
  } catch (err) {
    console.error('GET delivery company documents failed', err);
    res.status(500).json({ error: 'Failed to load documents' });
  }
});

app.post('/api/super-admin/delivery-companies/:id/approve', requireAuth, requireSuperAdmin, async (req, res) => {
  try {
    const company = await db.setDeliveryCompanyApprovalStatus(req.params.id, 'approved');
    if (!company) return res.status(404).json({ error: 'Delivery company not found' });
    res.json({ ok: true, deliveryCompany: { id: company.id, businessName: company.businessName, approvalStatus: company.approvalStatus } });
  } catch (err) {
    console.error('POST delivery company approve failed', err);
    res.status(500).json({ error: 'Failed to approve delivery company' });
  }
});

app.post('/api/super-admin/delivery-companies/:id/reject', requireAuth, requireSuperAdmin, async (req, res) => {
  try {
    const company = await db.setDeliveryCompanyApprovalStatus(req.params.id, 'rejected');
    if (!company) return res.status(404).json({ error: 'Delivery company not found' });
    res.json({ ok: true, deliveryCompany: { id: company.id, businessName: company.businessName, approvalStatus: company.approvalStatus } });
  } catch (err) {
    console.error('POST delivery company reject failed', err);
    res.status(500).json({ error: 'Failed to reject delivery company' });
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

// ============================================================
// Promotions — a vendor puts one of their own products on sale for a
// percentage off, for a real date range. The discount is enforced at
// checkout (see db.checkout) — this isn't just cosmetic pricing.
// ============================================================
app.get('/api/vendor/promotions', requireAuth, requireVendor, async (req, res) => {
  try {
    const promotions = await db.getVendorPromotions(req.user.id);
    res.json({ promotions });
  } catch (err) {
    console.error('GET /api/vendor/promotions failed', err);
    res.status(500).json({ error: 'Failed to load promotions' });
  }
});

app.post('/api/vendor/promotions', requireAuth, requireVendor, async (req, res) => {
  const { productId, discountPercent, startsAt, endsAt } = req.body || {};
  const discount = Number(discountPercent);
  if (!productId || !discount || discount <= 0 || discount > 90) {
    return res.status(400).json({ error: 'A product and a discount between 1 and 90 percent are required' });
  }
  if (!endsAt || new Date(endsAt) <= new Date()) {
    return res.status(400).json({ error: 'End date must be in the future' });
  }
  try {
    const product = await db.getProductById(productId);
    if (!product || product.vendorId !== req.user.id) {
      return res.status(404).json({ error: 'Product not found in your store' });
    }
    const promotion = await db.createPromotion({
      id: crypto.randomUUID(), vendorId: req.user.id, productId,
      discountPercent: discount, startsAt: startsAt ? new Date(startsAt) : new Date(), endsAt: new Date(endsAt),
    });
    res.json({ promotion });
  } catch (err) {
    console.error('POST /api/vendor/promotions failed', err);
    res.status(400).json({ error: err.message || 'Failed to create promotion' });
  }
});

app.delete('/api/vendor/promotions/:id', requireAuth, requireVendor, async (req, res) => {
  try {
    const deleted = await db.deletePromotion(req.params.id, req.user.id);
    if (!deleted) return res.status(404).json({ error: 'Promotion not found' });
    res.json({ ok: true });
  } catch (err) {
    console.error('DELETE /api/vendor/promotions/:id failed', err);
    res.status(500).json({ error: 'Failed to end promotion' });
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

// ============================================================
// Delivery Company (multi-provider) — a company's own dashboard.
// Every route below is scoped to req.user.id, mirroring the vendor
// pattern: a company can only ever see and manage its own fleet and
// orders, never another company's.
// ============================================================
app.get('/api/delivery-company/agents', requireAuth, requireDeliveryCompany, async (req, res) => {
  try {
    const agents = await db.getAgentsByCompany(req.user.id);
    res.json({ agents });
  } catch (err) {
    console.error('GET /api/delivery-company/agents failed', err);
    res.status(500).json({ error: 'Failed to load fleet' });
  }
});

app.get('/api/delivery-company/orders', requireAuth, requireDeliveryCompany, async (req, res) => {
  try {
    const orders = await db.getOrdersByCompany(req.user.id);
    res.json({ orders });
  } catch (err) {
    console.error('GET /api/delivery-company/orders failed', err);
    res.status(500).json({ error: 'Failed to load orders' });
  }
});

app.get('/api/delivery-company/overview', requireAuth, requireDeliveryCompany, async (req, res) => {
  try {
    const [agents, orders] = await Promise.all([
      db.getAgentsByCompany(req.user.id),
      db.getOrdersByCompany(req.user.id),
    ]);
    const deliveredOrders = orders.filter(o => o.status === 'delivered');
    res.json({
      totalAgents: agents.length,
      onDutyAgents: agents.filter(a => a.dutyStatus === 'on_duty').length,
      totalOrders: orders.length,
      deliveredOrders: deliveredOrders.length,
      totalRevenue: deliveredOrders.reduce((sum, o) => sum + (o.amount || 0), 0),
    });
  } catch (err) {
    console.error('GET /api/delivery-company/overview failed', err);
    res.status(500).json({ error: 'Failed to load overview' });
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

// Real customer-facing purchase history — what a customer actually
// bought on the marketplace, with real product images and real
// delivery status, distinct from the Delivery-side raw order list.
app.get('/api/marketplace/my-purchases', requireAuth, async (req, res) => {
  if (req.user.role !== 'sender') return res.status(403).json({ error: 'Only customers have purchase history' });
  try {
    const purchases = await db.getPurchasesByCustomer(req.user.id);
    res.json({ purchases });
  } catch (err) {
    console.error('GET /api/marketplace/my-purchases failed', err);
    res.status(500).json({ error: 'Failed to load purchase history' });
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

// Public — real active deals feed (products with a currently-active
// promotion). No fake discounts here; if nothing's on sale, it's empty.
app.get('/api/marketplace/deals', async (req, res) => {
  try {
    const products = await db.getActiveDeals();
    res.json({ products });
  } catch (err) {
    console.error('GET /api/marketplace/deals failed', err);
    res.status(500).json({ error: 'Failed to load deals' });
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

// ============================================================
// Wishlist — real, customer-only (senders). Vendors previewing the
// marketplace "as customer" don't get a wishlist of their own here,
// same restriction as leaving a review.
// ============================================================
app.get('/api/wishlist', requireAuth, async (req, res) => {
  if (req.user.role !== 'sender') return res.status(403).json({ error: 'Only customers have a wishlist' });
  try {
    const products = await db.getWishlist(req.user.id);
    res.json({ products });
  } catch (err) {
    console.error('GET /api/wishlist failed', err);
    res.status(500).json({ error: 'Failed to load wishlist' });
  }
});

// Just the ids — cheap enough to fetch once when the marketplace loads
// so every product card/PDP can show the right heart state.
app.get('/api/wishlist/ids', requireAuth, async (req, res) => {
  if (req.user.role !== 'sender') return res.json({ productIds: [] });
  try {
    const productIds = await db.getWishlistProductIds(req.user.id);
    res.json({ productIds });
  } catch (err) {
    console.error('GET /api/wishlist/ids failed', err);
    res.status(500).json({ error: 'Failed to load wishlist' });
  }
});

app.post('/api/wishlist/:productId', requireAuth, async (req, res) => {
  if (req.user.role !== 'sender') return res.status(403).json({ error: 'Only customers have a wishlist' });
  try {
    await db.addToWishlist(req.user.id, req.params.productId);
    res.json({ ok: true });
  } catch (err) {
    console.error('POST /api/wishlist failed', err);
    res.status(500).json({ error: 'Failed to add to wishlist' });
  }
});

app.delete('/api/wishlist/:productId', requireAuth, async (req, res) => {
  if (req.user.role !== 'sender') return res.status(403).json({ error: 'Only customers have a wishlist' });
  try {
    await db.removeFromWishlist(req.user.id, req.params.productId);
    res.json({ ok: true });
  } catch (err) {
    console.error('DELETE /api/wishlist failed', err);
    res.status(500).json({ error: 'Failed to remove from wishlist' });
  }
});

// ============================================================
// Leads — real high-intent buyer interaction tracking, matching the
// schema: PHONE_CLICK / MESSAGE_SENT / QUOTE_REQUEST / CHECKOUT_STARTED,
// with NEW / CONTACTED / CONVERTED / ARCHIVED status. MESSAGE_SENT is
// logged directly inside POST /api/conversations above (only on
// genuine first contact, not every reply) — the two endpoints below
// cover the other real trigger points.
// ============================================================

// CHECKOUT_STARTED — fired when a customer opens the checkout modal,
// "even if abandoned" per the spec: this logs intent, independent of
// whether POST /api/marketplace/checkout ever actually completes.
app.post('/api/leads/checkout-started', requireAuth, async (req, res) => {
  if (req.user.role !== 'sender') return res.status(403).json({ error: 'Only customers trigger this' });
  const { vendorId, productId } = req.body || {};
  if (!vendorId) return res.status(400).json({ error: 'vendorId is required' });
  try {
    await db.createLead({ id: crypto.randomUUID(), vendorId, buyerId: req.user.id, productId: productId || null, type: 'CHECKOUT_STARTED' });
    res.json({ ok: true });
  } catch (err) {
    console.error('POST /api/leads/checkout-started failed', err);
    res.status(500).json({ error: 'Failed to log lead' });
  }
});

// PHONE_CLICK — reveals a vendor's real phone number. Deliberately
// public: viewing contact info shouldn't require an account, so a
// guest lead (buyerId: null) is a real, expected case here, not an
// error condition — matching the schema's nullable buyer_id.
app.get('/api/vendors/:id/contact', async (req, res) => {
  try {
    const vendor = await db.getUserById(req.params.id);
    if (!vendor || vendor.role !== 'vendor') return res.status(404).json({ error: 'Vendor not found' });
    if (!vendor.phone) return res.status(404).json({ error: "This vendor hasn't added a phone number yet" });

    let buyerId = null;
    const header = req.headers.authorization || '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : null;
    if (token) {
      try {
        const payload = verifyToken(token);
        if (payload.role === 'sender') buyerId = payload.id;
      } catch (err) { /* guest, or an expired/invalid token — still allow viewing contact info */ }
    }
    await db.createLead({
      id: crypto.randomUUID(), vendorId: vendor.id, buyerId, productId: req.query.productId || null, type: 'PHONE_CLICK',
    });
    res.json({ phone: vendor.phone, businessName: vendor.businessName });
  } catch (err) {
    console.error('GET /api/vendors/:id/contact failed', err);
    res.status(500).json({ error: 'Failed to load vendor contact info' });
  }
});

app.get('/api/vendor/leads', requireAuth, requireVendor, async (req, res) => {
  try {
    const [leads, summary] = await Promise.all([
      db.getVendorLeads(req.user.id),
      db.getVendorLeadsSummary(req.user.id),
    ]);
    res.json({ leads, summary });
  } catch (err) {
    console.error('GET /api/vendor/leads failed', err);
    res.status(500).json({ error: 'Failed to load leads' });
  }
});

app.patch('/api/vendor/leads/:id/status', requireAuth, requireVendor, async (req, res) => {
  const { status } = req.body || {};
  if (!['NEW', 'CONTACTED', 'CONVERTED', 'ARCHIVED'].includes(status)) {
    return res.status(400).json({ error: 'Invalid status' });
  }
  try {
    const updated = await db.updateLeadStatus(req.params.id, req.user.id, status);
    if (!updated) return res.status(404).json({ error: 'Lead not found' });
    res.json({ ok: true, lead: updated });
  } catch (err) {
    console.error('PATCH /api/vendor/leads/:id/status failed', err);
    res.status(500).json({ error: 'Failed to update lead status' });
  }
});

// ---- Store Follows (mirrors the wishlist endpoints, for stores) ----
app.get('/api/store-follows/ids', requireAuth, async (req, res) => {
  if (req.user.role !== 'sender') return res.json({ vendorIds: [] });
  try {
    const vendorIds = await db.getFollowedStoreIds(req.user.id);
    res.json({ vendorIds });
  } catch (err) {
    console.error('GET /api/store-follows/ids failed', err);
    res.status(500).json({ error: 'Failed to load followed stores' });
  }
});

app.post('/api/store-follows/:vendorId', requireAuth, async (req, res) => {
  if (req.user.role !== 'sender') return res.status(403).json({ error: 'Only customers can follow stores' });
  try {
    await db.followStore(req.user.id, req.params.vendorId);
    res.json({ ok: true });
  } catch (err) {
    console.error('POST /api/store-follows failed', err);
    res.status(500).json({ error: 'Failed to follow store' });
  }
});

app.delete('/api/store-follows/:vendorId', requireAuth, async (req, res) => {
  if (req.user.role !== 'sender') return res.status(403).json({ error: 'Only customers can follow stores' });
  try {
    await db.unfollowStore(req.user.id, req.params.vendorId);
    res.json({ ok: true });
  } catch (err) {
    console.error('DELETE /api/store-follows failed', err);
    res.status(500).json({ error: 'Failed to unfollow store' });
  }
});

// ============================================================
// Saved Addresses — real, customer-only. Same restriction pattern as
// the wishlist and reviews above.
// ============================================================
app.get('/api/addresses', requireAuth, async (req, res) => {
  if (req.user.role !== 'sender') return res.status(403).json({ error: 'Only customers have saved addresses' });
  try {
    const addresses = await db.getSavedAddresses(req.user.id);
    res.json({ addresses });
  } catch (err) {
    console.error('GET /api/addresses failed', err);
    res.status(500).json({ error: 'Failed to load addresses' });
  }
});

app.post('/api/addresses', requireAuth, async (req, res) => {
  if (req.user.role !== 'sender') return res.status(403).json({ error: 'Only customers have saved addresses' });
  const { label, address, isDefault } = req.body || {};
  if (!label || !label.trim() || !address || !address.trim()) {
    return res.status(400).json({ error: 'Label and address are both required' });
  }
  try {
    const saved = await db.createSavedAddress({
      id: crypto.randomUUID(), customerId: req.user.id, label: label.trim(), address: address.trim(), isDefault,
    });
    res.json({ address: saved });
  } catch (err) {
    console.error('POST /api/addresses failed', err);
    res.status(500).json({ error: 'Failed to save address' });
  }
});

app.put('/api/addresses/:id', requireAuth, async (req, res) => {
  if (req.user.role !== 'sender') return res.status(403).json({ error: 'Only customers have saved addresses' });
  const { label, address, isDefault } = req.body || {};
  if (!label || !label.trim() || !address || !address.trim()) {
    return res.status(400).json({ error: 'Label and address are both required' });
  }
  try {
    const updated = await db.updateSavedAddress(req.params.id, req.user.id, { label: label.trim(), address: address.trim(), isDefault });
    if (!updated) return res.status(404).json({ error: 'Address not found' });
    res.json({ address: updated });
  } catch (err) {
    console.error('PUT /api/addresses/:id failed', err);
    res.status(500).json({ error: 'Failed to update address' });
  }
});

app.delete('/api/addresses/:id', requireAuth, async (req, res) => {
  if (req.user.role !== 'sender') return res.status(403).json({ error: 'Only customers have saved addresses' });
  try {
    const deleted = await db.deleteSavedAddress(req.params.id, req.user.id);
    if (!deleted) return res.status(404).json({ error: 'Address not found' });
    res.json({ ok: true });
  } catch (err) {
    console.error('DELETE /api/addresses/:id failed', err);
    res.status(500).json({ error: 'Failed to delete address' });
  }
});

// ============================================================
// Messages — real in-app messaging between a customer and a vendor.
// Works for both roles: a customer sees their conversations with
// vendors, a vendor sees their conversations with customers. Delivered
// live over Socket.io to both participants' existing rooms
// (`user:<id>` / `vendor:<id>`, same rooms used for order updates).
// ============================================================
app.get('/api/conversations', requireAuth, async (req, res) => {
  if (req.user.role !== 'sender' && req.user.role !== 'vendor') {
    return res.status(403).json({ error: 'Messaging is only available to customers and vendors' });
  }
  try {
    const conversations = await db.getConversationsForUser(req.user.id, req.user.role);
    res.json({ conversations });
  } catch (err) {
    console.error('GET /api/conversations failed', err);
    res.status(500).json({ error: 'Failed to load conversations' });
  }
});

// Customer-initiated only — a customer starts a conversation with a
// vendor (e.g. from a product page); a vendor replies within it rather
// than starting new ones with customers who haven't reached out.
app.post('/api/conversations', requireAuth, async (req, res) => {
  if (req.user.role !== 'sender') return res.status(403).json({ error: 'Only customers can start a conversation' });
  const { vendorId, productId } = req.body || {};
  if (!vendorId) return res.status(400).json({ error: 'vendorId is required' });
  try {
    const vendor = await db.getUserById(vendorId);
    if (!vendor || vendor.role !== 'vendor') return res.status(404).json({ error: 'Vendor not found' });
    const { conversation, wasCreated } = await db.getOrCreateConversation(req.user.id, vendorId);
    if (wasCreated) {
      // A real lead — genuine first contact with this vendor, not
      // logged again for every reply within the same conversation.
      await db.createLead({
        id: crypto.randomUUID(), vendorId, buyerId: req.user.id, productId: productId || null, type: 'MESSAGE_SENT',
      });
    }
    res.json({ conversationId: conversation.id, vendorName: vendor.businessName });
  } catch (err) {
    console.error('POST /api/conversations failed', err);
    res.status(500).json({ error: 'Failed to start conversation' });
  }
});

app.get('/api/conversations/:id/messages', requireAuth, async (req, res) => {
  try {
    const conversation = await db.getConversationById(req.params.id);
    if (!conversation) return res.status(404).json({ error: 'Conversation not found' });
    if (conversation.customer_id !== req.user.id && conversation.vendor_id !== req.user.id) {
      return res.status(403).json({ error: 'Not your conversation' });
    }
    const messages = await db.getConversationMessages(req.params.id);
    await db.markConversationRead(req.params.id, req.user.id);
    res.json({ messages });
  } catch (err) {
    console.error('GET /api/conversations/:id/messages failed', err);
    res.status(500).json({ error: 'Failed to load messages' });
  }
});

app.post('/api/conversations/:id/messages', requireAuth, async (req, res) => {
  const { body } = req.body || {};
  if (!body || !body.trim()) return res.status(400).json({ error: 'Message cannot be empty' });
  try {
    const conversation = await db.getConversationById(req.params.id);
    if (!conversation) return res.status(404).json({ error: 'Conversation not found' });
    if (conversation.customer_id !== req.user.id && conversation.vendor_id !== req.user.id) {
      return res.status(403).json({ error: 'Not your conversation' });
    }
    const message = await db.sendMessageToConversation({
      id: crypto.randomUUID(), conversationId: req.params.id, senderId: req.user.id, body: body.trim(),
    });
    // Real-time delivery to both participants — whichever one didn't
    // just send this gets it live; the sender's own other devices/tabs
    // get it too, same pattern as every other realtime event here.
    io.to(`user:${conversation.customer_id}`).to(`vendor:${conversation.vendor_id}`).emit('message:new', {
      conversationId: req.params.id, message,
    });
    res.json({ message });
  } catch (err) {
    console.error('POST /api/conversations/:id/messages failed', err);
    res.status(500).json({ error: 'Failed to send message' });
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

// Backward compatibility for the new multi-provider delivery system:
// every agent that existed before this feature (or was added without
// an explicit company) gets linked to the primary admin account —
// Verta Delivery Service's own fleet becomes company #1 in a system
// that now supports more than one, rather than a special case that
// works differently from every company added after it. Safe to run
// on every boot: only touches agents that don't already have a
// delivery_company_id set.
async function migrateAgentsToDeliveryCompany() {
  const admin = await db.getUserByEmail(ADMIN_EMAIL);
  if (!admin) return; // shouldn't happen — seedAdminIfConfigured runs first
  const linkedCount = await db.linkOrphanedAgentsToCompany(admin.id);
  if (linkedCount > 0) {
    console.log(`[migrate] Linked ${linkedCount} existing agent(s) to Verta Delivery Service (${ADMIN_EMAIL}) as their delivery company.`);
  }
}

db.init()
  .then(seedAdminIfConfigured)
  .then(seedSuperAdminIfConfigured)
  .then(seedVendorIfConfigured)
  .then(seedAgentsIfEmpty)
  .then(migrateAgentsToDeliveryCompany)
  .then(() => {
    server.listen(PORT, () => console.log(`Verta Delivery server listening on :${PORT}`));
  })
  .catch((err) => {
    console.error('Failed to initialize database', err);
    process.exit(1);
  });
