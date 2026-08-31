'use strict';

/**
 * Minimal in-memory transaction store.
 *
 * This is intentionally simple (a Map, gone on restart) so the demo has zero
 * database setup and works out of the box on Render's free tier. Swap this
 * for a real datastore (Postgres, Redis, etc.) before going to production -
 * you'll want transactions to survive a dyno/service restart and to be
 * queryable for reconciliation and chargebacks.
 */
const transactions = new Map();

function save(record) {
  transactions.set(record.reference, { ...record, updatedAt: new Date().toISOString() });
  return transactions.get(record.reference);
}

function get(reference) {
  return transactions.get(reference) || null;
}

function update(reference, patch) {
  const existing = transactions.get(reference);
  if (!existing) return null;
  const updated = { ...existing, ...patch, updatedAt: new Date().toISOString() };
  transactions.set(reference, updated);
  return updated;
}

/**
 * Returns all stored transactions, most recent first - powers the
 * Transactions tab (GET /api/payments in routes/payments.js). Optional
 * filters: { status } to narrow to approved/declined/pending/error.
 */
function list({ status } = {}) {
  const all = Array.from(transactions.values());
  const filtered = status ? all.filter((t) => t.status === status) : all;
  return filtered.sort((a, b) => new Date(b.createdAt || b.updatedAt) - new Date(a.createdAt || a.updatedAt));
}

module.exports = { save, get, update, list };
