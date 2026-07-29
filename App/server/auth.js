// auth.js — password hashing, JWT issuing/verification, and the two auth
// gates used by server.js: requireAuth (Express) and socketAuth (Socket.io).
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const db = require('./db');

const JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET) {
  // Fail loudly at boot rather than silently signing tokens with a
  // guessable default — an unset secret is a real security bug, not a
  // warning.
  throw new Error('JWT_SECRET environment variable is required');
}
const TOKEN_TTL = '30d';

function hashPassword(plain) {
  return bcrypt.hash(plain, 12);
}

function comparePassword(plain, hash) {
  return bcrypt.compare(plain, hash);
}

function signToken(user) {
  return jwt.sign(
    {
      id: user.id,
      role: user.role,
      businessName: user.businessName,
      email: user.email,
      tokenVersion: user.tokenVersion || 0,
    },
    JWT_SECRET,
    { expiresIn: TOKEN_TTL }
  );
}

// Super Admin "enter their dashboard" for a vendor — a real, distinct
// token type from normal login, not just a relabeled signToken():
// - Short expiry (1 hour), since this is a temporary oversight session,
//   not a standing credential.
// - Carries `impersonatedBy` so every action taken during this session
//   is traceable in server logs back to the real Super Admin, not just
//   attributed to the vendor.
const IMPERSONATION_TOKEN_TTL = '1h';
function signImpersonationToken(targetUser, superAdminUser) {
  return jwt.sign(
    {
      id: targetUser.id,
      role: targetUser.role,
      businessName: targetUser.businessName,
      email: targetUser.email,
      tokenVersion: targetUser.tokenVersion || 0,
      impersonatedBy: superAdminUser.id,
      impersonatedByEmail: superAdminUser.email,
    },
    JWT_SECRET,
    { expiresIn: IMPERSONATION_TOKEN_TTL }
  );
}

function verifyToken(token) {
  return jwt.verify(token, JWT_SECRET); // throws on invalid/expired
}

// Checks the decoded token's tokenVersion against the user's CURRENT
// tokenVersion in the database. A mismatch means "Logout All Devices"
// was used after this token was issued — this is what makes that
// feature actually invalidate old tokens instead of just being a UI
// gesture with no effect on already-issued JWTs.
async function checkTokenVersion(payload) {
  const user = await db.getUserById(payload.id);
  if (!user) return false;
  return (user.tokenVersion || 0) === (payload.tokenVersion || 0);
}

// Express middleware: requires `Authorization: Bearer <token>`.
async function requireAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Missing token' });
  try {
    const payload = verifyToken(token);
    const stillValid = await checkTokenVersion(payload);
    if (!stillValid) return res.status(401).json({ error: 'Session expired — please log in again' });
    req.user = payload;
    next();
  } catch (err) {
    res.status(401).json({ error: 'Invalid or expired token' });
  }
}

// True for both roles that can operate the dashboard — a plain "admin"
// (Manage Agent, one business) and "super_admin" (oversees everything,
// including the Vendors panel that only super_admin can reach).
function isAdminLike(role) {
  return role === 'admin' || role === 'super_admin';
}

function requireAdmin(req, res, next) {
  if (!req.user || !isAdminLike(req.user.role)) {
    return res.status(403).json({ error: 'Admin access required' });
  }
  next();
}

function requireSuperAdmin(req, res, next) {
  if (!req.user || req.user.role !== 'super_admin') {
    return res.status(403).json({ error: 'Super Admin access required' });
  }
  next();
}

async function requireVendor(req, res, next) {
  if (!req.user || req.user.role !== 'vendor') {
    return res.status(403).json({ error: 'Vendor access required' });
  }
  try {
    const user = await db.getUserById(req.user.id);
    if (!user || user.approvalStatus !== 'approved') {
      return res.status(403).json({ error: 'Your vendor application is still pending approval', approvalStatus: user ? user.approvalStatus : 'pending' });
    }
    next();
  } catch (err) {
    res.status(500).json({ error: 'Failed to verify vendor status' });
  }
}

// Socket.io middleware: expects the token at `socket.handshake.auth.token`
// (set by the client when calling `io({ auth: { token } })`).
async function socketAuth(socket, next) {
  const token = socket.handshake.auth && socket.handshake.auth.token;
  if (!token) return next(new Error('unauthorized'));
  try {
    const payload = verifyToken(token);
    const stillValid = await checkTokenVersion(payload);
    if (!stillValid) return next(new Error('unauthorized'));
    socket.user = payload;
    next();
  } catch (err) {
    next(new Error('unauthorized'));
  }
}

module.exports = {
  hashPassword,
  comparePassword,
  signToken,
  signImpersonationToken,
  verifyToken,
  requireAuth,
  requireAdmin,
  requireSuperAdmin,
  requireVendor,
  isAdminLike,
  socketAuth,
};
