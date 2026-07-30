// db.js — Postgres access layer.
// Railway injects DATABASE_URL automatically when you attach a Postgres
// plugin to this service. Locally, put the same variable in server/.env.
const { Pool } = require('pg');
const crypto = require('crypto');

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

function rowToProduct(r) {
  if (!r) return null;
  return {
    id: r.id,
    vendorId: r.vendor_id,
    name: r.name,
    description: r.description,
    price: Number(r.price),
    category: r.category,
    imageDataUrl: r.image_data_url,
    stockQuantity: r.stock_quantity,
    isActive: r.is_active,
    createdAt: r.created_at,
  };
}

function rowToPurchase(r) {
  if (!r) return null;
  return {
    id: r.id,
    customerId: r.customer_id,
    vendorId: r.vendor_id,
    totalAmount: Number(r.total_amount),
    deliveryOrderId: r.delivery_order_id,
    createdAt: r.created_at,
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
    revokedAt: r.revoked_at,
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
    approvalStatus: r.approval_status,
    businessRegistrationDoc: r.business_registration_doc,
    idDocumentType: r.id_document_type,
    idDocumentDoc: r.id_document_doc,
    appliedAt: r.applied_at,
    createdAt: r.created_at,
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

  async createUser({ id, businessName, email, phone, passwordHash, role, approvalStatus, businessRegistrationDoc, idDocumentType, idDocumentDoc, appliedAt }) {
    const { rows } = await pool.query(
      `INSERT INTO users (id, business_name, email, phone, password_hash, role, approval_status, business_registration_doc, id_document_type, id_document_doc, applied_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) RETURNING *`,
      [id, businessName, email.toLowerCase(), phone || null, passwordHash, role, approvalStatus || 'approved', businessRegistrationDoc || null, idDocumentType || null, idDocumentDoc || null, appliedAt || null]
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

  // Self-service profile edit (business/store name + phone) — any
  // authenticated user updating their own account. Email/password stay
  // on their existing separate, more careful flows (uniqueness checks,
  // re-auth) rather than folding into this simpler update.
  async updateUserProfile(userId, { businessName, phone }) {
    const { rows } = await pool.query(
      'UPDATE users SET business_name = $1, phone = $2 WHERE id = $3 RETURNING *',
      [businessName, phone || null, userId]
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

  // Fail-open by design: if the session row doesn't exist (e.g. the
  // history insert failed at login time — a real but rare case), this
  // returns false rather than locking the person out. Login history is
  // a convenience; it should never become a way to break login itself.
  async isSessionRevoked(sessionId) {
    if (!sessionId) return false;
    const { rows } = await pool.query('SELECT revoked_at FROM login_history WHERE id = $1', [sessionId]);
    if (!rows[0]) return false;
    return rows[0].revoked_at !== null;
  },

  // Ownership-checked — a user (or admin viewing their own history)
  // can only revoke sessions that are actually theirs.
  async revokeSession(sessionId, userId) {
    const { rows } = await pool.query(
      'UPDATE login_history SET revoked_at = now() WHERE id = $1 AND user_id = $2 AND revoked_at IS NULL RETURNING id',
      [sessionId, userId]
    );
    return rows.length > 0;
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

  // ---- Vendors (real vendor accounts — Super Admin oversight) --------
  // NOTE: this app is still single-tenant for ORDER data — there is no
  // per-vendor isolation of orders/agents/expenses yet, those stay one
  // shared dataset until the marketplace's own data model exists. But
  // vendor ACCOUNTS themselves are real and distinct (role = 'vendor'),
  // including the approval workflow below — this was previously (and
  // wrongly) querying role = 'admin' instead, a leftover from before
  // real vendor accounts existed.
  async getVendors() {
    const { rows } = await pool.query(
      "SELECT id, business_name, email, phone, approval_status, applied_at, created_at FROM users WHERE role = 'vendor' ORDER BY created_at DESC"
    );
    return rows.map(r => ({
      id: r.id,
      businessName: r.business_name,
      email: r.email,
      phone: r.phone,
      approvalStatus: r.approval_status,
      appliedAt: r.applied_at,
      createdAt: r.created_at,
    }));
  },

  async getVendorApplicationDocuments(vendorId) {
    const { rows } = await pool.query(
      "SELECT business_registration_doc, id_document_type, id_document_doc FROM users WHERE id = $1 AND role = 'vendor'",
      [vendorId]
    );
    if (!rows[0]) return null;
    return {
      businessRegistrationDoc: rows[0].business_registration_doc,
      idDocumentType: rows[0].id_document_type,
      idDocumentDoc: rows[0].id_document_doc,
    };
  },

  async setVendorApprovalStatus(vendorId, status) {
    const { rows } = await pool.query(
      "UPDATE users SET approval_status = $1 WHERE id = $2 AND role = 'vendor' RETURNING *",
      [status, vendorId]
    );
    return rowToUser(rows[0]);
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

  // ---- Marketplace: products -----------------------------------------

  async getProductsByVendor(vendorId) {
    const { rows } = await pool.query('SELECT * FROM products WHERE vendor_id = $1 ORDER BY created_at DESC', [vendorId]);
    return rows.map(rowToProduct);
  },

  // Storefront listing — every active product from every vendor, with
  // the vendor's business name attached so the storefront can show it.
  async getActiveProductsForStorefront() {
    const { rows } = await pool.query(`
      SELECT p.*, u.business_name AS vendor_name,
        COALESCE(AVG(r.rating), 0)::numeric AS avg_rating,
        COUNT(DISTINCT r.id)::int AS review_count,
        COALESCE(sold.units_sold, 0)::int AS units_sold
      FROM products p
      JOIN users u ON u.id = p.vendor_id
      LEFT JOIN product_reviews r ON r.product_id = p.id
      LEFT JOIN (
        SELECT product_id, SUM(quantity)::int AS units_sold
        FROM purchase_items
        GROUP BY product_id
      ) sold ON sold.product_id = p.id
      WHERE p.is_active = true AND p.stock_quantity > 0
      GROUP BY p.id, u.business_name, sold.units_sold
      ORDER BY p.created_at DESC
    `);
    return rows.map(r => ({
      ...rowToProduct(r),
      vendorName: r.vendor_name,
      avgRating: Number(r.avg_rating),
      reviewCount: r.review_count,
      unitsSold: r.units_sold,
    }));
  },

  async getProductById(id) {
    const { rows } = await pool.query('SELECT * FROM products WHERE id = $1', [id]);
    return rowToProduct(rows[0]);
  },

  async createProduct({ id, vendorId, name, description, price, category, imageDataUrl, stockQuantity }) {
    const { rows } = await pool.query(
      `INSERT INTO products (id, vendor_id, name, description, price, category, image_data_url, stock_quantity)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
      [id, vendorId, name, description || null, price, category || null, imageDataUrl || null, stockQuantity || 0]
    );
    return rowToProduct(rows[0]);
  },

  async updateProduct(id, fields) {
    const colMap = {
      name: 'name', description: 'description', price: 'price', category: 'category',
      imageDataUrl: 'image_data_url', stockQuantity: 'stock_quantity', isActive: 'is_active',
    };
    const sets = []; const values = []; let i = 1;
    for (const [key, col] of Object.entries(colMap)) {
      if (Object.prototype.hasOwnProperty.call(fields, key)) {
        sets.push(`${col} = $${i}`); values.push(fields[key]); i += 1;
      }
    }
    if (sets.length === 0) return this.getProductById(id);
    values.push(id);
    const { rows } = await pool.query(`UPDATE products SET ${sets.join(', ')} WHERE id = $${i} RETURNING *`, values);
    return rowToProduct(rows[0]);
  },

  async deleteProduct(id) {
    await pool.query('DELETE FROM products WHERE id = $1', [id]);
  },

  // ---- Marketplace: checkout + purchases -------------------------------

  // Runs as a single transaction: validates stock, decrements it,
  // creates the purchase + line items, and (per the "Shop & Delivery"
  // default) a linked delivery order in the existing `orders` table for
  // fulfillment — all-or-nothing, so a failed delivery-order insert
  // can't leave stock decremented with no purchase recorded.
  async checkout({ customerId, customerName, vendorId, items, pickupAddress, dropoffAddress, createDeliveryOrder }) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      let totalAmount = 0;
      const lineItems = [];
      for (const item of items) {
        const productRes = await client.query('SELECT * FROM products WHERE id = $1 FOR UPDATE', [item.productId]);
        const product = productRes.rows[0];
        if (!product) throw new Error(`Product not found: ${item.productId}`);
        if (product.vendor_id !== vendorId) throw new Error('All items in a checkout must be from the same vendor');
        if (product.stock_quantity < item.quantity) throw new Error(`Not enough stock for ${product.name}`);
        await client.query('UPDATE products SET stock_quantity = stock_quantity - $1 WHERE id = $2', [item.quantity, product.id]);
        const lineTotal = Number(product.price) * item.quantity;
        totalAmount += lineTotal;
        lineItems.push({ productId: product.id, productName: product.name, unitPrice: Number(product.price), quantity: item.quantity });
      }

      const purchaseId = `PUR-${Date.now().toString(36).toUpperCase()}`;
      let deliveryOrderId = null;

      if (createDeliveryOrder) {
        deliveryOrderId = `ORD-${Date.now().toString(36).toUpperCase()}M`; // 'M' suffix avoids colliding with a same-millisecond regular order id
        const itemSummary = lineItems.map(li => `${li.quantity}x ${li.productName}`).join(', ');
        await client.query(
          `INSERT INTO orders (id, sender_id, sender_name, pickup_address, dropoff_address, item_description, amount, status, placed_by_admin)
           VALUES ($1, $2, $3, $4, $5, $6, $7, 'pending', false)`,
          [deliveryOrderId, customerId, customerName, pickupAddress, dropoffAddress, `Marketplace order: ${itemSummary}`, null]
        );
      }

      await client.query(
        `INSERT INTO purchases (id, customer_id, vendor_id, total_amount, delivery_order_id) VALUES ($1, $2, $3, $4, $5)`,
        [purchaseId, customerId, vendorId, totalAmount, deliveryOrderId]
      );
      for (const li of lineItems) {
        await client.query(
          `INSERT INTO purchase_items (id, purchase_id, product_id, product_name, unit_price, quantity) VALUES ($1, $2, $3, $4, $5, $6)`,
          [crypto.randomUUID(), purchaseId, li.productId, li.productName, li.unitPrice, li.quantity]
        );
      }

      await client.query('COMMIT');
      return { purchaseId, deliveryOrderId, totalAmount };
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  },

  async getPurchasesByVendor(vendorId, limit = 50) {
    const { rows } = await pool.query(`
      SELECT p.*, u.business_name AS customer_name, o.status AS delivery_status
      FROM purchases p
      JOIN users u ON u.id = p.customer_id
      LEFT JOIN orders o ON o.id = p.delivery_order_id
      WHERE p.vendor_id = $1
      ORDER BY p.created_at DESC
      LIMIT $2
    `, [vendorId, limit]);
    return rows.map(r => ({ ...rowToPurchase(r), customerName: r.customer_name, deliveryStatus: r.delivery_status }));
  },

  async getPurchaseItems(purchaseId) {
    const { rows } = await pool.query('SELECT * FROM purchase_items WHERE purchase_id = $1', [purchaseId]);
    return rows.map(r => ({ id: r.id, productId: r.product_id, productName: r.product_name, unitPrice: Number(r.unit_price), quantity: r.quantity }));
  },

  // Real sales overview for the vendor dashboard — total revenue and
  // order count over the last N days, no fabricated trend line.
  async getVendorSalesOverview(vendorId, days = 30) {
    const { rows } = await pool.query(`
      SELECT COALESCE(SUM(total_amount), 0)::numeric AS total_sales, COUNT(*)::int AS total_orders
      FROM purchases
      WHERE vendor_id = $1 AND created_at > now() - ($2 || ' days')::interval
    `, [vendorId, days]);
    return { totalSales: Number(rows[0].total_sales), totalOrders: rows[0].total_orders };
  },

  // Real day-by-day revenue for the Sales Overview line chart — no
  // fabricated curve, actual sums grouped by day.
  async getVendorDailySales(vendorId, days = 30) {
    const { rows } = await pool.query(`
      SELECT date_trunc('day', created_at) AS day, COALESCE(SUM(total_amount), 0)::numeric AS total
      FROM purchases
      WHERE vendor_id = $1 AND created_at > now() - ($2 || ' days')::interval
      GROUP BY day
      ORDER BY day ASC
    `, [vendorId, days]);
    return rows.map(r => ({ day: r.day, total: Number(r.total) }));
  },

  // ---- Product reviews (real ratings, not fabricated) ------------------

  // A customer can only review a product they actually bought — checked
  // via purchase_items/purchases joined to this customer, matching the
  // rest of this app's "don't trust the client, verify against real
  // records" pattern.
  async hasCustomerPurchasedProduct(customerId, productId) {
    const { rows } = await pool.query(`
      SELECT 1 FROM purchase_items pi
      JOIN purchases p ON p.id = pi.purchase_id
      WHERE p.customer_id = $1 AND pi.product_id = $2
      LIMIT 1
    `, [customerId, productId]);
    return rows.length > 0;
  },

  async upsertProductReview({ id, productId, customerId, rating, comment }) {
    const { rows } = await pool.query(`
      INSERT INTO product_reviews (id, product_id, customer_id, rating, comment)
      VALUES ($1, $2, $3, $4, $5)
      ON CONFLICT (product_id, customer_id) DO UPDATE SET rating = $4, comment = $5
      RETURNING *
    `, [id, productId, customerId, rating, comment || null]);
    return rows[0];
  },

  async getProductReviews(productId) {
    const { rows } = await pool.query(`
      SELECT r.*, u.business_name AS customer_name
      FROM product_reviews r
      JOIN users u ON u.id = r.customer_id
      WHERE r.product_id = $1
      ORDER BY r.created_at DESC
    `, [productId]);
    return rows.map(r => ({
      id: r.id, rating: r.rating, comment: r.comment, customerName: r.customer_name, createdAt: r.created_at,
    }));
  },

  // ---- Stores directory (public — Marketplace "Stores" tab) -----------
  // Real vendor list with real product counts and real average rating
  // aggregated across all of that vendor's products' reviews.
  async getStorefrontVendors() {
    const { rows } = await pool.query(`
      SELECT u.id, u.business_name,
        COUNT(DISTINCT p.id)::int AS product_count,
        COALESCE(AVG(r.rating), 0)::numeric AS avg_rating,
        COUNT(r.id)::int AS review_count
      FROM users u
      LEFT JOIN products p ON p.vendor_id = u.id AND p.is_active = true
      LEFT JOIN product_reviews r ON r.product_id = p.id
      WHERE u.role = 'vendor'
      GROUP BY u.id
      ORDER BY u.business_name ASC
    `);
    return rows.map(r => ({
      id: r.id,
      businessName: r.business_name,
      productCount: r.product_count,
      avgRating: Number(r.avg_rating),
      reviewCount: r.review_count,
    }));
  },

  // ---- Vendor: real customers (from actual purchases) -----------------
  // Real per-vendor customer list — who bought from this vendor, how many
  // times, and how much they've spent. No fabricated "leads" concept.
  async getVendorCustomers(vendorId) {
    const { rows } = await pool.query(`
      SELECT u.id, u.business_name, u.email, u.phone,
        COUNT(p.id)::int AS order_count,
        COALESCE(SUM(p.total_amount), 0)::numeric AS total_spent,
        MAX(p.created_at) AS last_order_at
      FROM purchases p
      JOIN users u ON u.id = p.customer_id
      WHERE p.vendor_id = $1
      GROUP BY u.id
      ORDER BY total_spent DESC
    `, [vendorId]);
    return rows.map(r => ({
      id: r.id,
      businessName: r.business_name,
      email: r.email,
      phone: r.phone,
      orderCount: r.order_count,
      totalSpent: Number(r.total_spent),
      lastOrderAt: r.last_order_at,
    }));
  },

  // Real order-status breakdown for this vendor's purchases — replaces
  // the mockup's "Sales by Channel" (Direct/Website/Referral/Social),
  // which this app has no way to track (no traffic-source attribution
  // exists). Status IS real, tracked data.
  async getVendorOrderStatusBreakdown(vendorId) {
    const { rows } = await pool.query(`
      SELECT COALESCE(o.status, 'placed') AS status, COUNT(*)::int AS count
      FROM purchases p
      LEFT JOIN orders o ON o.id = p.delivery_order_id
      WHERE p.vendor_id = $1
      GROUP BY COALESCE(o.status, 'placed')
    `, [vendorId]);
    return rows.map(r => ({ status: r.status, count: r.count }));
  },

  // Real marketplace-wide stats for the Super Admin Vendors panel —
  // actual purchases across every vendor, and how many applications are
  // waiting on a decision. Replaces the previous version of this panel,
  // which showed unrelated Delivery-service order/agent numbers.
  async getMarketplacePlatformStats() {
    const [purchaseTotals, pendingCount] = await Promise.all([
      pool.query("SELECT COUNT(*)::int AS total_orders, COALESCE(SUM(total_amount), 0)::numeric AS total_revenue FROM purchases"),
      pool.query("SELECT COUNT(*)::int AS count FROM users WHERE role = 'vendor' AND approval_status = 'pending'"),
    ]);
    return {
      totalMarketplaceOrders: purchaseTotals.rows[0].total_orders,
      totalMarketplaceRevenue: Number(purchaseTotals.rows[0].total_revenue),
      pendingVendorApplications: pendingCount.rows[0].count,
    };
  },
};

module.exports = db;
