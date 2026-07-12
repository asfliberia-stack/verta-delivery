// auth.js — password hashing, JWT issuing/verification, and the two auth
// gates used by server.js: requireAuth (Express) and socketAuth (Socket.io).
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

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
    { id: user.id, role: user.role, businessName: user.businessName, email: user.email },
    JWT_SECRET,
    { expiresIn: TOKEN_TTL }
  );
}

function verifyToken(token) {
  return jwt.verify(token, JWT_SECRET); // throws on invalid/expired
}

// Express middleware: requires `Authorization: Bearer <token>`.
function requireAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Missing token' });
  try {
    req.user = verifyToken(token);
    next();
  } catch (err) {
    res.status(401).json({ error: 'Invalid or expired token' });
  }
}

function requireAdmin(req, res, next) {
  if (!req.user || req.user.role !== 'admin') {
    return res.status(403).json({ error: 'Admin access required' });
  }
  next();
}

// Socket.io middleware: expects the token at `socket.handshake.auth.token`
// (set by the client when calling `io({ auth: { token } })`).
function socketAuth(socket, next) {
  const token = socket.handshake.auth && socket.handshake.auth.token;
  if (!token) return next(new Error('unauthorized'));
  try {
    socket.user = verifyToken(token);
    next();
  } catch (err) {
    next(new Error('unauthorized'));
  }
}

module.exports = {
  hashPassword,
  comparePassword,
  signToken,
  verifyToken,
  requireAuth,
  requireAdmin,
  socketAuth,
};
