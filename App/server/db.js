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
    deliveryCompanyId: r.delivery_company_id,
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
    deliveryCompanyId: r.delivery_company_id,
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
    // pg already parses JSONB columns into real JS values — no
    // JSON.parse needed here. Normalized to [] rather than null/undefined
    // so the frontend can always safely call .length/.map on these
    // without a product having variants vs. not having them being two
    // different shapes to check for.
    colors: r.colors || [],
    sizes: r.sizes || [],
    sizeChart: r.size_chart || null,
  };
}

function rowToHomeBanner(r) {
  if (!r) return null;
  return {
    id: r.id,
    position: r.position,
    eyebrow: r.eyebrow,
    headline: r.headline,
    subtext: r.subtext,
    ctaText: r.cta_text,
    ctaLink: r.cta_link,
    imageDataUrl: r.image_data_url,
    isActive: r.is_active,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
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
    paymentMethod: r.payment_method,
    paymentStatus: r.payment_status,
    momoReferenceId: r.momo_reference_id,
    momoPhone: r.momo_phone,
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

function rowToPlatformSettings(r) {
  if (!r) return null;
  return {
    marketplaceCommissionPercent: Number(r.marketplace_commission_percent),
    deliveryCommissionPercent: Number(r.delivery_commission_percent),
    defaultDeliveryFee: r.default_delivery_fee !== null && r.default_delivery_fee !== undefined ? Number(r.default_delivery_fee) : null,
    serviceArea: r.service_area || null,
    maintenanceMode: !!r.maintenance_mode,
    maintenanceMessage: r.maintenance_message || null,
    updatedAt: r.updated_at,
  };
}

function rowToPayout(r) {
  if (!r) return null;
  return {
    id: r.id,
    recipientType: r.recipient_type,
    recipientId: r.recipient_id,
    periodStart: r.period_start,
    periodEnd: r.period_end,
    grossAmount: Number(r.gross_amount),
    commissionRate: Number(r.commission_rate),
    commissionAmount: Number(r.commission_amount),
    netAmount: Number(r.net_amount),
    notes: r.notes,
    createdBy: r.created_by,
    createdAt: r.created_at,
  };
}

// Base row only — no joins. getDisputes()/getDisputeById() below build
// their own richer, joined shape (customer/order/purchase/vendor/
// delivery-company context) for display; this mapper is just for the
// plain INSERT/UPDATE ... RETURNING * results in createDispute/
// resolveDispute.
function rowToDispute(r) {
  if (!r) return null;
  return {
    id: r.id,
    orderId: r.order_id,
    purchaseId: r.purchase_id,
    customerId: r.customer_id,
    category: r.category,
    description: r.description,
    status: r.status,
    resolutionNote: r.resolution_note,
    refundAmount: r.refund_amount !== null && r.refund_amount !== undefined ? Number(r.refund_amount) : null,
    resolvedBy: r.resolved_by,
    resolvedAt: r.resolved_at,
    createdAt: r.created_at,
  };
}

function rowToAuditLogEntry(r) {
  if (!r) return null;
  return {
    id: r.id,
    actorId: r.actor_id,
    actorName: r.actor_name,
    actorRole: r.actor_role,
    action: r.action,
    targetType: r.target_type,
    targetId: r.target_id,
    targetLabel: r.target_label,
    details: r.details || {},
    createdAt: r.created_at,
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
    rejectionReason: r.rejection_reason || null,
    businessRegistrationDoc: r.business_registration_doc,
    idDocumentType: r.id_document_type,
    idDocumentDoc: r.id_document_doc,
    appliedAt: r.applied_at,
    createdAt: r.created_at,
    storeAddress: r.store_address,
    vendorType: r.vendor_type || 'store',
    avgPrepTimeMinutes: r.avg_prep_time_minutes,
    profileImageUrl: r.profile_image_url,
    isDisabled: r.is_disabled,
    disabledFeatures: r.disabled_features || [],
    commissionRateOverride: r.commission_rate_override !== null && r.commission_rate_override !== undefined ? Number(r.commission_rate_override) : null,
  };
}

// Shared by cancelOrderAndRestock and voidFailedMomoPayment — both
// "undo" a checkout for a different reason (customer cancelled vs.
// payment never went through), but restocking the purchased items back
// onto their products is the same operation either way. Must be called
// from inside an already-open transaction (client), not the pool
// directly, so it commits/rolls back atomically with whatever else the
// caller is doing.
async function restockPurchaseItemsInTx(client, purchaseId) {
  const { rows: items } = await client.query(
    'SELECT product_id, quantity FROM purchase_items WHERE purchase_id = $1', [purchaseId]
  );
  for (const item of items) {
    await client.query('UPDATE products SET stock_quantity = stock_quantity + $1 WHERE id = $2', [item.quantity, item.product_id]);
  }
}

const db = {
  async init() {
    const fs = require('fs');
    const path = require('path');
    const schema = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
    await pool.query(schema);
  },

  // ---- Users -------------------------------------------------------

  async createUser({ id, businessName, email, phone, passwordHash, role, approvalStatus, businessRegistrationDoc, idDocumentType, idDocumentDoc, appliedAt, vendorType }) {
    const { rows } = await pool.query(
      `INSERT INTO users (id, business_name, email, phone, password_hash, role, approval_status, business_registration_doc, id_document_type, id_document_doc, applied_at, vendor_type)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12) RETURNING *`,
      [id, businessName, email.toLowerCase(), phone || null, passwordHash, role, approvalStatus || 'approved', businessRegistrationDoc || null, idDocumentType || null, idDocumentDoc || null, appliedAt || null, vendorType === 'restaurant' ? 'restaurant' : 'store']
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
  async updateUserProfile(userId, { businessName, phone, storeAddress, avgPrepTimeMinutes }) {
    // storeAddress === undefined means "don't touch this field" (e.g. a
    // non-vendor caller, where it's never part of the payload at all).
    // Anything else — including an explicit null/empty string — means
    // "set it to this," so a vendor can actually clear their address,
    // not just ever replace it with a new non-empty value. Same
    // untouched-vs-explicit-null convention for avgPrepTimeMinutes.
    const touchingAddress = storeAddress !== undefined;
    const touchingPrepTime = avgPrepTimeMinutes !== undefined;
    const { rows } = await pool.query(
      `UPDATE users SET business_name = $1, phone = $2,
         store_address = CASE WHEN $3 THEN $4 ELSE store_address END,
         avg_prep_time_minutes = CASE WHEN $5 THEN $6 ELSE avg_prep_time_minutes END
       WHERE id = $7 RETURNING *`,
      [businessName, phone || null, touchingAddress, touchingAddress ? (storeAddress || null) : null,
       touchingPrepTime, touchingPrepTime ? avgPrepTimeMinutes : null, userId]
    );
    return rowToUser(rows[0]);
  },

  // Real profile photo update — any role, always the caller's own
  // account (the endpoint never takes a target user id). Passing null
  // removes the photo, falling back to the initial-letter avatar.
  async updateProfileImage(userId, dataUrl) {
    const { rows } = await pool.query(
      'UPDATE users SET profile_image_url = $1 WHERE id = $2 RETURNING *',
      [dataUrl || null, userId]
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

  // Real account suspension — scoped away from role = 'super_admin' in
  // the query itself, not just trusted from the caller, so this can
  // never be used to disable a Super Admin account (including
  // accidentally disabling your own). Disabling also bumps
  // token_version so any already-active session is invalidated
  // immediately on its very next request, not just future logins.
  async setUserDisabled(id, disabled) {
    const { rows } = await pool.query(
      `UPDATE users SET is_disabled = $1 WHERE id = $2 AND role != 'super_admin' RETURNING *`,
      [disabled, id]
    );
    if (rows[0] && disabled) {
      await pool.query('UPDATE users SET token_version = token_version + 1 WHERE id = $1', [id]);
    }
    return rowToUser(rows[0]);
  },

  // Super Admin cutting off specific features for a Manage Agent
  // account. Scoped away from super_admin for the same reason
  // setUserDisabled is — this can never be pointed at a Super Admin
  // account, including accidentally.
  async setDisabledFeatures(id, features) {
    const { rows } = await pool.query(
      `UPDATE users SET disabled_features = $1 WHERE id = $2 AND role != 'super_admin' RETURNING *`,
      [features, id]
    );
    return rowToUser(rows[0]);
  },

  // Promote a Manage Agent to Super Admin, or demote a Super Admin
  // back to Manage Agent. Scoped to exactly these two roles in the
  // query itself (never vendor/sender/delivery_company/etc — those
  // have their own dedicated account types, not a "level" to move up
  // or down) so this can never be misused to grant/revoke any other
  // kind of access. Also bumps token_version, same as setUserDisabled
  // above — the role is baked into every already-issued JWT, so
  // without this the account would keep operating under its old role
  // until whatever token it's holding happens to expire on its own (up
  // to 30 days).
  //
  // Promoting to super_admin also clears disabled_features. Without
  // this, a promoted account keeps whatever features were disabled on
  // it as a Manage Agent — harmless server-side (requireFeature always
  // exempts super_admin regardless of this column), but the frontend
  // used to trust that a Super Admin's disabled_features was always
  // empty and hid UI based on it unconditionally, which made Business
  // Profile (and potentially others) silently vanish for a freshly
  // promoted Super Admin who'd had it restricted back when they were
  // still Manage Agent. The frontend now checks role first too (belt
  // and suspenders), but there's no reason to leave stale restrictions
  // sitting on the row either.
  async setUserRole(id, role) {
    const { rows } = await pool.query(
      `UPDATE users SET role = $1, token_version = token_version + 1,
         disabled_features = CASE WHEN $1 = 'super_admin' THEN '{}' ELSE disabled_features END
       WHERE id = $2 AND role IN ('admin', 'super_admin') RETURNING *`,
      [role, id]
    );
    return rowToUser(rows[0]);
  },

  // How many accounts currently hold role = 'super_admin' — used to
  // block demoting the last one and leaving the platform with no one
  // able to reach the Super Admin console at all.
  async countSuperAdmins() {
    const { rows } = await pool.query(`SELECT COUNT(*)::int AS count FROM users WHERE role = 'super_admin'`);
    return rows[0].count;
  },

  // Fast permission check — used on every gated request, so this is
  // intentionally a single small query rather than fetching the full
  // user row. Takes effect immediately (no token/session dependency),
  // same as is_disabled above.
  async isFeatureDisabledForUser(id, featureKey) {
    const { rows } = await pool.query(
      'SELECT disabled_features @> ARRAY[$1]::text[] AS is_disabled FROM users WHERE id = $2',
      [featureKey, id]
    );
    return rows[0] ? rows[0].is_disabled : false;
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

  // ---- Delivery Company (multi-provider) scoped queries ----------------
  async getAgentsByCompany(companyId) {
    const { rows } = await pool.query(
      'SELECT * FROM agents WHERE delivery_company_id = $1 ORDER BY created_at ASC',
      [companyId]
    );
    return rows.map(rowToAgent);
  },

  async getOrdersByCompany(companyId) {
    const { rows } = await pool.query(
      'SELECT * FROM orders WHERE delivery_company_id = $1 ORDER BY created_at DESC',
      [companyId]
    );
    return rows.map(rowToOrder);
  },

  // Real, unassigned orders — visible to any approved delivery
  // company, matching the "first company to accept it" design. Not
  // scoped to a company, since by definition these don't belong to
  // one yet.
  async getPendingOrders() {
    const { rows } = await pool.query(
      "SELECT * FROM orders WHERE status = 'pending' ORDER BY created_at ASC"
    );
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

  // Atomic accept — the WHERE status = 'pending' guard is the actual
  // protection here, not just a nicety: now that multiple delivery
  // companies can see and try to accept the same pending order at
  // once, a plain UPDATE by id alone would let two acceptances both
  // "succeed" and silently overwrite each other. This returns null if
  // someone else's acceptance already changed the status first —
  // whichever request's UPDATE runs first wins, the second one gets
  // nothing to update and the caller can tell the user honestly that
  // someone else got there first.
  async acceptOrderAtomic(id, { amount, acceptedBy, paymentMethod, deliveryCompanyId }) {
    const { rows } = await pool.query(
      `UPDATE orders SET amount = $1, accepted_by = $2, payment_method = $3,
       status = 'accepted', accepted_at = now(), delivery_company_id = $4
       WHERE id = $5 AND status = 'pending' RETURNING *`,
      [amount, acceptedBy, paymentMethod || null, deliveryCompanyId || null, id]
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
      deliveryCompanyId: 'delivery_company_id',
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

  // Cancels a pending order and, if it's a marketplace order (linked to
  // a purchase via delivery_order_id), restocks every purchased item in
  // the same transaction — so a crash between the two steps can't leave
  // stock permanently short, and two concurrent cancel attempts on the
  // same order can't double-restock it (the UPDATE only matches while
  // status is still 'pending'). Plain delivery orders (no linked
  // purchase) just get their status flipped, same as before this
  // existed. Returns null if the order wasn't pending (already
  // cancelled/accepted/etc.) so the caller can report that cleanly.
  async cancelOrderAndRestock(id) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const { rows: orderRows } = await client.query(
        `UPDATE orders SET status = 'cancelled' WHERE id = $1 AND status = 'pending' RETURNING *`,
        [id]
      );
      if (!orderRows[0]) {
        await client.query('ROLLBACK');
        return null;
      }

      const { rows: purchaseRows } = await client.query(
        'SELECT id FROM purchases WHERE delivery_order_id = $1', [id]
      );
      if (purchaseRows[0]) {
        await restockPurchaseItemsInTx(client, purchaseRows[0].id);
      }

      await client.query('COMMIT');
      return rowToOrder(orderRows[0]);
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  },

  async getPurchaseByMomoReferenceId(referenceId) {
    const { rows } = await pool.query('SELECT * FROM purchases WHERE momo_reference_id = $1', [referenceId]);
    return rowToPurchase(rows[0]);
  },

  // Flips a pending Mobile Money purchase to 'successful' once MTN
  // confirms the payment, and — only now, not at checkout time — creates
  // the real delivery order from the pending_pickup_address/
  // pending_dropoff_address stashed on the purchase (see checkout()'s
  // comment on why order creation is deferred for this payment method).
  // Scoped to payment_status = 'pending' so a late/duplicate webhook
  // firing after the polling path already confirmed it (or vice versa)
  // is a safe no-op, not a double-apply/double-order. Returns null if
  // the purchase was already resolved (paid or already voided).
  async confirmMomoPaymentAndCreateOrder(purchaseId) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const { rows: purchaseRows } = await client.query(
        `UPDATE purchases SET payment_status = 'successful' WHERE id = $1 AND payment_status = 'pending' RETURNING *`,
        [purchaseId]
      );
      if (!purchaseRows[0]) {
        await client.query('ROLLBACK');
        return null;
      }
      const purchase = purchaseRows[0];

      let deliveryOrderId = null;
      if (purchase.pending_pickup_address && purchase.pending_dropoff_address) {
        const { rows: itemRows } = await client.query(
          'SELECT product_name, quantity, selected_color, selected_size FROM purchase_items WHERE purchase_id = $1', [purchaseId]
        );
        // Same variant-in-summary treatment as checkout()'s COD path —
        // this is the Mobile Money path's equivalent moment of creating
        // the real delivery order, so it needs the same fix or a
        // color/size picked at checkout silently vanishes from what the
        // delivery agent/vendor actually sees.
        const itemSummary = itemRows.map(li => {
          const variantBits = [li.selected_color, li.selected_size].filter(Boolean).join(', ');
          return `${li.quantity}x ${li.product_name}${variantBits ? ` (${variantBits})` : ''}`;
        }).join(', ');
        const { rows: custRows } = await client.query('SELECT business_name FROM users WHERE id = $1', [purchase.customer_id]);
        deliveryOrderId = `ORD-${Date.now().toString(36).toUpperCase()}${crypto.randomBytes(2).toString('hex').toUpperCase()}M`;
        await client.query(
          `INSERT INTO orders (id, sender_id, sender_name, pickup_address, dropoff_address, item_description, amount, status, placed_by_admin)
           VALUES ($1, $2, $3, $4, $5, $6, $7, 'pending', false)`,
          [deliveryOrderId, purchase.customer_id, custRows[0] ? custRows[0].business_name : 'Customer',
            purchase.pending_pickup_address, purchase.pending_dropoff_address, `Marketplace order: ${itemSummary}`, null]
        );
        await client.query(
          `UPDATE purchases SET delivery_order_id = $1, pending_pickup_address = NULL, pending_dropoff_address = NULL WHERE id = $2`,
          [deliveryOrderId, purchaseId]
        );
      }

      await client.query('COMMIT');
      return { purchase: rowToPurchase({ ...purchase, delivery_order_id: deliveryOrderId, payment_status: 'successful' }), deliveryOrderId };
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  },

  // The payment-side equivalent of cancelOrderAndRestock: MTN reported
  // the Request to Pay as failed/rejected/timed out, so nothing was
  // actually paid for — restock the items (stock was reserved
  // optimistically at initiation, same as any other checkout) in one
  // transaction. Scoped to payment_status = 'pending' for the same
  // no-double-restock reasoning as cancelOrderAndRestock. Returns null
  // if the purchase was already resolved (paid or already voided).
  async voidFailedMomoPayment(purchaseId) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const { rows: purchaseRows } = await client.query(
        `UPDATE purchases SET payment_status = 'failed' WHERE id = $1 AND payment_status = 'pending' RETURNING *`,
        [purchaseId]
      );
      if (!purchaseRows[0]) {
        await client.query('ROLLBACK');
        return null;
      }
      await restockPurchaseItemsInTx(client, purchaseId);
      if (purchaseRows[0].delivery_order_id) {
        await client.query(
          `UPDATE orders SET status = 'cancelled' WHERE id = $1 AND status = 'pending'`,
          [purchaseRows[0].delivery_order_id]
        );
      }
      await client.query('COMMIT');
      return rowToPurchase(purchaseRows[0]);
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
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

  async getAgentById(id) {
    const { rows } = await pool.query('SELECT * FROM agents WHERE id = $1', [id]);
    return rowToAgent(rows[0]);
  },

  async getAllAgents() {
    const { rows } = await pool.query('SELECT * FROM agents ORDER BY created_at ASC');
    return rows.map(rowToAgent);
  },

  // LEGACY FALLBACK ONLY. order:accept in server.js now resolves the
  // agent by id (getAgentById, below) — the real fix for the collision
  // risk this function has: with no uniqueness constraint on `name`,
  // two agents sharing a name (even across two different companies)
  // could match the wrong row via this unordered `LIMIT 1`, silently
  // misattributing an order's company or wrongly denying a delivery
  // company's own accept. This still exists only so a browser tab
  // holding pre-fix JS during a rolling deploy doesn't hard-fail; once
  // every client has reloaded, this path is never exercised. Do not use
  // this for any new code — use getAgentById.
  async getAgentByName(name) {
    const { rows } = await pool.query('SELECT * FROM agents WHERE name = $1 LIMIT 1', [name]);
    return rowToAgent(rows[0]);
  },

  async countAgents() {
    const { rows } = await pool.query('SELECT COUNT(*)::int AS count FROM agents');
    return rows[0].count;
  },

  // Backward-compat migration for the multi-provider delivery system —
  // links every agent that doesn't yet have a delivery_company_id to
  // the given company (the primary admin account, representing Verta
  // Delivery Service's own fleet). Safe to call on every boot: only
  // touches agents still missing one.
  async linkOrphanedAgentsToCompany(companyId) {
    const { rowCount } = await pool.query(
      'UPDATE agents SET delivery_company_id = $1 WHERE delivery_company_id IS NULL',
      [companyId]
    );
    return rowCount;
  },

  // Moves an entire fleet — agents AND their order history — from one
  // company to another. Used exactly once, when Verta's own
  // delivery_company account is first created, to move the fleet that
  // was previously linked to the Manage Agent account over to it.
  async reassignFleetToCompany(fromCompanyId, toCompanyId) {
    const agentsResult = await pool.query(
      'UPDATE agents SET delivery_company_id = $1 WHERE delivery_company_id = $2',
      [toCompanyId, fromCompanyId]
    );
    const ordersResult = await pool.query(
      'UPDATE orders SET delivery_company_id = $1 WHERE delivery_company_id = $2',
      [toCompanyId, fromCompanyId]
    );
    return { agentsMoved: agentsResult.rowCount, ordersMoved: ordersResult.rowCount };
  },

  async createAgent({ id, name, phone, deliveryCompanyId }) {
    const { rows } = await pool.query(
      `INSERT INTO agents (id, name, phone, delivery_company_id) VALUES ($1, $2, $3, $4) RETURNING *`,
      [id, name, phone, deliveryCompanyId || null]
    );
    return rowToAgent(rows[0]);
  },

  // deliveryCompanyId: undefined = leave the agent's current company
  // unchanged (the normal case — a delivery company editing its own
  // agent's name/phone, or an admin doing the same without reassigning
  // it). Any other value (including null) is written through, so an
  // admin reassigning a legacy/unassigned agent to a real company goes
  // through this same path as a name/phone edit.
  async updateAgent(id, { name, phone, deliveryCompanyId }) {
    if (deliveryCompanyId !== undefined) {
      const { rows } = await pool.query(
        `UPDATE agents SET name = $1, phone = $2, delivery_company_id = $3 WHERE id = $4 RETURNING *`,
        [name, phone, deliveryCompanyId, id]
      );
      return rowToAgent(rows[0]);
    }
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

  // Hard delete — safe to do: nothing in the schema has a foreign key
  // pointing at agents.id (accepted_by on orders is a free-text
  // snapshot of the agent's name, not a reference — see the comment on
  // the agents table in schema.sql), so removing an agent never breaks
  // historical order records.
  async deleteAgent(id) {
    const { rowCount } = await pool.query('DELETE FROM agents WHERE id = $1', [id]);
    return rowCount > 0;
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
        u.id, u.business_name, u.email, u.phone, u.created_at, u.is_disabled,
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
      isDisabled: r.is_disabled,
      totalOrders: r.total_orders,
      totalSpent: Number(r.total_spent),
      lastOrderAt: r.last_order_at,
    }));
  },

  // Super Admin editing a customer's own account details directly —
  // scoped to role = 'sender' so this can never be pointed at a
  // vendor or admin account by accident.
  async updateCustomerByAdmin(id, { businessName, email, phone }) {
    const { rows } = await pool.query(
      `UPDATE users SET business_name = $1, email = $2, phone = $3
       WHERE id = $4 AND role = 'sender' RETURNING *`,
      [businessName, email.toLowerCase(), phone || null, id]
    );
    return rowToUser(rows[0]);
  },

  // Super Admin editing a staff (Manage Agent) account directly — scoped
  // to role = 'admin' so this can never be pointed at any other account.
  // Reused for every staff account now, not just a single fixed one.
  async updateManageAgentAccount(id, { businessName, email, phone }) {
    const { rows } = await pool.query(
      `UPDATE users SET business_name = $1, email = $2, phone = $3
       WHERE id = $4 AND role = 'admin' RETURNING *`,
      [businessName, email.toLowerCase(), phone || null, id]
    );
    return rowToUser(rows[0]);
  },

  // Real delete — cascades to the customer's own orders, purchases,
  // reviews, wishlist, addresses, conversations, and messages (all
  // foreign keys to users.id are ON DELETE CASCADE). This is genuinely
  // destructive and irreversible; the caller is responsible for real
  // confirmation before calling this. Scoped to role = 'sender' so
  // this endpoint can never delete a vendor or admin account.
  async deleteCustomer(id) {
    const { rows } = await pool.query(
      `DELETE FROM users WHERE id = $1 AND role = 'sender' RETURNING id`,
      [id]
    );
    return rows.length > 0;
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
      "SELECT id, business_name, email, phone, approval_status, rejection_reason, applied_at, created_at, is_disabled, commission_rate_override, vendor_type FROM users WHERE role = 'vendor' ORDER BY created_at DESC"
    );
    return rows.map(r => ({
      id: r.id,
      businessName: r.business_name,
      email: r.email,
      phone: r.phone,
      approvalStatus: r.approval_status,
      rejectionReason: r.rejection_reason || null,
      appliedAt: r.applied_at,
      createdAt: r.created_at,
      isDisabled: r.is_disabled,
      commissionRateOverride: r.commission_rate_override !== null && r.commission_rate_override !== undefined ? Number(r.commission_rate_override) : null,
      vendorType: r.vendor_type || 'store',
    }));
  },

  // ---- Staff accounts — role = 'admin' ("Manage Agent") or
  // 'super_admin', shown together in one list so Change Role has
  // something to toggle between. No approval workflow (a Super Admin
  // creating one here IS the approval, same as Add Vendor/Add Delivery
  // Company), so no approval_status/rejection_reason/applied_at
  // columns to select. ----
  async getStaffAccounts() {
    const { rows } = await pool.query(
      "SELECT id, business_name, email, phone, role, created_at, is_disabled, disabled_features FROM users WHERE role IN ('admin', 'super_admin') ORDER BY (role = 'super_admin') DESC, created_at ASC"
    );
    return rows.map(r => ({
      id: r.id,
      businessName: r.business_name,
      email: r.email,
      phone: r.phone,
      role: r.role,
      createdAt: r.created_at,
      isDisabled: r.is_disabled,
      disabledFeatures: r.disabled_features || [],
    }));
  },

  // ---- Delivery Companies (multi-provider fleets — same real
  // self-registration + Super Admin approval workflow as vendors
  // above, mirrored exactly, scoped to role = 'delivery_company'). ----
  async getDeliveryCompanies() {
    const { rows } = await pool.query(
      "SELECT id, business_name, email, phone, approval_status, rejection_reason, applied_at, created_at, is_disabled, commission_rate_override FROM users WHERE role = 'delivery_company' ORDER BY created_at DESC"
    );
    return rows.map(r => ({
      id: r.id,
      businessName: r.business_name,
      email: r.email,
      phone: r.phone,
      approvalStatus: r.approval_status,
      rejectionReason: r.rejection_reason || null,
      appliedAt: r.applied_at,
      createdAt: r.created_at,
      isDisabled: r.is_disabled,
      commissionRateOverride: r.commission_rate_override !== null && r.commission_rate_override !== undefined ? Number(r.commission_rate_override) : null,
    }));
  },

  // Lightweight list for the Fleet Directory's "which delivery company
  // owns this agent" picker (see the agent:create/agent:update comment
  // in server.js). Any admin-like account needs this, not just Super
  // Admin — but unlike getDeliveryCompanies() above, this only returns
  // companies actually able to receive a new agent right now (approved,
  // not disabled), and skips management-only fields (rejection reason,
  // commission override) the picker has no use for.
  async getActiveDeliveryCompaniesForFleetPicker() {
    const { rows } = await pool.query(
      "SELECT id, business_name FROM users WHERE role = 'delivery_company' AND approval_status = 'approved' AND is_disabled = false ORDER BY business_name ASC"
    );
    return rows.map(r => ({ id: r.id, businessName: r.business_name }));
  },

  // reason is required by the caller (server.js) when status ===
  // 'rejected'; when status === 'approved' (or any other value), the
  // previous rejection reason — if any — is cleared automatically, so
  // a fresh approval never carries a stale explanation forward.
  async setDeliveryCompanyApprovalStatus(id, status, reason = null) {
    const { rows } = await pool.query(
      "UPDATE users SET approval_status = $1, rejection_reason = $2 WHERE id = $3 AND role = 'delivery_company' RETURNING *",
      [status, status === 'rejected' ? reason : null, id]
    );
    return rowToUser(rows[0]);
  },

  async getDeliveryCompanyApplicationDocuments(id) {
    const { rows } = await pool.query(
      "SELECT business_registration_doc, id_document_type, id_document_doc FROM users WHERE id = $1 AND role = 'delivery_company'",
      [id]
    );
    if (!rows[0]) return null;
    return {
      businessRegistrationDoc: rows[0].business_registration_doc,
      idDocumentType: rows[0].id_document_type,
      idDocumentDoc: rows[0].id_document_doc,
    };
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

  // Same reason-handling as setDeliveryCompanyApprovalStatus above —
  // required by the caller when rejecting, cleared on any other status.
  async setVendorApprovalStatus(vendorId, status, reason = null) {
    const { rows } = await pool.query(
      "UPDATE users SET approval_status = $1, rejection_reason = $2 WHERE id = $3 AND role = 'vendor' RETURNING *",
      [status, status === 'rejected' ? reason : null, vendorId]
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
    const { rows } = await pool.query(`
      SELECT p.*,
        (
          SELECT json_agg(json_build_object('id', pi.id, 'imageDataUrl', pi.image_data_url) ORDER BY pi.position, pi.created_at)
          FROM product_images pi WHERE pi.product_id = p.id
        ) AS extra_images
      FROM products p WHERE p.vendor_id = $1 ORDER BY p.created_at DESC
    `, [vendorId]);
    return rows.map(r => ({ ...rowToProduct(r), images: r.extra_images || [] }));
  },

  // Storefront listing — every active product from every vendor, with
  // the vendor's business name attached so the storefront can show it.
  async getActiveProductsForStorefront() {
    const { rows } = await pool.query(`
      SELECT p.*, u.business_name AS vendor_name, u.phone AS vendor_phone, u.store_address AS vendor_store_address,
        COALESCE(AVG(r.rating), 0)::numeric AS avg_rating,
        COUNT(DISTINCT r.id)::int AS review_count,
        COALESCE(sold.units_sold, 0)::int AS units_sold,
        promo.discount_percent, promo.ends_at AS promo_ends_at,
        (
          SELECT json_agg(json_build_object('id', pi.id, 'imageDataUrl', pi.image_data_url) ORDER BY pi.position, pi.created_at)
          FROM product_images pi WHERE pi.product_id = p.id
        ) AS extra_images
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
      WHERE p.is_active = true AND p.stock_quantity > 0 AND u.vendor_type = 'store'
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
        images: r.extra_images || [],
      };
    });
  },

  // ONLib Delivery's restaurant menu — deliberately a separate query
  // from getActiveProductsForStorefront above, not a client-side filter
  // of it: that one is now Marketplace-only (vendor_type = 'store'), so
  // restaurant dishes need their own path that never touches the
  // Marketplace product feed. Same shape/fields as the Marketplace
  // query (rating, reviews, promo price) so the dish cards work
  // identically, just scoped to one restaurant vendor.
  async getRestaurantMenu(vendorId) {
    const { rows } = await pool.query(`
      SELECT p.*, u.business_name AS vendor_name, u.phone AS vendor_phone, u.store_address AS vendor_store_address,
        COALESCE(AVG(r.rating), 0)::numeric AS avg_rating,
        COUNT(DISTINCT r.id)::int AS review_count,
        promo.discount_percent, promo.ends_at AS promo_ends_at
      FROM products p
      JOIN users u ON u.id = p.vendor_id
      LEFT JOIN product_reviews r ON r.product_id = p.id
      LEFT JOIN (
        SELECT DISTINCT ON (product_id) product_id, discount_percent, ends_at
        FROM promotions
        WHERE starts_at <= now() AND ends_at > now()
        ORDER BY product_id, ends_at ASC
      ) promo ON promo.product_id = p.id
      WHERE p.is_active = true AND p.vendor_id = $1 AND u.vendor_type = 'restaurant'
      GROUP BY p.id, u.business_name, u.phone, u.store_address, promo.discount_percent, promo.ends_at
      ORDER BY p.created_at DESC
    `, [vendorId]);
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
        originalPrice,
        price: effectivePrice,
        discountPercent,
        promoEndsAt: r.promo_ends_at,
      };
    });
  },

  // Super Admin product moderation — every product from every vendor,
  // active or hidden, in or out of stock (unlike getActiveProductsForStorefront,
  // which is deliberately filtered for the customer-facing feed).
  async getAllProductsForModeration() {
    const { rows } = await pool.query(`
      SELECT p.*, u.business_name AS vendor_name
      FROM products p
      JOIN users u ON u.id = p.vendor_id
      ORDER BY p.created_at DESC
    `);
    return rows.map(r => ({ ...rowToProduct(r), vendorName: r.vendor_name }));
  },

  async getActiveDeals() {
    const products = await db.getActiveProductsForStorefront();
    return products.filter(p => p.discountPercent);
  },

  async getProductById(id) {
    const { rows } = await pool.query('SELECT * FROM products WHERE id = $1', [id]);
    return rowToProduct(rows[0]);
  },

  async createProduct({ id, vendorId, name, description, price, category, imageDataUrl, stockQuantity, colors, sizes, sizeChart }) {
    const { rows } = await pool.query(
      `INSERT INTO products (id, vendor_id, name, description, price, category, image_data_url, stock_quantity, colors, sizes, size_chart)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) RETURNING *`,
      [
        id, vendorId, name, description || null, price, category || null, imageDataUrl || null, stockQuantity || 0,
        // Explicit JSON.stringify before handing JSONB columns to pg —
        // matches the one other JSONB write site in this file
        // (createAuditLogEntry) rather than relying on implicit
        // serialization. Empty/absent lists are stored as NULL, same as
        // "no variants" everywhere else, instead of an empty-array JSONB
        // value — keeps "does this product have variants" a simple NULL
        // check in every SQL query that needs it.
        colors && colors.length ? JSON.stringify(colors) : null,
        sizes && sizes.length ? JSON.stringify(sizes) : null,
        sizeChart ? JSON.stringify(sizeChart) : null,
      ]
    );
    return rowToProduct(rows[0]);
  },

  async updateProduct(id, fields) {
    const colMap = {
      name: 'name', description: 'description', price: 'price', category: 'category',
      imageDataUrl: 'image_data_url', stockQuantity: 'stock_quantity', isActive: 'is_active',
      colors: 'colors', sizes: 'sizes', sizeChart: 'size_chart',
    };
    // These three are JSONB columns — stringify explicitly (see
    // createProduct above) and normalize empty arrays/falsy to NULL
    // rather than storing '[]', so "no variants" stays a plain NULL
    // check everywhere.
    const jsonKeys = new Set(['colors', 'sizes', 'sizeChart']);
    const sets = []; const values = []; let i = 1;
    for (const [key, col] of Object.entries(colMap)) {
      if (Object.prototype.hasOwnProperty.call(fields, key)) {
        let value = fields[key];
        if (jsonKeys.has(key)) {
          value = value && (Array.isArray(value) ? value.length : true) ? JSON.stringify(value) : null;
        }
        sets.push(`${col} = $${i}`); values.push(value); i += 1;
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

  // ---- Marketplace: additional product photos (gallery) ----------------

  async countProductImages(productId) {
    const { rows } = await pool.query('SELECT COUNT(*)::int AS count FROM product_images WHERE product_id = $1', [productId]);
    return rows[0].count;
  },

  async addProductImage({ id, productId, imageDataUrl }) {
    const { rows: posRows } = await pool.query('SELECT COALESCE(MAX(position), -1) + 1 AS next_position FROM product_images WHERE product_id = $1', [productId]);
    const { rows } = await pool.query(
      'INSERT INTO product_images (id, product_id, image_data_url, position) VALUES ($1, $2, $3, $4) RETURNING *',
      [id, productId, imageDataUrl, posRows[0].next_position]
    );
    return { id: rows[0].id, productId: rows[0].product_id, imageDataUrl: rows[0].image_data_url };
  },

  // Scoped to product_id too, not just the image id — so a vendor can
  // never delete an image belonging to a product that isn't theirs
  // (the route also checks product ownership, but this is cheap
  // belt-and-suspenders since it's a single indexed WHERE clause).
  async deleteProductImage(id, productId) {
    const { rowCount } = await pool.query('DELETE FROM product_images WHERE id = $1 AND product_id = $2', [id, productId]);
    return rowCount > 0;
  },

  // ---- Marketplace: home-screen hero carousel ---------------------------

  // Public — storefront-facing, active slides only, in display order.
  async getActiveHomeBanners() {
    const { rows } = await pool.query('SELECT * FROM home_banners WHERE is_active = true ORDER BY position ASC, created_at ASC');
    return rows.map(rowToHomeBanner);
  },

  // Super Admin — every slide (including hidden ones), in display order.
  async getAllHomeBanners() {
    const { rows } = await pool.query('SELECT * FROM home_banners ORDER BY position ASC, created_at ASC');
    return rows.map(rowToHomeBanner);
  },

  async countHomeBanners() {
    const { rows } = await pool.query('SELECT COUNT(*)::int AS count FROM home_banners');
    return rows[0].count;
  },

  async getHomeBannerById(id) {
    const { rows } = await pool.query('SELECT * FROM home_banners WHERE id = $1', [id]);
    return rowToHomeBanner(rows[0]);
  },

  async createHomeBanner({ id, eyebrow, headline, subtext, ctaText, ctaLink, imageDataUrl }) {
    const { rows: posRows } = await pool.query('SELECT COALESCE(MAX(position), -1) + 1 AS next_position FROM home_banners');
    const { rows } = await pool.query(
      `INSERT INTO home_banners (id, position, eyebrow, headline, subtext, cta_text, cta_link, image_data_url)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
      [id, posRows[0].next_position, eyebrow || null, headline, subtext || null, ctaText || 'Shop Now', ctaLink || null, imageDataUrl || null]
    );
    return rowToHomeBanner(rows[0]);
  },

  async updateHomeBanner(id, fields) {
    const colMap = {
      eyebrow: 'eyebrow', headline: 'headline', subtext: 'subtext', ctaText: 'cta_text',
      ctaLink: 'cta_link', imageDataUrl: 'image_data_url', isActive: 'is_active',
    };
    const sets = ['updated_at = now()']; const values = []; let i = 1;
    for (const [key, col] of Object.entries(colMap)) {
      if (Object.prototype.hasOwnProperty.call(fields, key)) {
        sets.push(`${col} = $${i}`); values.push(fields[key]); i += 1;
      }
    }
    if (sets.length === 1) return this.getHomeBannerById(id);
    values.push(id);
    const { rows } = await pool.query(`UPDATE home_banners SET ${sets.join(', ')} WHERE id = $${i} RETURNING *`, values);
    return rowToHomeBanner(rows[0]);
  },

  async deleteHomeBanner(id) {
    await pool.query('DELETE FROM home_banners WHERE id = $1', [id]);
  },

  // Swaps this slide's position with its immediate neighbor in the
  // requested direction — simple, dependency-free reordering for a
  // list capped at 3 items (no need for a full drag-and-drop reorder).
  async moveHomeBanner(id, direction) {
    const banners = await this.getAllHomeBanners();
    const idx = banners.findIndex(b => b.id === id);
    if (idx === -1) return null;
    const swapIdx = direction === 'up' ? idx - 1 : idx + 1;
    if (swapIdx < 0 || swapIdx >= banners.length) return banners;
    const a = banners[idx]; const b = banners[swapIdx];
    await pool.query('UPDATE home_banners SET position = $1 WHERE id = $2', [b.position, a.id]);
    await pool.query('UPDATE home_banners SET position = $1 WHERE id = $2', [a.position, b.id]);
    return this.getAllHomeBanners();
  },

  // ---- Marketplace: checkout + purchases -------------------------------

  // Runs as a single transaction: validates stock, decrements it,
  // creates the purchase + line items, and (per the "Shop & Delivery"
  // default) a linked delivery order in the existing `orders` table for
  // fulfillment — all-or-nothing, so a failed delivery-order insert
  // can't leave stock decremented with no purchase recorded.
  //
  // paymentMethod/paymentStatus/momoReferenceId/momoPhone default to
  // plain pay-on-delivery (the original behavior, unchanged for the
  // existing COD checkout call site). The Mobile Money checkout route
  // passes 'momo'/'pending'/a fresh UUID/the payer's phone instead, AND
  // passes createDeliveryOrder: false — stock still gets reserved and
  // the purchase still gets created immediately (so nobody else can buy
  // the last unit out from under a payment that's about to succeed),
  // but the delivery order itself is deliberately NOT created yet: it
  // would otherwise show up in the live delivery queue (getAllOrders
  // has no concept of payment_status) before the customer has actually
  // paid. pickupAddress/dropoffAddress are stashed on the purchase row
  // instead and turned into a real order later, only once
  // confirmMomoPaymentAndCreateOrder sees the payment succeed.
  async checkout({
    customerId, customerName, vendorId, items, pickupAddress, dropoffAddress, createDeliveryOrder,
    paymentMethod = 'cod', paymentStatus = 'not_applicable', momoReferenceId = null, momoPhone = null,
  }) {
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

        // Never trust the client's claimed color/size — re-check against
        // this product's CURRENT option lists, fetched fresh inside the
        // same transaction, same "don't trust the client" posture as the
        // price/stock checks right above. A product with a colors/sizes
        // list defined requires a valid matching pick; a product with no
        // list defined ignores whatever the client sent (there's nothing
        // to validate against, and nothing to snapshot).
        const productColors = product.colors || [];
        const productSizes = product.sizes || [];
        let selectedColor = null;
        let selectedSize = null;
        if (productColors.length) {
          if (!item.selectedColor || !productColors.some(c => c.name === item.selectedColor)) {
            throw new Error(`Please choose a color for ${product.name}`);
          }
          selectedColor = item.selectedColor;
        }
        if (productSizes.length) {
          if (!item.selectedSize || !productSizes.includes(item.selectedSize)) {
            throw new Error(`Please choose a size for ${product.name}`);
          }
          selectedSize = item.selectedSize;
        }

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
        lineItems.push({
          productId: product.id, productName: product.name, unitPrice, quantity: item.quantity,
          selectedColor, selectedSize,
        });
      }

      const purchaseId = `PUR-${Date.now().toString(36).toUpperCase()}`;
      let deliveryOrderId = null;

      if (createDeliveryOrder) {
        deliveryOrderId = `ORD-${Date.now().toString(36).toUpperCase()}M`; // 'M' suffix avoids colliding with a same-millisecond regular order id
        // Fold the picked variant into the plain-text summary too — this
        // string is what a delivery agent/vendor actually reads to know
        // what to pack, so "2x T-Shirt" alone would silently drop which
        // color/size to send once products can have variants at all.
        const itemSummary = lineItems.map(li => {
          const variantBits = [li.selectedColor, li.selectedSize].filter(Boolean).join(', ');
          return `${li.quantity}x ${li.productName}${variantBits ? ` (${variantBits})` : ''}`;
        }).join(', ');
        await client.query(
          `INSERT INTO orders (id, sender_id, sender_name, pickup_address, dropoff_address, item_description, amount, status, placed_by_admin)
           VALUES ($1, $2, $3, $4, $5, $6, $7, 'pending', false)`,
          [deliveryOrderId, customerId, customerName, pickupAddress, dropoffAddress, `Marketplace order: ${itemSummary}`, null]
        );
      }

      // Only stashed when the delivery order wasn't created yet (the
      // Mobile Money path) — for the normal COD path the real order
      // already has these, so there's nothing left to hold onto.
      const pendingPickupAddress = !createDeliveryOrder ? pickupAddress : null;
      const pendingDropoffAddress = !createDeliveryOrder ? dropoffAddress : null;
      await client.query(
        `INSERT INTO purchases (id, customer_id, vendor_id, total_amount, delivery_order_id, payment_method, payment_status, momo_reference_id, momo_phone, pending_pickup_address, pending_dropoff_address)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
        [purchaseId, customerId, vendorId, totalAmount, deliveryOrderId, paymentMethod, paymentStatus, momoReferenceId, momoPhone, pendingPickupAddress, pendingDropoffAddress]
      );
      for (const li of lineItems) {
        await client.query(
          `INSERT INTO purchase_items (id, purchase_id, product_id, product_name, unit_price, quantity, selected_color, selected_size) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
          [crypto.randomUUID(), purchaseId, li.productId, li.productName, li.unitPrice, li.quantity, li.selectedColor, li.selectedSize]
        );
      }

      await client.query('COMMIT');
      return { purchaseId, deliveryOrderId, totalAmount, paymentMethod, paymentStatus };
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
            'imageDataUrl', prod.image_data_url,
            'selectedColor', pi.selected_color,
            'selectedSize', pi.selected_size
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
        selectedColor: i.selectedColor, selectedSize: i.selectedSize,
      })),
    }));
  },

  async getPurchaseItems(purchaseId) {
    const { rows } = await pool.query('SELECT * FROM purchase_items WHERE purchase_id = $1', [purchaseId]);
    return rows.map(r => ({
      id: r.id, productId: r.product_id, productName: r.product_name, unitPrice: Number(r.unit_price), quantity: r.quantity,
      selectedColor: r.selected_color, selectedSize: r.selected_size,
    }));
  },

  // Single-purchase lookup — used by the disputes endpoints to verify
  // a customer actually owns the purchase they're filing a dispute
  // against, without pulling their whole purchase history.
  async getPurchaseById(id) {
    const { rows } = await pool.query('SELECT * FROM purchases WHERE id = $1', [id]);
    return rowToPurchase(rows[0]);
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
  async hasCustomerPurchasedFromVendor(customerId, vendorId) {
    const { rows } = await pool.query(
      `SELECT 1 FROM purchases WHERE customer_id = $1 AND vendor_id = $2 LIMIT 1`,
      [customerId, vendorId]
    );
    return rows.length > 0;
  },

  async upsertVendorReview({ id, vendorId, customerId, rating, comment }) {
    const { rows } = await pool.query(`
      INSERT INTO vendor_reviews (id, vendor_id, customer_id, rating, comment)
      VALUES ($1, $2, $3, $4, $5)
      ON CONFLICT (vendor_id, customer_id) DO UPDATE SET rating = $4, comment = $5, created_at = now()
      RETURNING *
    `, [id, vendorId, customerId, rating, comment || null]);
    return rows[0];
  },

  // Reviewer name shown as "J*** D***"-style would need real PII
  // masking logic we don't have — this app already shows full
  // customer/business names elsewhere (e.g. product reviews), so
  // vendor reviews follow the same existing convention rather than
  // inventing a new privacy rule just for this feature.
  async getVendorReviews(vendorId) {
    const { rows } = await pool.query(`
      SELECT vr.*, u.business_name AS customer_name
      FROM vendor_reviews vr
      JOIN users u ON u.id = vr.customer_id
      WHERE vr.vendor_id = $1
      ORDER BY vr.created_at DESC
    `, [vendorId]);
    return rows.map(r => ({
      id: r.id,
      vendorId: r.vendor_id,
      customerId: r.customer_id,
      customerName: r.customer_name,
      rating: r.rating,
      comment: r.comment,
      createdAt: r.created_at,
    }));
  },

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

  // ---- Product Q&A -------------------------------------------------------
  // Anyone logged in as a customer can ask; only the product's own vendor
  // can answer (see server.js's ownership check on the answer route) —
  // simpler than open peer-answering, matching this app's existing
  // "vendor is responsible for their own listings" posture elsewhere.

  async getProductQuestions(productId) {
    const { rows } = await pool.query(
      `SELECT id, asker_name, question, answer, answered_at, created_at
       FROM product_questions WHERE product_id = $1 ORDER BY created_at DESC`,
      [productId]
    );
    return rows.map(r => ({
      id: r.id, askerName: r.asker_name, question: r.question, answer: r.answer,
      answeredAt: r.answered_at, createdAt: r.created_at,
    }));
  },

  async createProductQuestion({ id, productId, askerId, askerName, question }) {
    const { rows } = await pool.query(
      `INSERT INTO product_questions (id, product_id, asker_id, asker_name, question)
       VALUES ($1, $2, $3, $4, $5) RETURNING id, asker_name, question, answer, answered_at, created_at`,
      [id, productId, askerId, askerName, question]
    );
    const r = rows[0];
    return { id: r.id, askerName: r.asker_name, question: r.question, answer: r.answer, answeredAt: r.answered_at, createdAt: r.created_at };
  },

  // Ownership-checked the same way product PUT/DELETE routes already
  // are in server.js: only succeeds when this question's product
  // actually belongs to vendorId — the UPDATE's WHERE clause does the
  // check in one round trip rather than a separate SELECT-then-UPDATE.
  async answerProductQuestion(questionId, vendorId, answer) {
    const { rows } = await pool.query(
      `UPDATE product_questions q SET answer = $1, answered_at = now()
       FROM products p
       WHERE q.id = $2 AND q.product_id = p.id AND p.vendor_id = $3
       RETURNING q.id, q.asker_name, q.question, q.answer, q.answered_at, q.created_at`,
      [answer, questionId, vendorId]
    );
    if (!rows[0]) return null;
    const r = rows[0];
    return { id: r.id, askerName: r.asker_name, question: r.question, answer: r.answer, answeredAt: r.answered_at, createdAt: r.created_at };
  },

  // ---- Recommended products ("more from this store" on the PDP) --------
  // Same active/in-stock filter as getActiveProductsForStorefront, just
  // scoped to one vendor and excluding the product being viewed — a real
  // backend query rather than a client-side filter, since the client's
  // already-loaded storefrontProducts array isn't guaranteed to be
  // populated yet if a customer opens a product page from Wishlist/Deals
  // without ever having visited the Home tab first.
  async getRelatedVendorProducts(vendorId, excludeProductId, limit = 8) {
    const { rows } = await pool.query(`
      SELECT p.*, u.business_name AS vendor_name,
        COALESCE(AVG(r.rating), 0)::numeric AS avg_rating,
        COUNT(DISTINCT r.id)::int AS review_count,
        COALESCE(sold.units_sold, 0)::int AS units_sold,
        (
          SELECT json_agg(json_build_object('id', pi.id, 'imageDataUrl', pi.image_data_url) ORDER BY pi.position, pi.created_at)
          FROM product_images pi WHERE pi.product_id = p.id
        ) AS extra_images
      FROM products p
      JOIN users u ON u.id = p.vendor_id
      LEFT JOIN product_reviews r ON r.product_id = p.id
      LEFT JOIN (
        SELECT product_id, SUM(quantity)::int AS units_sold
        FROM purchase_items GROUP BY product_id
      ) sold ON sold.product_id = p.id
      WHERE p.vendor_id = $1 AND p.id != $2 AND p.is_active = true AND p.stock_quantity > 0
      GROUP BY p.id, u.business_name, sold.units_sold
      ORDER BY p.created_at DESC
      LIMIT $3
    `, [vendorId, excludeProductId, limit]);
    return rows.map(r => ({
      ...rowToProduct(r),
      vendorName: r.vendor_name,
      avgRating: Number(r.avg_rating),
      reviewCount: r.review_count,
      unitsSold: r.units_sold,
      images: r.extra_images || [],
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
        COALESCE(sold.units_sold, 0)::int AS units_sold,
        (
          SELECT json_agg(json_build_object('id', pi.id, 'imageDataUrl', pi.image_data_url) ORDER BY pi.position, pi.created_at)
          FROM product_images pi WHERE pi.product_id = p.id
        ) AS extra_images
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
      images: r.extra_images || [],
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
        COUNT(DISTINCT r.id)::int AS review_count,
        vr.avg_vendor_rating, vr.vendor_review_count
      FROM users u
      LEFT JOIN products p ON p.vendor_id = u.id AND p.is_active = true
      LEFT JOIN product_reviews r ON r.product_id = p.id
      LEFT JOIN (
        SELECT vendor_id, AVG(rating)::numeric AS avg_vendor_rating, COUNT(*)::int AS vendor_review_count
        FROM vendor_reviews GROUP BY vendor_id
      ) vr ON vr.vendor_id = u.id
      WHERE u.role = 'vendor' AND u.vendor_type = 'store'
      GROUP BY u.id, vr.avg_vendor_rating, vr.vendor_review_count
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
      avgVendorRating: r.avg_vendor_rating !== null ? Number(r.avg_vendor_rating) : null,
      vendorReviewCount: r.vendor_review_count || 0,
    }));
  },

  // Restaurants tab — same real-data discipline as getStorefrontVendors
  // (no fabricated delivery-time/rating placeholders): each card gets a
  // real dish count, a real aggregate rating from product_reviews on
  // that restaurant's dishes, and a real "from" price (the cheapest
  // active dish), or null if the restaurant hasn't listed anything yet.
  // A restaurant with zero dishes still shows up here (so a newly
  // approved restaurant isn't invisible) with dishCount 0 and
  // startingPrice null; the frontend is responsible for hiding a
  // "from $X" line when startingPrice is null rather than this query
  // inventing a number. avgVendorRating/vendorReviewCount are the
  // separate, verified-purchase, whole-restaurant rating (see
  // vendor_reviews) — kept alongside avgRating (the dish-level
  // average) rather than replacing it, per how this is meant to read.
  async getPopularRestaurants() {
    const { rows } = await pool.query(`
      SELECT u.id, u.business_name, u.store_address, u.phone, u.profile_image_url, u.avg_prep_time_minutes,
        COUNT(DISTINCT p.id)::int AS dish_count,
        COALESCE(AVG(r.rating), 0)::numeric AS avg_rating,
        COUNT(DISTINCT r.id)::int AS review_count,
        MIN(p.price) AS starting_price,
        vr.avg_vendor_rating, vr.vendor_review_count
      FROM users u
      LEFT JOIN products p ON p.vendor_id = u.id AND p.is_active = true
      LEFT JOIN product_reviews r ON r.product_id = p.id
      LEFT JOIN (
        SELECT vendor_id, AVG(rating)::numeric AS avg_vendor_rating, COUNT(*)::int AS vendor_review_count
        FROM vendor_reviews GROUP BY vendor_id
      ) vr ON vr.vendor_id = u.id
      WHERE u.role = 'vendor' AND u.vendor_type = 'restaurant'
      GROUP BY u.id, vr.avg_vendor_rating, vr.vendor_review_count
      ORDER BY avg_rating DESC, dish_count DESC, u.business_name ASC
    `);
    return rows.map(r => ({
      id: r.id,
      businessName: r.business_name,
      storeAddress: r.store_address,
      phone: r.phone,
      profileImageUrl: r.profile_image_url,
      avgPrepTimeMinutes: r.avg_prep_time_minutes,
      dishCount: r.dish_count,
      avgRating: Number(r.avg_rating),
      reviewCount: r.review_count,
      avgVendorRating: r.avg_vendor_rating !== null ? Number(r.avg_vendor_rating) : null,
      vendorReviewCount: r.vendor_review_count || 0,
      startingPrice: r.starting_price !== null ? Number(r.starting_price) : null,
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

  // Admin Overview's Marketplace/Restaurant sections — same purchases
  // table as getMarketplacePlatformStats above, just split by the
  // purchased vendor's vendor_type instead of lumped together, since
  // a restaurant order and a store order are the same DB row shape
  // (both a "purchases" row, both possibly linked to a delivery order)
  // but are two distinct lines of business to an admin reading a
  // dashboard.
  async getBusinessOverviewStats() {
    const [byType, vendorCounts, pendingCount] = await Promise.all([
      pool.query(`
        SELECT u.vendor_type, COUNT(p.*)::int AS total_orders, COALESCE(SUM(p.total_amount), 0)::numeric AS total_revenue
        FROM purchases p JOIN users u ON u.id = p.vendor_id
        GROUP BY u.vendor_type
      `),
      pool.query("SELECT vendor_type, COUNT(*)::int AS count FROM users WHERE role = 'vendor' AND approval_status = 'approved' GROUP BY vendor_type"),
      pool.query("SELECT COUNT(*)::int AS count FROM users WHERE role = 'vendor' AND approval_status = 'pending'"),
    ]);
    const forType = (type) => byType.rows.find(r => r.vendor_type === type) || { total_orders: 0, total_revenue: 0 };
    const countForType = (type) => (vendorCounts.rows.find(r => r.vendor_type === type) || { count: 0 }).count;
    const store = forType('store');
    const restaurant = forType('restaurant');
    return {
      marketplace: {
        totalOrders: store.total_orders,
        totalRevenue: Number(store.total_revenue),
        vendorCount: countForType('store'),
      },
      restaurants: {
        totalOrders: restaurant.total_orders,
        totalRevenue: Number(restaurant.total_revenue),
        vendorCount: countForType('restaurant'),
      },
      pendingVendorApplications: pendingCount.rows[0].count,
    };
  },

  // ---- Commission & payouts (Super Admin) ---------------------------
  // Single-row table, same upsert pattern as Business settings above.

  async getPlatformSettings() {
    const existing = await pool.query("SELECT * FROM platform_settings WHERE id = 'platform'");
    if (existing.rows.length === 0) {
      const { rows } = await pool.query("INSERT INTO platform_settings (id) VALUES ('platform') RETURNING *");
      return rowToPlatformSettings(rows[0]);
    }
    return rowToPlatformSettings(existing.rows[0]);
  },

  // Generic partial-update over the single platform_settings row —
  // covers commission rates (used by the Payouts & Commission panel)
  // and the platform-wide settings (default delivery fee, service
  // area, maintenance mode) added later, so both panels can share one
  // upsert path instead of drifting into two near-duplicate ones.
  async upsertPlatformSettings({ marketplaceCommissionPercent, deliveryCommissionPercent, defaultDeliveryFee, serviceArea, maintenanceMode, maintenanceMessage }) {
    await this.getPlatformSettings(); // ensures the row exists
    const sets = [];
    const values = [];
    let i = 1;
    if (marketplaceCommissionPercent !== undefined) { sets.push(`marketplace_commission_percent = $${i}`); values.push(marketplaceCommissionPercent); i += 1; }
    if (deliveryCommissionPercent !== undefined) { sets.push(`delivery_commission_percent = $${i}`); values.push(deliveryCommissionPercent); i += 1; }
    if (defaultDeliveryFee !== undefined) { sets.push(`default_delivery_fee = $${i}`); values.push(defaultDeliveryFee); i += 1; }
    if (serviceArea !== undefined) { sets.push(`service_area = $${i}`); values.push(serviceArea); i += 1; }
    if (maintenanceMode !== undefined) { sets.push(`maintenance_mode = $${i}`); values.push(maintenanceMode); i += 1; }
    if (maintenanceMessage !== undefined) { sets.push(`maintenance_message = $${i}`); values.push(maintenanceMessage); i += 1; }
    sets.push('updated_at = now()');
    if (sets.length > 1) {
      await pool.query(`UPDATE platform_settings SET ${sets.join(', ')} WHERE id = 'platform'`, values);
    }
    return this.getPlatformSettings();
  },

  // rate === null clears the override (falls back to the platform
  // default). Scoped to vendor/delivery_company roles only — enforced
  // here, not just trusted from the caller.
  async setCommissionRateOverride(userId, rate) {
    const { rows } = await pool.query(
      `UPDATE users SET commission_rate_override = $1
       WHERE id = $2 AND role IN ('vendor', 'delivery_company') RETURNING *`,
      [rate, userId]
    );
    return rowToUser(rows[0]);
  },

  // Real, calculated-from-actual-data summary — vendor gross comes
  // from `purchases`, delivery company gross from delivered `orders`,
  // each net of any refunds issued through resolved disputes (see
  // resolveDispute below — a purchase-linked refund nets against that
  // purchase's vendor, an order-only refund nets against that order's
  // delivery company; see the comment on the disputes table in
  // schema.sql for the full reasoning). Never recalculates past
  // payouts; only used to show current standing (gross earned
  // all-time, net of refunds, vs. already paid out all-time).
  async getPayoutSummary() {
    const [vendorRows, companyRows, vendorRevenue, deliveryRevenue, vendorRefunds, deliveryRefunds, paidOut, platformSettings] = await Promise.all([
      pool.query("SELECT id, business_name, email, commission_rate_override FROM users WHERE role = 'vendor' AND approval_status = 'approved' ORDER BY business_name"),
      pool.query("SELECT id, business_name, email, commission_rate_override FROM users WHERE role = 'delivery_company' AND approval_status = 'approved' ORDER BY business_name"),
      pool.query("SELECT vendor_id, COALESCE(SUM(total_amount), 0)::numeric AS gross FROM purchases GROUP BY vendor_id"),
      pool.query("SELECT delivery_company_id, COALESCE(SUM(amount), 0)::numeric AS gross FROM orders WHERE status = 'delivered' AND delivery_company_id IS NOT NULL GROUP BY delivery_company_id"),
      pool.query(
        `SELECT pur.vendor_id AS vendor_id, COALESCE(SUM(d.refund_amount), 0)::numeric AS refunded
         FROM disputes d JOIN purchases pur ON pur.id = d.purchase_id
         WHERE d.status = 'resolved' AND d.refund_amount IS NOT NULL
         GROUP BY pur.vendor_id`
      ),
      pool.query(
        `SELECT o.delivery_company_id AS delivery_company_id, COALESCE(SUM(d.refund_amount), 0)::numeric AS refunded
         FROM disputes d JOIN orders o ON o.id = d.order_id
         WHERE d.status = 'resolved' AND d.refund_amount IS NOT NULL AND d.purchase_id IS NULL AND o.delivery_company_id IS NOT NULL
         GROUP BY o.delivery_company_id`
      ),
      pool.query("SELECT recipient_id, COALESCE(SUM(net_amount), 0)::numeric AS paid FROM payouts GROUP BY recipient_id"),
      this.getPlatformSettings(),
    ]);
    const vendorRevMap = new Map(vendorRevenue.rows.map(r => [r.vendor_id, Number(r.gross)]));
    const deliveryRevMap = new Map(deliveryRevenue.rows.map(r => [r.delivery_company_id, Number(r.gross)]));
    const vendorRefundMap = new Map(vendorRefunds.rows.map(r => [r.vendor_id, Number(r.refunded)]));
    const deliveryRefundMap = new Map(deliveryRefunds.rows.map(r => [r.delivery_company_id, Number(r.refunded)]));
    const paidMap = new Map(paidOut.rows.map(r => [r.recipient_id, Number(r.paid)]));

    const build = (rows, revMap, refundMap, recipientType, defaultRate) => rows.map(r => {
      // Clamped at 0 rather than allowed to go negative — refunds can
      // never exceed what was actually sold, but this guards against
      // it visually even if it somehow did.
      const gross = Math.max(0, (revMap.get(r.id) || 0) - (refundMap.get(r.id) || 0));
      const override = r.commission_rate_override !== null && r.commission_rate_override !== undefined ? Number(r.commission_rate_override) : null;
      const effectiveRate = override !== null ? override : defaultRate;
      const commissionAmount = Math.round(gross * (effectiveRate / 100) * 100) / 100;
      const netEarned = Math.round((gross - commissionAmount) * 100) / 100;
      const totalPaidOut = paidMap.get(r.id) || 0;
      return {
        id: r.id,
        businessName: r.business_name,
        email: r.email,
        recipientType,
        commissionRateOverride: override,
        effectiveRate,
        grossRevenue: gross,
        commissionAmount,
        netEarned,
        totalPaidOut,
        outstandingBalance: Math.max(0, Math.round((netEarned - totalPaidOut) * 100) / 100),
      };
    });

    return {
      platformSettings,
      vendors: build(vendorRows.rows, vendorRevMap, vendorRefundMap, 'vendor', platformSettings.marketplaceCommissionPercent),
      deliveryCompanies: build(companyRows.rows, deliveryRevMap, deliveryRefundMap, 'delivery_company', platformSettings.deliveryCommissionPercent),
    };
  },

  async createPayout({ id, recipientType, recipientId, periodStart, periodEnd, grossAmount, commissionRate, notes, createdBy }) {
    const commissionAmount = Math.round(grossAmount * (commissionRate / 100) * 100) / 100;
    const netAmount = Math.round((grossAmount - commissionAmount) * 100) / 100;
    const { rows } = await pool.query(
      `INSERT INTO payouts (id, recipient_type, recipient_id, period_start, period_end, gross_amount, commission_rate, commission_amount, net_amount, notes, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) RETURNING *`,
      [id, recipientType, recipientId, periodStart, periodEnd, grossAmount, commissionRate, commissionAmount, netAmount, notes || null, createdBy || null]
    );
    return rowToPayout(rows[0]);
  },

  async getPayouts({ recipientId, limit = 50 } = {}) {
    const conditions = [];
    const values = [];
    let i = 1;
    if (recipientId) { conditions.push(`recipient_id = $${i}`); values.push(recipientId); i += 1; }
    values.push(limit);
    const { rows } = await pool.query(
      `SELECT * FROM payouts ${conditions.length ? 'WHERE ' + conditions.join(' AND ') : ''} ORDER BY created_at DESC LIMIT $${i}`,
      values
    );
    return rows.map(rowToPayout);
  },

  // ---- Disputes ---------------------------------------------------------
  // A customer reporting a problem with an order or marketplace
  // purchase, and a Super Admin resolving it (optionally with a
  // refund). See the schema.sql comment on the disputes table for the
  // order_id/purchase_id reasoning.

  // Shared SELECT for both getDisputes() and getDisputeById() — joins
  // in exactly the display context the Super Admin queue and the
  // customer's own dispute list need (who, what order/purchase, how
  // much, which vendor/delivery company), so callers never have to
  // make a second round trip just to render a row.
  _disputeSelect() {
    return `SELECT d.*,
        cust.business_name AS customer_name, cust.email AS customer_email,
        o.item_description AS order_item_description, o.amount AS order_amount, o.status AS order_status,
        o.delivery_company_id AS order_delivery_company_id, dc.business_name AS delivery_company_name,
        pur.total_amount AS purchase_amount, pur.vendor_id AS purchase_vendor_id, v.business_name AS vendor_name
      FROM disputes d
      JOIN users cust ON cust.id = d.customer_id
      LEFT JOIN orders o ON o.id = d.order_id
      LEFT JOIN users dc ON dc.id = o.delivery_company_id
      LEFT JOIN purchases pur ON pur.id = d.purchase_id
      LEFT JOIN users v ON v.id = pur.vendor_id`;
  },

  _rowToDisputeWithContext(r) {
    if (!r) return null;
    return {
      ...rowToDispute(r),
      customerName: r.customer_name,
      customerEmail: r.customer_email,
      order: r.order_id ? {
        itemDescription: r.order_item_description,
        amount: r.order_amount !== null && r.order_amount !== undefined ? Number(r.order_amount) : null,
        status: r.order_status,
        deliveryCompanyId: r.order_delivery_company_id,
        deliveryCompanyName: r.delivery_company_name,
      } : null,
      purchase: r.purchase_id ? {
        amount: r.purchase_amount !== null && r.purchase_amount !== undefined ? Number(r.purchase_amount) : null,
        vendorId: r.purchase_vendor_id,
        vendorName: r.vendor_name,
      } : null,
    };
  },

  async createDispute({ id, orderId, purchaseId, customerId, category, description }) {
    const { rows } = await pool.query(
      `INSERT INTO disputes (id, order_id, purchase_id, customer_id, category, description)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
      [id, orderId || null, purchaseId || null, customerId, category, description]
    );
    return rowToDispute(rows[0]);
  },

  async getDisputeById(id) {
    const { rows } = await pool.query(`${this._disputeSelect()} WHERE d.id = $1`, [id]);
    return this._rowToDisputeWithContext(rows[0]);
  },

  // A customer's own disputes — also used to block filing a second
  // open dispute against the same order/purchase (see the
  // already-open check in the POST /api/disputes handler).
  async getDisputesForCustomer(customerId) {
    const { rows } = await pool.query(
      `${this._disputeSelect()} WHERE d.customer_id = $1 ORDER BY d.created_at DESC`,
      [customerId]
    );
    return rows.map(r => this._rowToDisputeWithContext(r));
  },

  // Super Admin queue. status is optional — omitted means "all".
  async getDisputes({ status } = {}) {
    const values = [];
    let where = '';
    if (status) { values.push(status); where = 'WHERE d.status = $1'; }
    const { rows } = await pool.query(
      `${this._disputeSelect()} ${where} ORDER BY (d.status = 'open') DESC, d.created_at DESC`,
      values
    );
    return rows.map(r => this._rowToDisputeWithContext(r));
  },

  async countOpenDisputes() {
    const { rows } = await pool.query("SELECT COUNT(*)::int AS count FROM disputes WHERE status = 'open'");
    return rows[0].count;
  },

  // The one resolve step — open -> resolved (with a refund amount) or
  // open -> rejected (no refund, resolutionNote explains why). Scoped
  // to status = 'open' so a dispute can only ever be resolved once;
  // returns null (not an error) if it's already been decided, which
  // the caller turns into a 409.
  async resolveDispute(id, { status, resolutionNote, refundAmount, resolvedBy }) {
    const { rows } = await pool.query(
      `UPDATE disputes SET status = $1, resolution_note = $2, refund_amount = $3, resolved_by = $4, resolved_at = now()
       WHERE id = $5 AND status = 'open' RETURNING *`,
      [status, resolutionNote, refundAmount, resolvedBy || null, id]
    );
    return rowToDispute(rows[0]);
  },

  // ---- Audit log ------------------------------------------------------
  // Append-only by design — no update/delete helper exists here on
  // purpose, matching how login_history is treated elsewhere.

  async createAuditLogEntry({ id, actorId, actorName, actorRole, action, targetType, targetId, targetLabel, details }) {
    const { rows } = await pool.query(
      `INSERT INTO audit_log (id, actor_id, actor_name, actor_role, action, target_type, target_id, target_label, details)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING *`,
      [id, actorId || null, actorName, actorRole, action, targetType || null, targetId || null, targetLabel || null, JSON.stringify(details || {})]
    );
    return rowToAuditLogEntry(rows[0]);
  },

  async getAuditLog({ limit = 50, before, action, actorId } = {}) {
    const conditions = [];
    const values = [];
    let i = 1;
    if (before) { conditions.push(`created_at < $${i}`); values.push(before); i += 1; }
    if (action) { conditions.push(`action = $${i}`); values.push(action); i += 1; }
    if (actorId) { conditions.push(`actor_id = $${i}`); values.push(actorId); i += 1; }
    values.push(limit);
    const { rows } = await pool.query(
      `SELECT * FROM audit_log ${conditions.length ? 'WHERE ' + conditions.join(' AND ') : ''} ORDER BY created_at DESC LIMIT $${i}`,
      values
    );
    return rows.map(rowToAuditLogEntry);
  },

  async getAuditActionKeys() {
    const { rows } = await pool.query('SELECT DISTINCT action FROM audit_log ORDER BY action');
    return rows.map(r => r.action);
  },
};

module.exports = db;
