// db.js — Postgres access layer.
// Railway injects DATABASE_URL automatically when you attach a Postgres
// plugin to this service. Locally, put the same variable in server/.env.
const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  // Railway's internal Postgres doesn't need SSL; its public proxy does.
  // This flag keeps both cases working without extra config.
  ssl: process.env.DATABASE_URL && process.env.DATABASE_URL.includes('railway')
    ? { rejectUnauthorized: false }
    : false,
});

function rowToOrder(r) {
  if (!r) return null;
  return {
    id: r.id,
    senderId: r.sender_id,
    senderName: r.sender_name,
    pickupAddress: r.pickup_address,
    dropoffAddress: r.dropoff_address,
    itemDescription: r.item_description,
    amount: r.amount === null ? null : Number(r.amount),
    status: r.status,
    acceptedBy: r.accepted_by,
    paymentMethod: r.payment_method,
    placedByAdmin: r.placed_by_admin,
    createdAt: r.created_at,
    acceptedAt: r.accepted_at,
    pickedUpAt: r.picked_up_at,
    deliveredAt: r.delivered_at,
  };
}

function rowToExpense(r) {
  if (!r) return null;
  return {
    id: r.id,
    date: r.date,
    amount: Number(r.amount),
    description: r.description,
  };
}

function rowToAgent(r) {
  if (!r) return null;
  return {
    id: r.id,
    name: r.name,
    phone: r.phone,
    dutyStatus: r.duty_status,
  };
}

function rowToPricePreset(r) {
  if (!r) return null;
  return {
    id: r.id,
    label: r.label,
    amount: Number(r.amount),
  };
}

function rowToSettings(r) {
  if (!r) return null;
  return {
    businessName: r.business_name,
    businessEmail: r.business_email,
    businessPhone: r.business_phone,
    businessAddress: r.business_address,
    businessDescription: r.business_description,
    logoDataUrl: r.logo_data_url,
    openingTime: r.opening_time,
    closingTime: r.closing_time,
    openDays: r.open_days || [],
    currency: r.currency,
    timezone: r.timezone,
    updatedAt: r.updated_at,
  };
}

function rowToLoginHistory(r) {
  if (!r) return null;
  return {
    id: r.id,
    ipAddress: r.ip_address,
    device: r.device,
    browser: r.browser,
    createdAt: r.created_at,
  };
}

function rowToUser(r) {
  if (!r) return null;
  return {
    id: r.id,
    businessName: r.business_name,
    email: r.email,
    phone: r.phone,
    role: r.role,
    passwordHash: r.password_hash, // only used internally for login checks
    tokenVersion: r.token_version,
  };
}

const db = {
  async init() {
    const fs = require('fs');
    const path = require('path');
    const schema = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
    await pool.query(schema);
  },

  // ---- Users -------------------------------------------------------

  async createUser({ id, businessName, email, phone, passwordHash, role }) {
    const { rows } = await pool.query(
      `INSERT INTO users (id, business_name, email, phone, password_hash, role)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
      [id, businessName, email.toLowerCase(), phone || null, passwordHash, role]
    );
    return rowToUser(rows[0]);
  },

  async updateUserPassword(userId, passwordHash) {
    await pool.query('UPDATE users SET password_hash = $1 WHERE id = $2', [passwordHash, userId]);
  },

  async updateUserEmail(userId, email) {
    const { rows } = await pool.query(
      'UPDATE users SET email = $1 WHERE id = $2 RETURNING *',
      [email.toLowerCase(), userId]
    );
    return rowToUser(rows[0]);
  },

  // Invalidates every JWT issued before this call for this user — used by
  // "Logout All Devices". See the token_version comment in schema.sql.
  async bumpTokenVersion(userId) {
    const { rows } = await pool.query(
      'UPDATE users SET token_version = token_version + 1 WHERE id = $1 RETURNING *',
      [userId]
    );
    return rowToUser(rows[0]);
  },

  async getUserByEmail(email) {
    const { rows } = await pool.query('SELECT * FROM users WHERE email = $1', [email.toLowerCase()]);
    return rowToUser(rows[0]);
  },

  async getUserById(id) {
    const { rows } = await pool.query('SELECT * FROM users WHERE id = $1', [id]);
    return rowToUser(rows[0]);
  },

  async countAdmins() {
    const { rows } = await pool.query("SELECT COUNT(*)::int AS count FROM users WHERE role = 'admin'");
    return rows[0].count;
  },

  // ---- Orders -------------------------------------------------------

  async getAllOrders() {
    const { rows } = await pool.query('SELECT * FROM orders ORDER BY created_at DESC');
    return rows.map(rowToOrder);
  },

  async getOrdersBySender(senderId) {
    const { rows } = await pool.query(
      'SELECT * FROM orders WHERE sender_id = $1 ORDER BY created_at DESC',
      [senderId]
    );
    return rows.map(rowToOrder);
  },

  async createOrder(order) {
    const { rows } = await pool.query(
      `INSERT INTO orders (id, sender_id, sender_name, pickup_address, dropoff_address, item_description, amount, status, placed_by_admin)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       RETURNING *`,
      [order.id, order.senderId, order.senderName, order.pickupAddress, order.dropoffAddress, order.itemDescription, order.amount, order.status || 'pending', !!order.placedByAdmin]
    );
    return rowToOrder(rows[0]);
  },

  async updateOrder(id, fields) {
    // Whitelist of updatable columns, mapped from camelCase -> snake_case.
    const colMap = {
      amount: 'amount',
      status: 'status',
      acceptedBy: 'accepted_by',
      acceptedAt: 'accepted_at',
      pickedUpAt: 'picked_up_at',
      deliveredAt: 'delivered_at',
      paymentMethod: 'payment_method',
    };
    const sets = [];
    const values = [];
    let i = 1;
    for (const [key, col] of Object.entries(colMap)) {
      if (Object.prototype.hasOwnProperty.call(fields, key)) {
        sets.push(`${col} = $${i}`);
        values.push(fields[key]);
        i += 1;
      }
    }
    if (sets.length === 0) return this.getOrder(id);
    values.push(id);
    const { rows } = await pool.query(
      `UPDATE orders SET ${sets.join(', ')} WHERE id = $${i} RETURNING *`,
      values
    );
    return rowToOrder(rows[0]);
  },

  async getOrder(id) {
    const { rows } = await pool.query('SELECT * FROM orders WHERE id = $1', [id]);
    return rowToOrder(rows[0]);
  },

  async deleteOrders(ids) {
    if (!ids.length) return;
    await pool.query('DELETE FROM orders WHERE id = ANY($1::text[])', [ids]);
  },

  // ---- Expenses -------------------------------------------------------

  async getAllExpenses() {
    const { rows } = await pool.query('SELECT * FROM expenses ORDER BY date DESC');
    return rows.map(rowToExpense);
  },

  async createExpense(expense) {
    const { rows } = await pool.query(
      `INSERT INTO expenses (id, date, amount, description) VALUES ($1, $2, $3, $4) RETURNING *`,
      [expense.id, expense.date, expense.amount, expense.description]
    );
    return rowToExpense(rows[0]);
  },

  async deleteExpense(id) {
    await pool.query('DELETE FROM expenses WHERE id = $1', [id]);
  },

  // ---- Agents (Fleet Directory) -------------------------------------

  async getAllAgents() {
    const { rows } = await pool.query('SELECT * FROM agents ORDER BY created_at ASC');
    return rows.map(rowToAgent);
  },

  async countAgents() {
    const { rows } = await pool.query('SELECT COUNT(*)::int AS count FROM agents');
    return rows[0].count;
  },

  async createAgent({ id, name, phone }) {
    const { rows } = await pool.query(
      `INSERT INTO agents (id, name, phone) VALUES ($1, $2, $3) RETURNING *`,
      [id, name, phone]
    );
    return rowToAgent(rows[0]);
  },

  async updateAgent(id, { name, phone }) {
    const { rows } = await pool.query(
      `UPDATE agents SET name = $1, phone = $2 WHERE id = $3 RETURNING *`,
      [name, phone, id]
    );
    return rowToAgent(rows[0]);
  },

  async updateAgentDutyStatus(id, dutyStatus) {
    const { rows } = await pool.query(
      `UPDATE agents SET duty_status = $1 WHERE id = $2 RETURNING *`,
      [dutyStatus, id]
    );
    return rowToAgent(rows[0]);
  },

  // ---- Password resets -----------------------------------------------

  async createPasswordReset({ id, userId, codeHash, expiresAt }) {
    await pool.query(
      `INSERT INTO password_resets (id, user_id, code_hash, expires_at) VALUES ($1, $2, $3, $4)`,
      [id, userId, codeHash, expiresAt]
    );
  },

  // Most recent unused, unexpired reset row for this user — a user may
  // have requested a code more than once; only the latest one counts.
  async getActivePasswordReset(userId) {
    const { rows } = await pool.query(
      `SELECT * FROM password_resets
       WHERE user_id = $1 AND used = false AND expires_at > now()
       ORDER BY created_at DESC LIMIT 1`,
      [userId]
    );
    return rows[0] || null;
  },

  async markPasswordResetUsed(id) {
    await pool.query('UPDATE password_resets SET used = true WHERE id = $1', [id]);
  },

  // ---- Settings (Business Profile / Regional) -------------------------
  // Single row, id = 'business' always. Upsert on save.

  async getSettings() {
    const { rows } = await pool.query("SELECT * FROM settings WHERE id = 'business'");
    return rowToSettings(rows[0]);
  },

  async upsertSettings(fields) {
    const existing = await pool.query("SELECT id FROM settings WHERE id = 'business'");
    if (existing.rows.length === 0) {
      await pool.query("INSERT INTO settings (id) VALUES ('business')");
    }
    const colMap = {
      businessName: 'business_name',
      businessEmail: 'business_email',
      businessPhone: 'business_phone',
      businessAddress: 'business_address',
      businessDescription: 'business_description',
      logoDataUrl: 'logo_data_url',
      openingTime: 'opening_time',
      closingTime: 'closing_time',
      openDays: 'open_days',
      currency: 'currency',
      timezone: 'timezone',
    };
    const sets = [];
    const values = [];
    let i = 1;
    for (const [key, col] of Object.entries(colMap)) {
      if (Object.prototype.hasOwnProperty.call(fields, key)) {
        sets.push(`${col} = $${i}`);
        values.push(fields[key]);
        i += 1;
      }
    }
    sets.push('updated_at = now()');
    if (sets.length > 1) {
      await pool.query(`UPDATE settings SET ${sets.join(', ')} WHERE id = 'business'`, values);
    }
    return this.getSettings();
  },

  // ---- Login history ---------------------------------------------------

  async recordLogin({ id, userId, ipAddress, device, browser }) {
    await pool.query(
      `INSERT INTO login_history (id, user_id, ip_address, device, browser) VALUES ($1, $2, $3, $4, $5)`,
      [id, userId, ipAddress, device, browser]
    );
  },

  async getLoginHistory(userId, limit = 20) {
    const { rows } = await pool.query(
      'SELECT * FROM login_history WHERE user_id = $1 ORDER BY created_at DESC LIMIT $2',
      [userId, limit]
    );
    return rows.map(rowToLoginHistory);
  },

  // ---- Full data export (Backup & Restore > Export Database) ----------

  async exportAllData() {
    const [orders, expenses, agents, users] = await Promise.all([
      this.getAllOrders(),
      this.getAllExpenses(),
      this.getAllAgents(),
      pool.query('SELECT id, business_name, email, phone, role, created_at FROM users'),
    ]);
    return {
      exportedAt: new Date().toISOString(),
      orders,
      expenses,
      agents,
      customers: users.rows.map(u => ({
        id: u.id,
        businessName: u.business_name,
        email: u.email,
        phone: u.phone,
        role: u.role,
        createdAt: u.created_at,
      })), // password hashes deliberately excluded
    };
  },

  // ---- Customers (aggregated from users + orders) ---------------------

  async getCustomers() {
    const { rows } = await pool.query(`
      SELECT
        u.id, u.business_name, u.email, u.phone, u.created_at,
        COUNT(o.id)::int AS total_orders,
        COALESCE(SUM(o.amount) FILTER (WHERE o.status = 'delivered'), 0)::numeric AS total_spent,
        MAX(o.created_at) AS last_order_at
      FROM users u
      LEFT JOIN orders o ON o.sender_id = u.id
      WHERE u.role = 'sender'
      GROUP BY u.id
      ORDER BY total_orders DESC, u.business_name ASC
    `);
    return rows.map(r => ({
      id: r.id,
      businessName: r.business_name,
      email: r.email,
      phone: r.phone,
      createdAt: r.created_at,
      totalOrders: r.total_orders,
      totalSpent: Number(r.total_spent),
      lastOrderAt: r.last_order_at,
    }));
  },

  // ---- Price presets (Settings > Pricing) ------------------------------

  async getAllPricePresets() {
    const { rows } = await pool.query('SELECT * FROM price_presets ORDER BY amount ASC');
    return rows.map(rowToPricePreset);
  },

  async createPricePreset({ id, label, amount }) {
    const { rows } = await pool.query(
      'INSERT INTO price_presets (id, label, amount) VALUES ($1, $2, $3) RETURNING *',
      [id, label, amount]
    );
    return rowToPricePreset(rows[0]);
  },

  async deletePricePreset(id) {
    await pool.query('DELETE FROM price_presets WHERE id = $1', [id]);
  },
};

module.exports = db;
