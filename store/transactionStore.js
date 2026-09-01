'use strict';

const { getClient } = require('../services/supabaseClient');

/**
 * Transaction store with two backends:
 *   - in-memory (default, zero-setup, gone on restart) - the original
 *     behavior, kept as a safe fallback for local dev/testing
 *   - Supabase/Postgres (when SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY are
 *     set - see config/env.js) - persists across restarts/redeploys
 *
 * The backend is chosen automatically per-call based on whether Supabase
 * is configured, so nothing else in the app (routes/payments.js) needs to
 * know or care which one is active. Every method is async now (even the
 * in-memory ones) so callers don't need two code paths either - see
 * db/schema.sql for the Supabase table definition.
 */

// ---- in-memory backend --------------------------------------------------
const memoryTransactions = new Map();

function memorySave(record) {
  const saved = { ...record, updatedAt: new Date().toISOString() };
  memoryTransactions.set(record.reference, saved);
  return saved;
}

function memoryGet(reference) {
  return memoryTransactions.get(reference) || null;
}

function memoryUpdate(reference, patch) {
  const existing = memoryTransactions.get(reference);
  if (!existing) return null;
  const updated = { ...existing, ...patch, updatedAt: new Date().toISOString() };
  memoryTransactions.set(reference, updated);
  return updated;
}

function memoryList({ status } = {}) {
  const all = Array.from(memoryTransactions.values());
  const filtered = status ? all.filter((t) => t.status === status) : all;
  return filtered.sort((a, b) => new Date(b.createdAt || b.updatedAt) - new Date(a.createdAt || a.updatedAt));
}

// ---- Supabase backend -----------------------------------------------------
// Maps between the app's camelCase record shape and Postgres's snake_case
// columns (db/schema.sql).
function toRow(record) {
  return {
    reference: record.reference,
    status: record.status,
    amount: record.amount,
    currency: record.currency,
    description: record.description || null,
    device: record.device || null,
    receipt: record.receipt || null,
    gateway_reference: record.gatewayReference || null,
    error: record.error || null,
    created_at: record.createdAt || new Date().toISOString(),
  };
}

function fromRow(row) {
  if (!row) return null;
  return {
    reference: row.reference,
    status: row.status,
    amount: row.amount,
    currency: row.currency,
    description: row.description || undefined,
    device: row.device || undefined,
    receipt: row.receipt || undefined,
    gatewayReference: row.gateway_reference || undefined,
    error: row.error || undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

async function supabaseSave(record) {
  const client = getClient();
  // upsert (not insert) so retrying a charge with the same reference
  // overwrites rather than throwing a unique-constraint error - matches
  // the in-memory backend's Map.set() semantics exactly.
  const { data, error } = await client.from('transactions').upsert(toRow(record)).select().single();
  if (error) throw new Error(`[transactionStore] Supabase save failed: ${error.message}`);
  return fromRow(data);
}

async function supabaseGet(reference) {
  const client = getClient();
  const { data, error } = await client.from('transactions').select('*').eq('reference', reference).maybeSingle();
  if (error) throw new Error(`[transactionStore] Supabase get failed: ${error.message}`);
  return fromRow(data);
}

async function supabaseUpdate(reference, patch) {
  const client = getClient();
  const patchRow = { updated_at: new Date().toISOString() };
  if (patch.status !== undefined) patchRow.status = patch.status;
  if (patch.receipt !== undefined) patchRow.receipt = patch.receipt;
  if (patch.gatewayReference !== undefined) patchRow.gateway_reference = patch.gatewayReference;
  if (patch.error !== undefined) patchRow.error = patch.error;
  if (patch.description !== undefined) patchRow.description = patch.description;

  const { data, error } = await client.from('transactions').update(patchRow).eq('reference', reference).select().maybeSingle();
  if (error) throw new Error(`[transactionStore] Supabase update failed: ${error.message}`);
  return fromRow(data);
}

async function supabaseList({ status } = {}) {
  const client = getClient();
  let query = client.from('transactions').select('*').order('created_at', { ascending: false });
  if (status) query = query.eq('status', status);
  const { data, error } = await query;
  if (error) throw new Error(`[transactionStore] Supabase list failed: ${error.message}`);
  return (data || []).map(fromRow);
}

// ---- public API: picks the backend automatically ---------------------
function useSupabase() {
  return getClient() !== false;
}

async function save(record) {
  return useSupabase() ? supabaseSave(record) : memorySave(record);
}

async function get(reference) {
  return useSupabase() ? supabaseGet(reference) : memoryGet(reference);
}

async function update(reference, patch) {
  return useSupabase() ? supabaseUpdate(reference, patch) : memoryUpdate(reference, patch);
}

async function list(opts) {
  return useSupabase() ? supabaseList(opts) : memoryList(opts);
}

module.exports = { save, get, update, list };
