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

// Granular, per-account feature permissions — Super Admin cutting off
// specific capabilities for a Manage Agent account. This is the
// authoritative list of what can be toggled; deliberately excludes
// personal account security (own password/email/login history), which
// stays available no matter what — see the schema.sql comment on
// disabled_features for the full reasoning.
const FEATURE_KEYS = {
  new_order: 'Create New Order (on behalf of a customer)',
  order_actions: 'Accept, update, and cancel orders',
  fleet: 'Fleet Directory (add/edit agents, duty status)',
  expenses: 'Expenses',
  price_presets: 'Price Presets',
  customers: 'Customers panel',
  business_settings: 'Business Profile settings (logo, hours, currency)',
  backup_restore: 'Export & Backup/Restore Database',
};

// REST middleware version — checked fresh against the database on
// every request (not cached in the JWT), so a Super Admin's change
// takes effect immediately, the same principle as is_disabled/
// token_version elsewhere in this file. super_admin is always exempt
// — these restrictions only ever apply to role = 'admin'.
function requireFeature(featureKey) {
  return async (req, res, next) => {
    if (req.user.role === 'super_admin') return next();
    try {
      const disabled = await db.isFeatureDisabledForUser(req.user.id, featureKey);
      if (disabled) {
        return res.status(403).json({ error: `This feature has been turned off for your account by a Super Admin: ${FEATURE_KEYS[featureKey] || featureKey}` });
      }
      next();
    } catch (err) {
      console.error('requireFeature check failed', err);
      res.status(500).json({ error: 'Failed to verify permissions' });
    }
  };
}

// Socket.io version — same check, callable inline inside a handler
// since Socket.io events don't support Express-style middleware chains.
async function checkFeatureEnabled(user, featureKey) {
  if (user.role === 'super_admin') return true;
  return !(await db.isFeatureDisabledForUser(user.id, featureKey));
}

// Append-only audit trail for Super Admin actions. Best-effort by
// design: a logging failure must never block or roll back the action
// it's describing, so failures are swallowed here (after being logged
// server-side) rather than surfaced to the caller. req.user comes from
// the verified JWT payload (see auth.js signToken) and already carries
// id/role/businessName/email, so no extra DB lookup is needed just to
// know who did this.
async function logAudit(req, action, { targetType, targetId, targetLabel, details } = {}) {
  try {
    await db.createAuditLogEntry({
      id: crypto.randomUUID(),
      actorId: req.user?.id || null,
      actorName: req.user?.businessName || req.user?.email || 'Unknown',
      actorRole: req.user?.role || 'unknown',
      action,
      targetType: targetType || null,
      targetId: targetId || null,
      targetLabel: targetLabel || null,
      details: details || {},
    });
  } catch (err) {
    console.error(`logAudit failed for action "${action}"`, err);
  }
}

// Sign in with Google — optional, same graceful-degradation pattern as
// Twilio below. Unset means the feature simply isn't available yet;
// nothing else in the app depends on it.
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || '';
const googleClient = GOOGLE_CLIENT_ID ? new OAuth2Client(GOOGLE_CLIENT_ID) : null;

// The admin side keeps a single shared password (as in the original app),
// rather than per-admin email+password — set ADMIN_PASSWORD in Railway's
// Variables tab to change it. Defaults to "1Nigeria@" so the app works
// out of the box without any env config.
// ONLib rebrand: Manage Agent is now ONLib's own operational account,
// not Verta's — Verta operates as an ordinary delivery_company account
// with no special access, same as any other company. LEGACY_ADMIN_EMAIL
// is kept around specifically so the one-time migration below can find
// and rename the existing account rather than create a duplicate.
const LEGACY_ADMIN_EMAIL = 'admin@vertadelivery.com';
const DEFAULT_ADMIN_EMAIL = 'onlib231@gmail.com';
const ADMIN_EMAIL = process.env.ADMIN_EMAIL || DEFAULT_ADMIN_EMAIL;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '1Nigeria@';

// Verta's own delivery_company account — reuses ADMIN_PASSWORD's
// default password for consistency, but a genuinely distinct email
// from Manage Agent's, so it can be created immediately with no
// rename dependency.
const VERTA_DC_EMAIL = process.env.VERTA_DC_EMAIL || 'verta.dc@vertadelivery.com';
const VERTA_DC_PASSWORD = process.env.VERTA_DC_PASSWORD || '1Nigeria@';

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
app.use(express.static(path.join(__dirname, '..', 'public'), {
  setHeaders: (res, filePath) => {
    // This whole client is one HTML file (index.html) with the entire
    // app inline in a single <script> block — there's no separate
    // bundled JS file that changes version on each deploy. Left to
    // express.static's normal caching, browsers and any CDN/reverse
    // proxy in front of this app are free to keep serving a stale
    // index.html indefinitely (only revalidating occasionally), which
    // makes every deployed fix invisible until someone happens to hard
    // -refresh. sw.js has the same problem for the same reason — it's
    // what controls whether the service worker itself re-checks for
    // updates. Force both to always be revalidated with the server.
    // Every other static asset (images, manifest.json, etc.) keeps the
    // normal caching behavior, which is fine since none of those
    // change without an accompanying index.html change anyway.
    if (filePath.endsWith('index.html') || filePath.endsWith('sw.js')) {
      res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    }
  },
}));

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
//   - Every delivery_company socket joins TWO rooms: `pending-orders` (a
//     shared pool, deliberately not company-scoped, so every approved
//     company gets real-time visibility into new, unassigned orders any of
//     them could accept) AND its own `delivery-company:<their id>` room —
//     a real per-tenant room, the same idea as `vendor:<id>` below.
//     Previously `pending-orders` was the ONLY room a delivery-company
//     socket ever joined, so once an order was accepted by one company,
//     every further update to it (amount, agent, payment method, admin
//     edits) still broadcast to `pending-orders` and therefore leaked to
//     every OTHER company too — not just the one that accepted it. Adding
//     the per-company room and having orderRooms() below switch to it once
//     an order is claimed closes that leak.
// orderRooms(order) picks the right room set for THIS order's current
// state: still-pending/unclaimed orders (no deliveryCompanyId yet)
// broadcast to the whole `pending-orders` pool, since any company might
// accept them; once claimed, only that one company's own room gets
// further updates.
function orderRooms(order) {
  const rooms = [`user:${order.senderId}`, 'admins'];
  rooms.push(order.deliveryCompanyId ? `delivery-company:${order.deliveryCompanyId}` : 'pending-orders');
  return rooms;
}

io.on('connection', (socket) => {
  const room = isAdminLike(socket.user.role)
    ? 'admins'
    : socket.user.role === 'vendor'
      ? `vendor:${socket.user.id}`
      : `user:${socket.user.id}`;
  socket.join(room);
  if (socket.user.role === 'delivery_company') {
    socket.join('pending-orders');
    socket.join(`delivery-company:${socket.user.id}`);
  }
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
    // Maintenance mode pauses new order creation platform-wide — super
    // admin stays exempt, since they're the only role that can turn it
    // back off and may need to place/test an order while it's on.
    if (socket.user.role !== 'super_admin') {
      const platformSettings = await db.getPlatformSettings();
      if (platformSettings.maintenanceMode) {
        return ack && ack({ ok: false, error: platformSettings.maintenanceMessage || 'New orders are temporarily paused for maintenance. Please try again shortly.' });
      }
    }
    try {
      let senderId = socket.user.id;
      let senderName = socket.user.businessName;
      if (isAdmin) {
        if (!(await checkFeatureEnabled(socket.user, 'new_order'))) {
          return ack && ack({ ok: false, error: `This feature has been turned off for your account by a Super Admin: ${FEATURE_KEYS.new_order}` });
        }
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
        // Date.now() alone is NOT safe as a unique ID source — it has
        // only millisecond resolution, so two requests landing in the
        // same millisecond (a double-click, a rapid resubmit) would
        // generate the exact same order ID. Appending a short random
        // suffix makes a collision astronomically unlikely even for
        // genuinely simultaneous requests.
        id: `ORD-${Date.now().toString(36).toUpperCase()}${crypto.randomBytes(2).toString('hex').toUpperCase()}`,
        senderId,
        senderName,
        pickupAddress: payload.pickupAddress,
        dropoffAddress: payload.dropoffAddress,
        itemDescription: payload.itemDescription,
        amount: null,
        status: 'pending',
        placedByAdmin: isAdmin,
      });
      orderRooms(order).forEach((r) => io.to(r).emit('order:created', order));
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
      orderRooms(order).forEach((r) => io.to(r).emit('order:updated', order));
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
    if (!(await checkFeatureEnabled(socket.user, 'order_actions'))) {
      return ack && ack({ ok: false, error: `This feature has been turned off for your account by a Super Admin: ${FEATURE_KEYS.order_actions}` });
    }
    try {
      const order = await db.updateOrder(id, fields);
      orderRooms(order).forEach((r) => io.to(r).emit('order:updated', order));
      ack && ack({ ok: true, order });
    } catch (err) {
      console.error('order:update failed', err);
      ack && ack({ ok: false, error: 'Failed to update order' });
    }
  });

  socket.on('order:accept', async ({ id, amount, agentId, acceptedBy, paymentMethod }, ack) => {
    if (!isAdminLike(socket.user.role) && socket.user.role !== 'delivery_company') {
      return ack && ack({ ok: false, error: 'Only admins can accept orders' });
    }
    if (isAdminLike(socket.user.role) && !(await checkFeatureEnabled(socket.user, 'order_actions'))) {
      return ack && ack({ ok: false, error: `This feature has been turned off for your account by a Super Admin: ${FEATURE_KEYS.order_actions}` });
    }
    try {
      // Prefer a real agent id — the collision-safe lookup — over the
      // legacy name-based one. Agents have no uniqueness constraint on
      // `name` (see schema.sql), so two agents sharing a name, even
      // across two different companies, could previously resolve to the
      // wrong one via getAgentByName()'s unordered `LIMIT 1`: wrongly
      // denying a delivery company's own accept ("not your agent"), or
      // worse, wrongly attributing the order's deliveryCompanyId to
      // someone else's company. acceptedBy (name) is kept ONLY as a
      // fallback for a browser tab still holding pre-fix JS during a
      // rolling deploy; every reloaded client now sends agentId.
      const agent = agentId
        ? await db.getAgentById(agentId)
        : (acceptedBy ? await db.getAgentByName(acceptedBy) : null);
      // A delivery company can only accept using one of its own
      // agents — this is the real check, not just trusting whatever
      // id/name the client sent.
      if (socket.user.role === 'delivery_company') {
        if (!agent || agent.deliveryCompanyId !== socket.user.id) {
          return ack && ack({ ok: false, error: 'That agent does not belong to your company' });
        }
      }
      // accepted_by is stored as a permanent, point-in-time snapshot of
      // the agent's name (see schema.sql) — always derived from the
      // resolved agent now, not trusted verbatim from the client, so a
      // stale/mismatched acceptedBy string can no longer end up on the
      // order. Falls back to the raw client string only in the rare
      // admin case where no agent record matched at all (preserves prior
      // permissiveness for admins, who aren't restricted to real agents).
      const order = await db.acceptOrderAtomic(id, {
        amount,
        acceptedBy: agent ? agent.name : (acceptedBy || 'Unknown'),
        paymentMethod: paymentMethod || null,
        deliveryCompanyId: agent ? agent.deliveryCompanyId : null,
      });
      if (!order) {
        return ack && ack({ ok: false, error: 'This order was already accepted — someone got there first.' });
      }
      orderRooms(order).forEach((r) => io.to(r).emit('order:updated', order));
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
    if (!(await checkFeatureEnabled(socket.user, 'order_actions'))) {
      return ack && ack({ ok: false, error: `This feature has been turned off for your account by a Super Admin: ${FEATURE_KEYS.order_actions}` });
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
    if (!(await checkFeatureEnabled(socket.user, 'expenses'))) {
      return ack && ack({ ok: false, error: `This feature has been turned off for your account by a Super Admin: ${FEATURE_KEYS.expenses}` });
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
    if (!(await checkFeatureEnabled(socket.user, 'expenses'))) {
      return ack && ack({ ok: false, error: `This feature has been turned off for your account by a Super Admin: ${FEATURE_KEYS.expenses}` });
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

  // Agent CRUD previously only ever emitted to `admins` — a delivery
  // company creating/editing/toggling duty status on its OWN agent got
  // no real-time echo of that at all, since delivery-company sockets
  // were never members of `admins` and there was no per-company room to
  // target instead. Now that each delivery-company socket also joins
  // `delivery-company:<their id>` (see the room-strategy comment above),
  // route the same event there too when the agent belongs to one.
  function emitAgentEvent(eventName, agent) {
    io.to('admins').emit(eventName, agent);
    if (agent.deliveryCompanyId) {
      io.to(`delivery-company:${agent.deliveryCompanyId}`).emit(eventName, agent);
    }
  }

  socket.on('agent:create', async ({ name, phone }, ack) => {
    if (!isAdminLike(socket.user.role) && socket.user.role !== 'delivery_company') {
      return ack && ack({ ok: false, error: 'Only admins can add agents' });
    }
    if (isAdminLike(socket.user.role) && !(await checkFeatureEnabled(socket.user, 'fleet'))) {
      return ack && ack({ ok: false, error: `This feature has been turned off for your account by a Super Admin: ${FEATURE_KEYS.fleet}` });
    }
    if (!name || !name.trim() || !phone || !phone.trim()) {
      return ack && ack({ ok: false, error: 'Name and phone are required' });
    }
    try {
      const agent = await db.createAgent({ id: crypto.randomUUID(), name: name.trim(), phone: phone.trim(), deliveryCompanyId: socket.user.id });
      emitAgentEvent('agent:created', agent);
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
    if (isAdminLike(socket.user.role) && !(await checkFeatureEnabled(socket.user, 'fleet'))) {
      return ack && ack({ ok: false, error: `This feature has been turned off for your account by a Super Admin: ${FEATURE_KEYS.fleet}` });
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
      emitAgentEvent('agent:updated', agent);
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
    if (isAdminLike(socket.user.role) && !(await checkFeatureEnabled(socket.user, 'fleet'))) {
      return ack && ack({ ok: false, error: `This feature has been turned off for your account by a Super Admin: ${FEATURE_KEYS.fleet}` });
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
      emitAgentEvent('agent:updated', agent);
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
    res.json({ token, user: { id: user.id, businessName: user.businessName, email: user.email, phone: user.phone, storeAddress: user.storeAddress, profileImageUrl: user.profileImageUrl, role: user.role, approvalStatus: user.approvalStatus, rejectionReason: user.rejectionReason } });
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
      user: { id: user.id, businessName: user.businessName, email: user.email, phone: user.phone, storeAddress: user.storeAddress, profileImageUrl: user.profileImageUrl, role: user.role, approvalStatus: user.approvalStatus, rejectionReason: user.rejectionReason },
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
      user: { id: user.id, businessName: user.businessName, email: user.email, phone: user.phone, storeAddress: user.storeAddress, profileImageUrl: user.profileImageUrl, role: user.role, approvalStatus: user.approvalStatus, rejectionReason: user.rejectionReason },
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
    if (user.isDisabled) return res.status(403).json({ error: 'This account has been disabled. Contact support for help.' });

    const sessionId = await recordLoginHistory(req, user.id);
    const token = signToken(user, sessionId);
    res.json({ token, user: { id: user.id, businessName: user.businessName, email: user.email, phone: user.phone, storeAddress: user.storeAddress, profileImageUrl: user.profileImageUrl, role: user.role, approvalStatus: user.approvalStatus, rejectionReason: user.rejectionReason } });
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
    const [settings, platformSettings] = await Promise.all([db.getSettings(), db.getPlatformSettings()]);
    res.json({
      googleClientId: GOOGLE_CLIENT_ID || null,
      privacyPolicy: settings.privacyPolicy || null,
      termsOfService: settings.termsOfService || null,
      // Public, unauthenticated on purpose — a guest who hasn't logged
      // in yet should still see the maintenance banner / service area
      // before hitting a wall trying to place an order. Commission
      // rates and the maintenance message's internal-only cousins stay
      // behind requireSuperAdmin (see /api/super-admin/settings/*).
      serviceArea: platformSettings.serviceArea || null,
      defaultDeliveryFee: platformSettings.defaultDeliveryFee,
      maintenanceMode: platformSettings.maintenanceMode,
      maintenanceMessage: platformSettings.maintenanceMessage || null,
    });
  } catch (err) {
    console.error('GET /api/config failed', err);
    res.json({ googleClientId: GOOGLE_CLIENT_ID || null, privacyPolicy: null, termsOfService: null, serviceArea: null, defaultDeliveryFee: null, maintenanceMode: false, maintenanceMessage: null });
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
    if (user && user.isDisabled) {
      return res.status(403).json({ error: 'This account has been disabled. Contact support for help.' });
    }
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
    res.json({ token, user: { id: user.id, businessName: user.businessName, email: user.email, phone: user.phone, storeAddress: user.storeAddress, profileImageUrl: user.profileImageUrl, role: user.role, approvalStatus: user.approvalStatus, rejectionReason: user.rejectionReason } });
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

      const messageBody = `Your ONLib password reset code is: ${code}\nIt expires in 10 minutes. If you didn't request this, ignore this message.`;

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
        sendEmail(email, 'Your ONLib password reset code', messageBody).then(sent => {
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
  res.json({ user: { id: user.id, businessName: user.businessName, email: user.email, phone: user.phone, storeAddress: user.storeAddress, profileImageUrl: user.profileImageUrl, role: user.role, approvalStatus: user.approvalStatus, rejectionReason: user.rejectionReason } });
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
      const [orders, expenses, agents, pricePresets, currentUser] = await Promise.all([
        db.getAllOrders(), db.getAllExpenses(), db.getAllAgents(), db.getAllPricePresets(), db.getUserById(req.user.id),
      ]);
      res.json({ orders, expenses, agents, settings, pricePresets, disabledFeatures: currentUser ? currentUser.disabledFeatures : [] });
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

app.put('/api/admin/settings', requireAuth, requireAdmin, requireFeature('business_settings'), async (req, res) => {
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

app.get('/api/admin/export', requireAuth, requireAdmin, requireFeature('backup_restore'), async (req, res) => {
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
app.post('/api/admin/restore/validate', requireAuth, requireAdmin, requireFeature('backup_restore'), async (req, res) => {
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
app.post('/api/admin/restore/execute', requireAuth, requireAdmin, requireFeature('backup_restore'), async (req, res) => {
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
app.get('/api/admin/customers', requireAuth, requireAdmin, requireFeature('customers'), async (req, res) => {
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
    await logAudit(req, 'customer.create', { targetType: 'user', targetId: customer.id, targetLabel: customer.businessName });
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
    await logAudit(req, 'customer.update', { targetType: 'user', targetId: updated.id, targetLabel: updated.businessName });
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
    await logAudit(req, 'customer.delete', { targetType: 'user', targetId: req.params.id });
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
    await logAudit(req, 'customer.password_reset', { targetType: 'user', targetId: target.id, targetLabel: target.businessName });
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
    await logAudit(req, 'vendor.create', { targetType: 'user', targetId: vendor.id, targetLabel: vendor.businessName });
    res.json({ vendor });
  } catch (err) {
    console.error('POST /api/super-admin/vendors failed', err);
    res.status(500).json({ error: 'Failed to create vendor' });
  }
});

// Staff accounts ("Manage Agent" role = 'admin') — real multi-account
// CRUD for the Super Admin Console's "Staff" tab. Historically there was
// only ever one such account, found on every boot by looking up a fixed
// ADMIN_EMAIL environment variable (see seedAdminIfConfigured further
// down this file) — that seeding still runs and still creates that one
// account on a fresh deploy, but it's now just how staff account #1
// happens to come into existence. From here a Super Admin can create,
// edit, reset the password of, permission, and disable as many more
// role = 'admin' accounts as the business needs — no different from any
// other account once created.
app.get('/api/super-admin/staff', requireAuth, requireSuperAdmin, async (req, res) => {
  try {
    const staff = await db.getStaffAccounts();
    res.json({ staff });
  } catch (err) {
    console.error('GET /api/super-admin/staff failed', err);
    res.status(500).json({ error: 'Failed to load staff accounts' });
  }
});

// Creating a new staff (Manage Agent) account directly — no
// application/approval step needed, mirroring Add Vendor/Add Delivery
// Company: the Super Admin creating it here IS the approval.
app.post('/api/super-admin/staff', requireAuth, requireSuperAdmin, async (req, res) => {
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
    const staff = await db.createUser({
      id: crypto.randomUUID(),
      businessName,
      email,
      phone: phone || null,
      passwordHash,
      role: 'admin',
      approvalStatus: 'approved',
    });
    await logAudit(req, 'staff.create', { targetType: 'user', targetId: staff.id, targetLabel: staff.businessName });
    res.json({ staff: { id: staff.id, businessName: staff.businessName, email: staff.email, phone: staff.phone, createdAt: staff.createdAt, isDisabled: staff.isDisabled, disabledFeatures: staff.disabledFeatures } });
  } catch (err) {
    console.error('POST /api/super-admin/staff failed', err);
    res.status(500).json({ error: 'Failed to create staff account' });
  }
});

// Editing a staff account's name/email/phone. The ADMIN_EMAIL warning
// below only matters for the one account that's actually looked up by
// that env var on every boot (see seedAdminIfConfigured) — any other
// staff account created from here has no such dependency, so the
// warning only fires when this is that specific account.
app.put('/api/super-admin/staff/:id', requireAuth, requireSuperAdmin, async (req, res) => {
  const { businessName, email, phone } = req.body || {};
  if (!businessName || !email) {
    return res.status(400).json({ error: 'Name and email are required' });
  }
  try {
    const target = await db.getUserById(req.params.id);
    if (!target || target.role !== 'admin') return res.status(404).json({ error: 'Staff account not found' });
    const existing = await db.getUserByEmail(email);
    if (existing && existing.id !== req.params.id) {
      return res.status(409).json({ error: 'Another account already uses that email' });
    }
    const wasEnvSeededAccount = target.email.toLowerCase() === ADMIN_EMAIL.toLowerCase();
    const updated = await db.updateManageAgentAccount(req.params.id, { businessName, email, phone });
    if (!updated) return res.status(404).json({ error: 'Staff account not found' });
    await logAudit(req, 'staff.update', { targetType: 'user', targetId: updated.id, targetLabel: updated.businessName });
    const emailChanged = wasEnvSeededAccount && updated.email.toLowerCase() !== ADMIN_EMAIL.toLowerCase();
    res.json({
      staff: { id: updated.id, businessName: updated.businessName, email: updated.email, phone: updated.phone },
      emailChangedWarning: emailChanged
        ? `This was the account found via ADMIN_EMAIL on server boot. Update ADMIN_EMAIL=${updated.email} in Railway's Variables tab too — otherwise the next restart re-creates a new, blank account at the old address instead of finding this one.`
        : null,
    });
  } catch (err) {
    console.error('PUT /api/super-admin/staff failed', err);
    res.status(500).json({ error: 'Failed to update staff account' });
  }
});

app.put('/api/super-admin/staff/:id/password', requireAuth, requireSuperAdmin, async (req, res) => {
  const { password } = req.body || {};
  if (!password || password.length < 8) {
    return res.status(400).json({ error: 'Password must be at least 8 characters' });
  }
  try {
    const target = await db.getUserById(req.params.id);
    if (!target || target.role !== 'admin') return res.status(404).json({ error: 'Staff account not found' });
    const passwordHash = await hashPassword(password);
    await db.updateUserPassword(req.params.id, passwordHash);
    await logAudit(req, 'staff.password_reset', { targetType: 'user', targetId: target.id, targetLabel: target.businessName });
    res.json({ ok: true });
  } catch (err) {
    console.error('PUT /api/super-admin/staff/:id/password failed', err);
    res.status(500).json({ error: 'Failed to reset password' });
  }
});

// The authoritative feature list, for the Super Admin's permissions
// toggle UI to render — so the frontend never has to hardcode this
// list separately from the backend's actual enforcement.
app.get('/api/super-admin/feature-keys', requireAuth, requireSuperAdmin, (req, res) => {
  res.json({ featureKeys: FEATURE_KEYS });
});

// Super Admin cutting off (or restoring) specific features for a
// staff account. Takes effect immediately — checked fresh against the
// database on every gated request, not cached in a token.
app.put('/api/super-admin/staff/:id/features', requireAuth, requireSuperAdmin, async (req, res) => {
  const { disabledFeatures } = req.body || {};
  if (!Array.isArray(disabledFeatures) || !disabledFeatures.every(f => typeof f === 'string')) {
    return res.status(400).json({ error: 'disabledFeatures must be a list of feature keys' });
  }
  const validKeys = Object.keys(FEATURE_KEYS);
  const invalid = disabledFeatures.filter(f => !validKeys.includes(f));
  if (invalid.length > 0) {
    return res.status(400).json({ error: `Unknown feature key(s): ${invalid.join(', ')}` });
  }
  try {
    const updated = await db.setDisabledFeatures(req.params.id, disabledFeatures);
    if (!updated) return res.status(404).json({ error: 'Staff account not found' });
    await logAudit(req, 'staff.features_update', { targetType: 'user', targetId: updated.id, targetLabel: updated.businessName, details: { disabledFeatures } });
    res.json({ ok: true, disabledFeatures: updated.disabledFeatures });
  } catch (err) {
    console.error('PUT /api/super-admin/staff/:id/features failed', err);
    res.status(500).json({ error: 'Failed to update permissions' });
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
    // Approving clears any previous rejection reason (see
    // db.setVendorApprovalStatus) — a fresh approval shouldn't carry a
    // stale explanation for why an earlier attempt was turned down.
    const vendor = await db.setVendorApprovalStatus(req.params.id, 'approved');
    if (!vendor) return res.status(404).json({ error: 'Vendor not found' });
    await logAudit(req, 'vendor.approve', { targetType: 'user', targetId: vendor.id, targetLabel: vendor.businessName });
    res.json({ ok: true, vendor: { id: vendor.id, businessName: vendor.businessName, approvalStatus: vendor.approvalStatus } });
  } catch (err) {
    console.error('POST vendor approve failed', err);
    res.status(500).json({ error: 'Failed to approve vendor' });
  }
});

// A reason is required — this is the whole point of the feature: the
// applicant (and the audit log) should always know why an application
// was turned down, not just that it was.
app.post('/api/super-admin/vendors/:id/reject', requireAuth, requireSuperAdmin, async (req, res) => {
  const { reason } = req.body || {};
  if (!reason || !reason.trim()) {
    return res.status(400).json({ error: 'A rejection reason is required' });
  }
  try {
    const vendor = await db.setVendorApprovalStatus(req.params.id, 'rejected', reason.trim());
    if (!vendor) return res.status(404).json({ error: 'Vendor not found' });
    await logAudit(req, 'vendor.reject', { targetType: 'user', targetId: vendor.id, targetLabel: vendor.businessName, details: { reason: reason.trim() } });
    res.json({ ok: true, vendor: { id: vendor.id, businessName: vendor.businessName, approvalStatus: vendor.approvalStatus, rejectionReason: vendor.rejectionReason } });
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

// Super Admin creating a delivery company account directly — no
// business/ID documents required, unlike public self-registration,
// since the Super Admin creating this account IS the approval. Same
// reasoning as Add Vendor and Add Customer.
app.post('/api/super-admin/delivery-companies', requireAuth, requireSuperAdmin, async (req, res) => {
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
    const deliveryCompany = await db.createUser({
      id: crypto.randomUUID(),
      businessName,
      email,
      phone: phone || null,
      passwordHash,
      role: 'delivery_company',
      approvalStatus: 'approved',
    });
    await logAudit(req, 'delivery_company.create', { targetType: 'user', targetId: deliveryCompany.id, targetLabel: deliveryCompany.businessName });
    res.json({ deliveryCompany });
  } catch (err) {
    console.error('POST /api/super-admin/delivery-companies failed', err);
    res.status(500).json({ error: 'Failed to create delivery company' });
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

// One generic endpoint covering Customers, Vendors, Delivery
// Companies, and Manage Agent accounts — real account suspension, not
// deletion. Blocks login and invalidates any already-active session
// immediately (see setUserDisabled). Deliberately cannot target
// role = 'super_admin' at all (enforced in the SQL itself, not just
// here) — including preventing a Super Admin from disabling their own
// account by accident.
app.put('/api/super-admin/users/:id/disable-status', requireAuth, requireSuperAdmin, async (req, res) => {
  const { disabled } = req.body || {};
  if (typeof disabled !== 'boolean') {
    return res.status(400).json({ error: 'disabled must be true or false' });
  }
  if (req.params.id === req.user.id) {
    return res.status(400).json({ error: "You can't disable your own account" });
  }
  try {
    const updated = await db.setUserDisabled(req.params.id, disabled);
    if (!updated) return res.status(404).json({ error: 'Account not found, or it belongs to a Super Admin (not allowed)' });
    await logAudit(req, disabled ? 'user.disable' : 'user.enable', { targetType: 'user', targetId: updated.id, targetLabel: updated.businessName });
    res.json({ ok: true, user: { id: updated.id, businessName: updated.businessName, isDisabled: updated.isDisabled } });
  } catch (err) {
    console.error('PUT disable-status failed', err);
    res.status(500).json({ error: 'Failed to update account status' });
  }
});

app.post('/api/super-admin/delivery-companies/:id/approve', requireAuth, requireSuperAdmin, async (req, res) => {
  try {
    // Approving clears any previous rejection reason — see the matching
    // comment on the vendor approve endpoint above.
    const company = await db.setDeliveryCompanyApprovalStatus(req.params.id, 'approved');
    if (!company) return res.status(404).json({ error: 'Delivery company not found' });
    await logAudit(req, 'delivery_company.approve', { targetType: 'user', targetId: company.id, targetLabel: company.businessName });
    res.json({ ok: true, deliveryCompany: { id: company.id, businessName: company.businessName, approvalStatus: company.approvalStatus } });
  } catch (err) {
    console.error('POST delivery company approve failed', err);
    res.status(500).json({ error: 'Failed to approve delivery company' });
  }
});

// A reason is required — same reasoning as the vendor reject endpoint
// above.
app.post('/api/super-admin/delivery-companies/:id/reject', requireAuth, requireSuperAdmin, async (req, res) => {
  const { reason } = req.body || {};
  if (!reason || !reason.trim()) {
    return res.status(400).json({ error: 'A rejection reason is required' });
  }
  try {
    const company = await db.setDeliveryCompanyApprovalStatus(req.params.id, 'rejected', reason.trim());
    if (!company) return res.status(404).json({ error: 'Delivery company not found' });
    await logAudit(req, 'delivery_company.reject', { targetType: 'user', targetId: company.id, targetLabel: company.businessName, details: { reason: reason.trim() } });
    res.json({ ok: true, deliveryCompany: { id: company.id, businessName: company.businessName, approvalStatus: company.approvalStatus, rejectionReason: company.rejectionReason } });
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
    await logAudit(req, 'vendor.impersonate', { targetType: 'user', targetId: vendor.id, targetLabel: vendor.businessName });
    res.json({
      token,
      user: { id: vendor.id, businessName: vendor.businessName, email: vendor.email, role: vendor.role, approvalStatus: vendor.approvalStatus, rejectionReason: vendor.rejectionReason },
    });
  } catch (err) {
    console.error('POST vendor impersonate failed', err);
    res.status(500).json({ error: 'Failed to enter vendor dashboard' });
  }
});

// ============================================================
// Commission & Payouts — Super Admin only. Two-tier commission model:
// a global default rate per recipient type (marketplace vendors vs.
// delivery companies) in platform_settings, with an optional per-
// account override on the user (commission_rate_override). Payouts
// are real records — gross/commission/net are snapshotted at creation
// time and never recalculated retroactively if rates change later.
// ============================================================
app.get('/api/super-admin/settings/commission', requireAuth, requireSuperAdmin, async (req, res) => {
  try {
    const settings = await db.getPlatformSettings();
    res.json({ settings });
  } catch (err) {
    console.error('GET /api/super-admin/settings/commission failed', err);
    res.status(500).json({ error: 'Failed to load commission settings' });
  }
});

app.put('/api/super-admin/settings/commission', requireAuth, requireSuperAdmin, async (req, res) => {
  const { marketplaceCommissionPercent, deliveryCommissionPercent } = req.body || {};
  const fields = { marketplaceCommissionPercent, deliveryCommissionPercent };
  for (const [key, val] of Object.entries(fields)) {
    if (val === undefined) continue;
    if (typeof val !== 'number' || isNaN(val) || val < 0 || val > 100) {
      return res.status(400).json({ error: `${key} must be a number between 0 and 100` });
    }
  }
  try {
    const settings = await db.upsertPlatformSettings(fields);
    await logAudit(req, 'settings.commission_update', { targetType: 'platform_settings', targetId: 'platform', details: fields });
    res.json({ ok: true, settings });
  } catch (err) {
    console.error('PUT /api/super-admin/settings/commission failed', err);
    res.status(500).json({ error: 'Failed to update commission settings' });
  }
});

// ============================================================
// Platform-wide settings — Super Admin only. Same single-row table as
// commission settings above (platform_settings), a different slice of
// it: a default delivery fee (a suggested starting amount only — never
// enforced, admins can still type any amount when accepting an order),
// a free-text service area description, and a real maintenance-mode
// switch that actually blocks new order/purchase creation (see
// order:create and POST /api/marketplace/checkout) rather than just
// being a label. maintenanceMode/serviceArea/defaultDeliveryFee are
// also exposed unauthenticated via GET /api/config, so guests see the
// maintenance banner and service area before ever logging in.
// ============================================================
app.get('/api/super-admin/settings/platform', requireAuth, requireSuperAdmin, async (req, res) => {
  try {
    const settings = await db.getPlatformSettings();
    res.json({ settings });
  } catch (err) {
    console.error('GET /api/super-admin/settings/platform failed', err);
    res.status(500).json({ error: 'Failed to load platform settings' });
  }
});

app.put('/api/super-admin/settings/platform', requireAuth, requireSuperAdmin, async (req, res) => {
  const { defaultDeliveryFee, serviceArea, maintenanceMode, maintenanceMessage } = req.body || {};
  const fields = {};
  if (defaultDeliveryFee !== undefined) {
    if (defaultDeliveryFee !== null && (typeof defaultDeliveryFee !== 'number' || isNaN(defaultDeliveryFee) || defaultDeliveryFee < 0)) {
      return res.status(400).json({ error: 'defaultDeliveryFee must be a non-negative number, or null to clear it' });
    }
    fields.defaultDeliveryFee = defaultDeliveryFee;
  }
  if (serviceArea !== undefined) {
    if (serviceArea !== null && typeof serviceArea !== 'string') {
      return res.status(400).json({ error: 'serviceArea must be a string, or null to clear it' });
    }
    fields.serviceArea = serviceArea;
  }
  if (maintenanceMode !== undefined) {
    if (typeof maintenanceMode !== 'boolean') {
      return res.status(400).json({ error: 'maintenanceMode must be true or false' });
    }
    fields.maintenanceMode = maintenanceMode;
  }
  if (maintenanceMessage !== undefined) {
    if (maintenanceMessage !== null && typeof maintenanceMessage !== 'string') {
      return res.status(400).json({ error: 'maintenanceMessage must be a string, or null to clear it' });
    }
    fields.maintenanceMessage = maintenanceMessage;
  }
  try {
    const settings = await db.upsertPlatformSettings(fields);
    await logAudit(req, 'settings.platform_update', { targetType: 'platform_settings', targetId: 'platform', details: fields });
    res.json({ ok: true, settings });
  } catch (err) {
    console.error('PUT /api/super-admin/settings/platform failed', err);
    res.status(500).json({ error: 'Failed to update platform settings' });
  }
});

// Per-account commission rate override — vendors and delivery
// companies share the same handler shape, so one route body is
// parameterized by role rather than duplicated.
function handleCommissionOverride(role) {
  return async (req, res) => {
    const { rate } = req.body || {};
    if (rate !== null && (typeof rate !== 'number' || isNaN(rate) || rate < 0 || rate > 100)) {
      return res.status(400).json({ error: 'rate must be a number between 0 and 100, or null to clear the override' });
    }
    try {
      const target = await db.getUserById(req.params.id);
      if (!target || target.role !== role) return res.status(404).json({ error: 'Account not found' });
      const updated = await db.setCommissionRateOverride(req.params.id, rate);
      await logAudit(req, `${role}.commission_rate_override`, { targetType: 'user', targetId: target.id, targetLabel: target.businessName, details: { rate } });
      res.json({ ok: true, commissionRateOverride: updated.commissionRateOverride });
    } catch (err) {
      console.error(`PUT commission-rate override (${role}) failed`, err);
      res.status(500).json({ error: 'Failed to update commission rate' });
    }
  };
}
app.put('/api/super-admin/vendors/:id/commission-rate', requireAuth, requireSuperAdmin, handleCommissionOverride('vendor'));
app.put('/api/super-admin/delivery-companies/:id/commission-rate', requireAuth, requireSuperAdmin, handleCommissionOverride('delivery_company'));

// Current standing for every approved vendor/delivery company — gross
// revenue earned all-time, commission at their effective rate, and
// what's already been paid out vs. still outstanding. Real data only:
// gross comes from actual purchases/delivered orders, nothing
// estimated or fabricated.
app.get('/api/super-admin/payouts/summary', requireAuth, requireSuperAdmin, async (req, res) => {
  try {
    const summary = await db.getPayoutSummary();
    res.json(summary);
  } catch (err) {
    console.error('GET /api/super-admin/payouts/summary failed', err);
    res.status(500).json({ error: 'Failed to load payout summary' });
  }
});

// Recording a real payout — a Super Admin marking that a specific
// amount was actually paid out to a vendor/delivery company for a
// given period. commission_amount/net_amount are computed and
// snapshotted here at creation time (see db.createPayout) — they will
// never drift if the platform's commission rate changes afterward.
app.post('/api/super-admin/payouts', requireAuth, requireSuperAdmin, async (req, res) => {
  const { recipientType, recipientId, periodStart, periodEnd, grossAmount, commissionRate, notes } = req.body || {};
  if (!['vendor', 'delivery_company'].includes(recipientType)) {
    return res.status(400).json({ error: 'recipientType must be "vendor" or "delivery_company"' });
  }
  if (!recipientId || !periodStart || !periodEnd) {
    return res.status(400).json({ error: 'recipientId, periodStart, and periodEnd are required' });
  }
  if (typeof grossAmount !== 'number' || isNaN(grossAmount) || grossAmount < 0) {
    return res.status(400).json({ error: 'grossAmount must be a non-negative number' });
  }
  if (typeof commissionRate !== 'number' || isNaN(commissionRate) || commissionRate < 0 || commissionRate > 100) {
    return res.status(400).json({ error: 'commissionRate must be a number between 0 and 100' });
  }
  try {
    const target = await db.getUserById(recipientId);
    if (!target || target.role !== recipientType) return res.status(404).json({ error: 'Recipient not found' });
    const payout = await db.createPayout({
      id: crypto.randomUUID(),
      recipientType, recipientId, periodStart, periodEnd, grossAmount, commissionRate,
      notes: notes || null,
      createdBy: req.user.id,
    });
    await logAudit(req, 'payout.create', {
      targetType: 'user', targetId: target.id, targetLabel: target.businessName,
      details: { payoutId: payout.id, grossAmount, netAmount: payout.netAmount, recipientType },
    });
    res.json({ ok: true, payout });
  } catch (err) {
    console.error('POST /api/super-admin/payouts failed', err);
    res.status(500).json({ error: 'Failed to record payout' });
  }
});

// Payout history — optionally filtered to a single recipient (used by
// the per-vendor/per-company detail view); otherwise platform-wide,
// most recent first.
app.get('/api/super-admin/payouts', requireAuth, requireSuperAdmin, async (req, res) => {
  try {
    const limit = Math.min(200, Math.max(1, parseInt(req.query.limit, 10) || 50));
    const payouts = await db.getPayouts({ recipientId: req.query.recipientId || undefined, limit });
    res.json({ payouts });
  } catch (err) {
    console.error('GET /api/super-admin/payouts failed', err);
    res.status(500).json({ error: 'Failed to load payouts' });
  }
});

// ============================================================
// Disputes — Super Admin queue. The customer-facing "report a
// problem"/"my disputes" endpoints live down with the other
// marketplace/customer routes; this half is the resolution side,
// gated the same as Payouts and Vendors (Super Admin only) since
// resolving a dispute can move money — see the refund-netting comment
// on db.getPayoutSummary.
// ============================================================
const DISPUTE_CATEGORIES = ['wrong_item', 'damaged', 'never_arrived', 'overcharged', 'other'];

app.get('/api/super-admin/disputes', requireAuth, requireSuperAdmin, async (req, res) => {
  try {
    const status = ['open', 'resolved', 'rejected'].includes(req.query.status) ? req.query.status : undefined;
    const [disputes, openCount] = await Promise.all([
      db.getDisputes({ status }),
      db.countOpenDisputes(),
    ]);
    res.json({ disputes, openCount });
  } catch (err) {
    console.error('GET /api/super-admin/disputes failed', err);
    res.status(500).json({ error: 'Failed to load disputes' });
  }
});

// The one resolution step. decision === 'refund' requires a positive
// refundAmount and moves the dispute to 'resolved'; decision ===
// 'reject' forces refundAmount to null and moves it to 'rejected'.
// resolutionNote is required either way — shown back to the customer,
// same reasoning as the vendor/delivery-company rejection-reason
// feature: they should always know why, not just what happened.
app.put('/api/super-admin/disputes/:id/resolve', requireAuth, requireSuperAdmin, async (req, res) => {
  const { decision, refundAmount, resolutionNote } = req.body || {};
  if (!['refund', 'reject'].includes(decision)) {
    return res.status(400).json({ error: 'decision must be "refund" or "reject"' });
  }
  if (!resolutionNote || !resolutionNote.trim()) {
    return res.status(400).json({ error: 'A resolution note is required — the customer will see this' });
  }
  let finalRefundAmount = null;
  if (decision === 'refund') {
    if (typeof refundAmount !== 'number' || isNaN(refundAmount) || refundAmount <= 0) {
      return res.status(400).json({ error: 'refundAmount must be a positive number when issuing a refund' });
    }
    finalRefundAmount = Math.round(refundAmount * 100) / 100;
  }
  try {
    const existing = await db.getDisputeById(req.params.id);
    if (!existing) return res.status(404).json({ error: 'Dispute not found' });
    if (existing.status !== 'open') return res.status(409).json({ error: `This dispute was already ${existing.status}` });
    const dispute = await db.resolveDispute(req.params.id, {
      status: decision === 'refund' ? 'resolved' : 'rejected',
      resolutionNote: resolutionNote.trim(),
      refundAmount: finalRefundAmount,
      resolvedBy: req.user.id,
    });
    if (!dispute) return res.status(409).json({ error: 'This dispute was already resolved' });
    await logAudit(req, 'dispute.resolve', {
      targetType: 'dispute', targetId: dispute.id, targetLabel: existing.customerName,
      details: { decision, refundAmount: finalRefundAmount, resolutionNote: resolutionNote.trim() },
    });
    // Live-update an open customer tab, same pattern as order:updated.
    io.to(`user:${dispute.customerId}`).emit('dispute:resolved', dispute);
    res.json({ ok: true, dispute });
  } catch (err) {
    console.error('PUT /api/super-admin/disputes/:id/resolve failed', err);
    res.status(500).json({ error: 'Failed to resolve dispute' });
  }
});

// ============================================================
// Audit Log — Super Admin only. Read-only, append-only trail of
// every sensitive action taken from the Super Admin console (see the
// logAudit() calls threaded through this file). Paginated with a
// created_at cursor (`before`) rather than offset, since new entries
// are always being appended.
// ============================================================
app.get('/api/super-admin/audit-log', requireAuth, requireSuperAdmin, async (req, res) => {
  try {
    const limit = Math.min(200, Math.max(1, parseInt(req.query.limit, 10) || 50));
    const entries = await db.getAuditLog({
      limit,
      before: req.query.before || undefined,
      action: req.query.action || undefined,
      actorId: req.query.actorId || undefined,
    });
    res.json({ entries });
  } catch (err) {
    console.error('GET /api/super-admin/audit-log failed', err);
    res.status(500).json({ error: 'Failed to load audit log' });
  }
});

app.get('/api/super-admin/audit-log/actions', requireAuth, requireSuperAdmin, async (req, res) => {
  try {
    const actions = await db.getAuditActionKeys();
    res.json({ actions });
  } catch (err) {
    console.error('GET /api/super-admin/audit-log/actions failed', err);
    res.status(500).json({ error: 'Failed to load audit actions' });
  }
});

// ============================================================
// Pricing presets — admin-defined reference price points, offered as
// quick-select options in the Accept Order flow. Not an automatic
// distance/zone calculator (no mapping data backs this app).
// ============================================================
app.post('/api/admin/price-presets', requireAuth, requireAdmin, requireFeature('price_presets'), async (req, res) => {
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

app.delete('/api/admin/price-presets/:id', requireAuth, requireAdmin, requireFeature('price_presets'), async (req, res) => {
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

app.get('/api/delivery-company/pending-orders', requireAuth, requireDeliveryCompany, async (req, res) => {
  try {
    const orders = await db.getPendingOrders();
    res.json({ orders });
  } catch (err) {
    console.error('GET /api/delivery-company/pending-orders failed', err);
    res.status(500).json({ error: 'Failed to load pending orders' });
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

// A customer reporting a problem with a delivery order or a
// marketplace purchase — see the disputes table comment in
// schema.sql for why it's one-or-the-other. Ownership is verified
// server-side (not just trusted from the client) before a dispute can
// be filed, and a second open dispute against the same order/purchase
// is blocked so the Super Admin queue doesn't fill up with duplicates
// for one problem.
app.post('/api/disputes', requireAuth, async (req, res) => {
  if (req.user.role !== 'sender') return res.status(403).json({ error: 'Only customers can report a problem' });
  const { orderId, purchaseId, category, description } = req.body || {};
  if (!orderId && !purchaseId) return res.status(400).json({ error: 'orderId or purchaseId is required' });
  if (!description || !description.trim()) return res.status(400).json({ error: 'Please describe the problem' });
  const finalCategory = DISPUTE_CATEGORIES.includes(category) ? category : 'other';
  try {
    if (orderId) {
      const order = await db.getOrder(orderId);
      if (!order || order.senderId !== req.user.id) return res.status(404).json({ error: 'Order not found' });
    }
    if (purchaseId) {
      const purchase = await db.getPurchaseById(purchaseId);
      if (!purchase || purchase.customerId !== req.user.id) return res.status(404).json({ error: 'Purchase not found' });
    }
    const existing = await db.getDisputesForCustomer(req.user.id);
    const alreadyOpen = existing.some(d => d.status === 'open'
      && ((orderId && d.orderId === orderId) || (purchaseId && d.purchaseId === purchaseId)));
    if (alreadyOpen) return res.status(409).json({ error: 'You already have an open dispute for this order' });
    const dispute = await db.createDispute({
      id: crypto.randomUUID(),
      orderId: orderId || null,
      purchaseId: purchaseId || null,
      customerId: req.user.id,
      category: finalCategory,
      description: description.trim(),
    });
    res.json({ ok: true, dispute });
  } catch (err) {
    console.error('POST /api/disputes failed', err);
    res.status(500).json({ error: 'Failed to submit dispute' });
  }
});

// A customer's own dispute history/status — including anything
// already resolved, so they can see the outcome and any refund note.
app.get('/api/disputes/mine', requireAuth, async (req, res) => {
  if (req.user.role !== 'sender') return res.status(403).json({ error: 'Only customers have disputes' });
  try {
    const disputes = await db.getDisputesForCustomer(req.user.id);
    res.json({ disputes });
  } catch (err) {
    console.error('GET /api/disputes/mine failed', err);
    res.status(500).json({ error: 'Failed to load your disputes' });
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
  // Maintenance mode pauses checkout platform-wide — same switch and
  // same message as the delivery-order path above.
  const platformSettings = await db.getPlatformSettings();
  if (platformSettings.maintenanceMode) {
    return res.status(503).json({ error: platformSettings.maintenanceMessage || 'Checkout is temporarily paused for maintenance. Please try again shortly.' });
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
        orderRooms(deliveryOrder).forEach((r) => io.to(r).emit('order:created', deliveryOrder));
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
  // onlib231@gmail.com / 1Nigeria@ unless overridden via env vars,
  // so the app works immediately with no Railway config required.
  const existing = await db.getUserByEmail(ADMIN_EMAIL);
  if (existing) return; // already seeded
  const passwordHash = await hashPassword(ADMIN_PASSWORD);
  await db.createUser({
    id: crypto.randomUUID(),
    businessName: 'ONLib',
    email: ADMIN_EMAIL,
    passwordHash,
    role: 'admin',
  });
  console.log(`[seed] Created admin account for ${ADMIN_EMAIL}`);
}

// ONLib rebrand — one-time migration for existing deployments. Verta
// used to BE the Manage Agent account; now Manage Agent represents
// ONLib's own operational staff, and Verta operates as an ordinary
// delivery_company account with no special access (see
// seedVertaDeliveryCompanyIfPossible further down — that's unaffected
// by this, Verta keeps its own separate account). This runs before
// seedAdminIfConfigured so that function finds the renamed account
// already in place instead of creating a duplicate at the new email.
async function migrateManageAgentToOnlib() {
  const alreadyMigrated = await db.getUserByEmail(ADMIN_EMAIL);
  if (alreadyMigrated) return; // nothing to do — already at the new email

  const legacy = await db.getUserByEmail(LEGACY_ADMIN_EMAIL);
  if (!legacy || legacy.role !== 'admin') return; // no old account to migrate

  await db.updateManageAgentAccount(legacy.id, {
    businessName: 'ONLib',
    email: ADMIN_EMAIL,
    phone: legacy.phone,
  });
  console.log(`[migrate] Renamed Manage Agent account from ${LEGACY_ADMIN_EMAIL} to ${ADMIN_EMAIL} (ONLib rebrand) — no manual steps required.`);
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

// Verta's own delivery_company account — "one of the delivery service
// providers," separate from the Manage Agent account, which continues
// to exist for business-level oversight: Reports, Order History,
// Expenses, Business Profile. Uses its own distinct email — no
// conflict with Manage Agent's existing email, no rename required
// first, no waiting for anything to free up. Creates immediately on
// the next restart.
async function seedVertaDeliveryCompanyIfPossible() {
  const existing = await db.getUserByEmail(VERTA_DC_EMAIL);
  if (existing) return; // already seeded

  const passwordHash = await hashPassword(VERTA_DC_PASSWORD);
  const company = await db.createUser({
    id: crypto.randomUUID(),
    businessName: 'Verta Delivery Service',
    email: VERTA_DC_EMAIL,
    passwordHash,
    role: 'delivery_company',
    approvalStatus: 'approved',
  });
  console.log(`[seed] Created Verta Delivery Service (delivery_company) account for ${VERTA_DC_EMAIL}`);

  // Moves the existing fleet (agents + their order history) from
  // whoever currently holds the Manage Agent account over to this new
  // one — works whether or not Manage Agent has been renamed to a
  // different email, since this looks up ADMIN_EMAIL's current holder
  // either way.
  const manageAgent = await db.getUserByEmail(ADMIN_EMAIL);
  if (manageAgent && manageAgent.id !== company.id) {
    const { agentsMoved, ordersMoved } = await db.reassignFleetToCompany(manageAgent.id, company.id);
    if (agentsMoved > 0 || ordersMoved > 0) {
      console.log(`[seed] Moved ${agentsMoved} agent(s) and ${ordersMoved} order(s) from Manage Agent to Verta Delivery Service.`);
    }
  }
}

db.init()
  .then(migrateManageAgentToOnlib)
  .then(seedAdminIfConfigured)
  .then(seedSuperAdminIfConfigured)
  .then(seedVendorIfConfigured)
  .then(seedAgentsIfEmpty)
  .then(migrateAgentsToDeliveryCompany)
  .then(seedVertaDeliveryCompanyIfPossible)
  .then(() => {
    server.listen(PORT, () => console.log(`Verta Delivery server listening on :${PORT}`));
  })
  .catch((err) => {
    console.error('Failed to initialize database', err);
    process.exit(1);
  });
