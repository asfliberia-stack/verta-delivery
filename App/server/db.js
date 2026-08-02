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
    privacyPolicy: r.privacy_policy,
    termsOfService: r.terms_of_service,
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

function rowToAddress(r) {
  if (!r) return null;
  return { id: r.id, label: r.label, address: r.address, isDefault: r.is_default, createdAt: r.created_at };
}

function rowToMessage(r) {
  if (!r) return null;
  return { id: r.id, conversationId: r.conversation_id, senderId: r.sender_id, body: r.body, createdAt: r.created_at, readAt: r.read_at };
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
    storeAddress: r.store_address,
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
  async updateUserProfile(userId, { businessName, phone, storeAddress }) {
    // storeAddress === undefined means "don't touch this field" (e.g. a
    // non-vendor caller, where it's never part of the payload at all).
    // Anything else — including an explicit null/empty string — means
    // "set it to this," so a vendor can actually clear their address,
    // not just ever replace it with a new non-empty value.
    const touchingAddress = storeAddress !== undefined;
    const { rows } = await pool.query(
      `UPDATE users SET business_name = $1, phone = $2,
         store_address = CASE WHEN $3 THEN $4 ELSE store_address END
       WHERE id = $5 RETURNING *`,
      [businessName, phone || null, touchingAddress, touchingAddress ? (storeAddress || null) : null, userId]
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
      privacyPolicy: 'privacy_policy',
      termsOfService: 'terms_of_service',
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

  // ---- Restore Database -------------------------------------------------
  // Deliberately restores ONLY what exportAllData() actually captures:
  // orders, expenses, agents. Customer/vendor ACCOUNTS are never touched
  // by a restore — the export excludes password hashes (correctly, for
  // security), so recreating those rows here would leave every restored
  // account unable to log in. An identity/auth table should never be
  // silently destroyed and rebuilt by a data restore anyway; this is a
  // deliberate scope limit, not an oversight.

  // Dry-run — checks the file's shape and cross-references it against
  // the CURRENT database (specifically: do the customers referenced by
  // these orders still exist?) without changing anything. Real restore
  // execution is a separate step, gated on this passing.
  async validateRestorePayload(data) {
    const errors = [];
    if (!data || !Array.isArray(data.orders) || !Array.isArray(data.expenses) || !Array.isArray(data.agents)) {
      return {
        valid: false,
        errors: ["This doesn't look like a real export from this app — expected orders/expenses/agents arrays weren't found."],
        counts: null, missingSenderIds: [],
      };
    }
    const senderIds = [...new Set(data.orders.map(o => o.senderId).filter(Boolean))];
    let missingSenderIds = [];
    if (senderIds.length > 0) {
      const { rows } = await pool.query('SELECT id FROM users WHERE id = ANY($1)', [senderIds]);
      const existing = new Set(rows.map(r => r.id));
      missingSenderIds = senderIds.filter(id => !existing.has(id));
    }
    if (missingSenderIds.length > 0) {
      errors.push(`${missingSenderIds.length} order(s) in this file belong to customer account(s) that no longer exist in this database (likely deleted since this backup was taken) — restore cancelled rather than creating orders with a broken reference.`);
    }
    return {
      valid: errors.length === 0,
      errors,
      counts: { orders: data.orders.length, expenses: data.expenses.length, agents: data.agents.length },
      missingSenderIds,
    };
  },

  // Real restore — replaces every current order/expense/agent with the
  // ones in the file, inside one transaction (all-or-nothing: if any
  // row fails to insert, everything rolls back and nothing changes).
  async restoreFromExport(data) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('DELETE FROM orders');
      await client.query('DELETE FROM expenses');
      await client.query('DELETE FROM agents');

      for (const o of data.orders) {
        await client.query(
          `INSERT INTO orders (id, sender_id, sender_name, pickup_address, dropoff_address, item_description, amount, status, accepted_by, payment_method, placed_by_admin, created_at, accepted_at, picked_up_at, delivered_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
          [o.id, o.senderId, o.senderName, o.pickupAddress, o.dropoffAddress, o.itemDescription, o.amount,
           o.status, o.acceptedBy || null, o.paymentMethod || null, !!o.placedByAdmin,
           o.createdAt, o.acceptedAt || null, o.pickedUpAt || null, o.deliveredAt || null]
        );
      }
      for (const e of data.expenses) {
        await client.query(
          `INSERT INTO expenses (id, date, amount, description) VALUES ($1,$2,$3,$4)`,
          [e.id, e.date, e.amount, e.description]
        );
      }
      for (const a of data.agents) {
        await client.query(
          `INSERT INTO agents (id, name, phone, duty_status) VALUES ($1,$2,$3,$4)`,
          [a.id, a.name, a.phone, a.dutyStatus || 'off_duty']
        );
      }

      await client.query('COMMIT');
      return { ordersRestored: data.orders.length, expensesRestored: data.expenses.length, agentsRestored: data.agents.length };
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
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
      SELECT p.*, u.business_name AS vendor_name, u.phone AS vendor_phone, u.store_address AS vendor_store_address,
        COALESCE(AVG(r.rating), 0)::numeric AS avg_rating,
        COUNT(DISTINCT r.id)::int AS review_count,
        COALESCE(sold.units_sold, 0)::int AS units_sold,
        promo.discount_percent, promo.ends_at AS promo_ends_at
      FROM products p
      JOIN users u ON u.id = p.vendor_id
      LEFT JOIN product_reviews r ON r.product_id = p.id
      LEFT JOIN (
        SELECT product_id, SUM(quantity)::int AS units_sold
        FROM purchase_items
        GROUP BY product_id
      ) sold ON sold.product_id = p.id
      LEFT JOIN (
        SELECT DISTINCT ON (product_id) product_id, discount_percent, ends_at
        FROM promotions
        WHERE starts_at <= now() AND ends_at > now()
        ORDER BY product_id, ends_at ASC
      ) promo ON promo.product_id = p.id
      WHERE p.is_active = true AND p.stock_quantity > 0
      GROUP BY p.id, u.business_name, u.phone, u.store_address, sold.units_sold, promo.discount_percent, promo.ends_at
      ORDER BY p.created_at DESC
    `);
    return rows.map(r => {
      const originalPrice = Number(r.price);
      const discountPercent = r.discount_percent ? Number(r.discount_percent) : null;
      const effectivePrice = discountPercent ? Number((originalPrice * (1 - discountPercent / 100)).toFixed(2)) : originalPrice;
      return {
        ...rowToProduct(r),
        vendorName: r.vendor_name,
        vendorPhone: r.vendor_phone,
        vendorStoreAddress: r.vendor_store_address,
        avgRating: Number(r.avg_rating),
        reviewCount: r.review_count,
        unitsSold: r.units_sold,
        originalPrice,
        price: effectivePrice, // the price everywhere else in the app already reads
        discountPercent,
        promoEndsAt: r.promo_ends_at,
      };
    });
  },

  async getActiveDeals() {
    const products = await db.getActiveProductsForStorefront();
    return products.filter(p => p.discountPercent);
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

        // Real price, looked up fresh in the same transaction — never
        // trusts a client-supplied price, and always reflects any
        // currently-active promotion discount, not just the list price.
        const promoRes = await client.query(
          'SELECT discount_percent FROM promotions WHERE product_id = $1 AND starts_at <= now() AND ends_at > now() LIMIT 1',
          [product.id]
        );
        const discountPercent = promoRes.rows[0] ? Number(promoRes.rows[0].discount_percent) : 0;
        const unitPrice = discountPercent
          ? Number((Number(product.price) * (1 - discountPercent / 100)).toFixed(2))
          : Number(product.price);

        const lineTotal = unitPrice * item.quantity;
        totalAmount += lineTotal;
        lineItems.push({ productId: product.id, productName: product.name, unitPrice, quantity: item.quantity });
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

  // Real customer-facing purchase history — vendor name, real delivery
  // status (via the linked delivery order), and the actual items
  // bought (name/price/quantity + the product's CURRENT image, since
  // no image snapshot is stored at purchase time — if a product was
  // later deleted or its photo changed, this reflects that rather than
  // showing a stale copy).
  async getPurchasesByCustomer(customerId, limit = 50) {
    const { rows } = await pool.query(`
      SELECT p.*, u.business_name AS vendor_name, o.status AS delivery_status,
        (
          SELECT json_agg(json_build_object(
            'productId', pi.product_id,
            'productName', pi.product_name,
            'unitPrice', pi.unit_price,
            'quantity', pi.quantity,
            'imageDataUrl', prod.image_data_url
          ) ORDER BY pi.id)
          FROM purchase_items pi
          LEFT JOIN products prod ON prod.id = pi.product_id
          WHERE pi.purchase_id = p.id
        ) AS items
      FROM purchases p
      JOIN users u ON u.id = p.vendor_id
      LEFT JOIN orders o ON o.id = p.delivery_order_id
      WHERE p.customer_id = $1
      ORDER BY p.created_at DESC
      LIMIT $2
    `, [customerId, limit]);
    return rows.map(r => ({
      ...rowToPurchase(r),
      vendorName: r.vendor_name,
      deliveryStatus: r.delivery_status,
      items: (r.items || []).map(i => ({
        productId: i.productId, productName: i.productName,
        unitPrice: Number(i.unitPrice), quantity: i.quantity, imageDataUrl: i.imageDataUrl,
      })),
    }));
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

  // ---- Wishlist ---------------------------------------------------------

  async addToWishlist(customerId, productId) {
    await pool.query(
      `INSERT INTO wishlist_items (id, customer_id, product_id) VALUES ($1, $2, $3)
       ON CONFLICT (customer_id, product_id) DO NOTHING`,
      [crypto.randomUUID(), customerId, productId]
    );
  },

  async removeFromWishlist(customerId, productId) {
    await pool.query('DELETE FROM wishlist_items WHERE customer_id = $1 AND product_id = $2', [customerId, productId]);
  },

  // Full product data (same shape as the storefront listing) for
  // rendering the actual Wishlist tab — not just a list of IDs.
  async getWishlist(customerId) {
    const { rows } = await pool.query(`
      SELECT p.*, u.business_name AS vendor_name, w.created_at AS wishlisted_at,
        COALESCE(AVG(r.rating), 0)::numeric AS avg_rating,
        COUNT(DISTINCT r.id)::int AS review_count,
        COALESCE(sold.units_sold, 0)::int AS units_sold
      FROM wishlist_items w
      JOIN products p ON p.id = w.product_id
      JOIN users u ON u.id = p.vendor_id
      LEFT JOIN product_reviews r ON r.product_id = p.id
      LEFT JOIN (
        SELECT product_id, SUM(quantity)::int AS units_sold
        FROM purchase_items
        GROUP BY product_id
      ) sold ON sold.product_id = p.id
      WHERE w.customer_id = $1
      GROUP BY p.id, u.business_name, w.created_at, sold.units_sold
      ORDER BY w.created_at DESC
    `, [customerId]);
    return rows.map(r => ({
      ...rowToProduct(r),
      vendorName: r.vendor_name,
      avgRating: Number(r.avg_rating),
      reviewCount: r.review_count,
      unitsSold: r.units_sold,
      wishlistedAt: r.wishlisted_at,
    }));
  },

  // Just the product IDs — cheap to fetch on marketplace load so every
  // product card/PDP can show the right heart state without a query per item.
  async getWishlistProductIds(customerId) {
    const { rows } = await pool.query('SELECT product_id FROM wishlist_items WHERE customer_id = $1', [customerId]);
    return rows.map(r => r.product_id);
  },

  // ---- Leads --------------------------------------------------------
  // Real high-intent interaction events (direct contact, inquiries,
  // cart/checkout intent, store-profile actions). Logging a lead is a
  // background side effect of a real user action — it should never
  // block or break that action if it fails, so callers wrap this in
  // try/catch and ignore errors (see server.js).

  // ---- Store Follows (mirrors wishlist_items, for stores) ------------

  async followStore(customerId, vendorId) {
    await pool.query(
      `INSERT INTO store_follows (id, customer_id, vendor_id) VALUES ($1, $2, $3)
       ON CONFLICT (customer_id, vendor_id) DO NOTHING`,
      [crypto.randomUUID(), customerId, vendorId]
    );
  },

  async unfollowStore(customerId, vendorId) {
    await pool.query('DELETE FROM store_follows WHERE customer_id = $1 AND vendor_id = $2', [customerId, vendorId]);
  },

  async getFollowedStoreIds(customerId) {
    const { rows } = await pool.query('SELECT vendor_id FROM store_follows WHERE customer_id = $1', [customerId]);
    return rows.map(r => r.vendor_id);
  },

  // ---- Saved Addresses ---------------------------------------------------

  async getSavedAddresses(customerId) {
    const { rows } = await pool.query(
      'SELECT * FROM saved_addresses WHERE customer_id = $1 ORDER BY is_default DESC, created_at DESC',
      [customerId]
    );
    return rows.map(rowToAddress);
  },

  async createSavedAddress({ id, customerId, label, address, isDefault }) {
    if (isDefault) await pool.query('UPDATE saved_addresses SET is_default = false WHERE customer_id = $1', [customerId]);
    const { rows } = await pool.query(
      'INSERT INTO saved_addresses (id, customer_id, label, address, is_default) VALUES ($1, $2, $3, $4, $5) RETURNING *',
      [id, customerId, label, address, !!isDefault]
    );
    return rowToAddress(rows[0]);
  },

  async updateSavedAddress(id, customerId, { label, address, isDefault }) {
    if (isDefault) await pool.query('UPDATE saved_addresses SET is_default = false WHERE customer_id = $1', [customerId]);
    const { rows } = await pool.query(
      'UPDATE saved_addresses SET label = $1, address = $2, is_default = $3 WHERE id = $4 AND customer_id = $5 RETURNING *',
      [label, address, !!isDefault, id, customerId]
    );
    return rows[0] ? rowToAddress(rows[0]) : null;
  },

  async deleteSavedAddress(id, customerId) {
    const { rows } = await pool.query(
      'DELETE FROM saved_addresses WHERE id = $1 AND customer_id = $2 RETURNING id',
      [id, customerId]
    );
    return rows.length > 0;
  },

  // ---- Promotions ---------------------------------------------------

  // Rejects if this product already has a promotion whose window
  // overlaps the requested one — one active/future discount per
  // product at a time, so there's never ambiguity about which % applies.
  // ---- Messages -----------------------------------------------------

  // One conversation per (customer, vendor) pair, reused for every
  // future exchange — created on first contact, found thereafter.
  async getOrCreateConversation(customerId, vendorId) {
    const existing = await pool.query(
      'SELECT * FROM conversations WHERE customer_id = $1 AND vendor_id = $2',
      [customerId, vendorId]
    );
    if (existing.rows[0]) return { conversation: existing.rows[0], wasCreated: false };
    const { rows } = await pool.query(
      'INSERT INTO conversations (id, customer_id, vendor_id) VALUES ($1, $2, $3) RETURNING *',
      [crypto.randomUUID(), customerId, vendorId]
    );
    return { conversation: rows[0], wasCreated: true };
  },

  async getConversationById(conversationId) {
    const { rows } = await pool.query('SELECT * FROM conversations WHERE id = $1', [conversationId]);
    return rows[0] || null;
  },

  // Real conversation list — the other party's name, the actual last
  // message preview, and a real unread count (messages in this
  // conversation not sent by the viewer, not yet marked read).
  async getConversationsForUser(userId, role) {
    const otherPartyColumn = role === 'vendor' ? 'c.customer_id' : 'c.vendor_id';
    const { rows } = await pool.query(`
      SELECT c.id, c.created_at, u.business_name AS other_party_name, u.id AS other_party_id,
        (SELECT body FROM messages m WHERE m.conversation_id = c.id ORDER BY m.created_at DESC LIMIT 1) AS last_message,
        (SELECT created_at FROM messages m WHERE m.conversation_id = c.id ORDER BY m.created_at DESC LIMIT 1) AS last_message_at,
        (SELECT COUNT(*)::int FROM messages m WHERE m.conversation_id = c.id AND m.sender_id != $1 AND m.read_at IS NULL) AS unread_count
      FROM conversations c
      JOIN users u ON u.id = ${otherPartyColumn}
      WHERE ${role === 'vendor' ? 'c.vendor_id' : 'c.customer_id'} = $1
      ORDER BY last_message_at DESC NULLS LAST, c.created_at DESC
    `, [userId]);
    return rows.map(r => ({
      id: r.id,
      otherPartyId: r.other_party_id,
      otherPartyName: r.other_party_name,
      lastMessage: r.last_message,
      lastMessageAt: r.last_message_at,
      unreadCount: r.unread_count,
      createdAt: r.created_at,
    }));
  },

  async sendMessageToConversation({ id, conversationId, senderId, body }) {
    const { rows } = await pool.query(
      'INSERT INTO messages (id, conversation_id, sender_id, body) VALUES ($1, $2, $3, $4) RETURNING *',
      [id, conversationId, senderId, body]
    );
    return rowToMessage(rows[0]);
  },

  async getConversationMessages(conversationId) {
    const { rows } = await pool.query(
      'SELECT * FROM messages WHERE conversation_id = $1 ORDER BY created_at ASC',
      [conversationId]
    );
    return rows.map(rowToMessage);
  },

  async markConversationRead(conversationId, readerId) {
    await pool.query(
      'UPDATE messages SET read_at = now() WHERE conversation_id = $1 AND sender_id != $2 AND read_at IS NULL',
      [conversationId, readerId]
    );
  },

  // ---- Promotions / Deals --------------------------------------------

  // Rejects overlapping promotions on the same product — a product can
  // only ever have one discount active (or scheduled) at a time, so
  // there's never ambiguity about which percentage actually applies.
  async createPromotion({ id, vendorId, productId, discountPercent, startsAt, endsAt }) {
    const product = await pool.query('SELECT vendor_id FROM products WHERE id = $1', [productId]);
    if (!product.rows[0]) throw new Error('Product not found');
    if (product.rows[0].vendor_id !== vendorId) throw new Error('You can only run promotions on your own products');

    const overlap = await pool.query(
      `SELECT id FROM promotions WHERE product_id = $1 AND starts_at <= $3 AND ends_at >= $2`,
      [productId, startsAt, endsAt]
    );
    if (overlap.rows.length > 0) {
      throw new Error('This product already has a promotion scheduled or active in that date range — cancel it first');
    }

    const { rows } = await pool.query(
      `INSERT INTO promotions (id, vendor_id, product_id, discount_percent, starts_at, ends_at)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
      [id, vendorId, productId, discountPercent, startsAt, endsAt]
    );
    return rows[0];
  },

  async getVendorPromotions(vendorId) {
    const { rows } = await pool.query(`
      SELECT p.*, pr.name AS product_name, pr.price AS product_price, pr.image_data_url AS product_image,
        (now() BETWEEN p.starts_at AND p.ends_at) AS is_active
      FROM promotions p
      JOIN products pr ON pr.id = p.product_id
      WHERE p.vendor_id = $1
      ORDER BY p.starts_at DESC
    `, [vendorId]);
    return rows.map(r => ({
      id: r.id,
      productId: r.product_id,
      productName: r.product_name,
      productPrice: Number(r.product_price),
      productImage: r.product_image,
      discountPercent: Number(r.discount_percent),
      startsAt: r.starts_at,
      endsAt: r.ends_at,
      isActive: r.is_active,
    }));
  },

  async deletePromotion(id, vendorId) {
    const { rows } = await pool.query(
      'DELETE FROM promotions WHERE id = $1 AND vendor_id = $2 RETURNING id',
      [id, vendorId]
    );
    return rows.length > 0;
  },

  // ---- Leads -------------------------------------------------------

  async createLead({ id, vendorId, buyerId, productId, type }) {
    const { rows } = await pool.query(
      `INSERT INTO leads (id, vendor_id, buyer_id, product_id, type) VALUES ($1, $2, $3, $4, $5) RETURNING *`,
      [id, vendorId, buyerId || null, productId || null, type]
    );
    return rows[0];
  },

  async getVendorLeads(vendorId) {
    const { rows } = await pool.query(`
      SELECT l.*, u.business_name AS buyer_name, p.name AS product_name
      FROM leads l
      LEFT JOIN users u ON u.id = l.buyer_id
      LEFT JOIN products p ON p.id = l.product_id
      WHERE l.vendor_id = $1
      ORDER BY l.created_at DESC
    `, [vendorId]);
    return rows.map(r => ({
      id: r.id,
      buyerId: r.buyer_id,
      buyerName: r.buyer_name || 'Guest',
      productId: r.product_id,
      productName: r.product_name,
      type: r.type,
      status: r.status,
      createdAt: r.created_at,
    }));
  },

  async updateLeadStatus(id, vendorId, status) {
    const { rows } = await pool.query(
      'UPDATE leads SET status = $1 WHERE id = $2 AND vendor_id = $3 RETURNING *',
      [status, id, vendorId]
    );
    return rows[0] || null;
  },

  async getVendorLeadsSummary(vendorId) {
    const { rows } = await pool.query(`
      SELECT
        COUNT(*)::int AS total,
        COUNT(*) FILTER (WHERE status = 'NEW')::int AS new_count,
        COUNT(*) FILTER (WHERE status = 'CONVERTED')::int AS converted_count
      FROM leads WHERE vendor_id = $1
    `, [vendorId]);
    return { total: rows[0].total, newCount: rows[0].new_count, convertedCount: rows[0].converted_count };
  },

  // Used inside the checkout transaction (passed the transaction's own
  // client, not the shared pool) so the discount check sees a
  // consistent snapshot alongside the FOR UPDATE product lock already
  // taken there.
  async getActivePromotionForProductTx(client, productId) {
    const { rows } = await client.query(
      'SELECT * FROM promotions WHERE product_id = $1 AND now() BETWEEN starts_at AND ends_at LIMIT 1',
      [productId]
    );
    return rows[0] || null;
  },

  // ---- Stores directory (public — Marketplace "Stores" tab) -----------
  // Real vendor list with real product counts and real average rating
  // aggregated across all of that vendor's products' reviews.
  async getStorefrontVendors() {
    const { rows } = await pool.query(`
      SELECT u.id, u.business_name, u.store_address, u.phone,
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
      storeAddress: r.store_address,
      phone: r.phone,
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
