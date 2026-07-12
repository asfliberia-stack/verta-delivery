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

function rowToUser(r) {
  if (!r) return null;
  return {
    id: r.id,
    businessName: r.business_name,
    email: r.email,
    role: r.role,
    passwordHash: r.password_hash, // only used internally for login checks
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

  async createUser({ id, businessName, email, passwordHash, role }) {
    const { rows } = await pool.query(
      `INSERT INTO users (id, business_name, email, password_hash, role)
       VALUES ($1, $2, $3, $4, $5) RETURNING *`,
      [id, businessName, email.toLowerCase(), passwordHash, role]
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
      `INSERT INTO orders (id, sender_id, sender_name, pickup_address, dropoff_address, item_description, amount, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING *`,
      [order.id, order.senderId, order.senderName, order.pickupAddress, order.dropoffAddress, order.itemDescription, order.amount, order.status || 'pending']
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
};

module.exports = db;
