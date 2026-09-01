'use strict';

const crypto = require('crypto');
const { getClient } = require('../services/supabaseClient');

/**
 * Item/service catalog store - same dual-backend pattern as
 * transactionStore.js (in-memory fallback / Supabase when configured).
 * Powers the Items tab: sellable goods and services with a price attached,
 * so checkout can describe what was actually sold ("Sale of wine") instead
 * of just showing a bare amount - see routes/catalog.js, db/schema.sql.
 */

// ---- in-memory backend --------------------------------------------------
const memoryItems = new Map();

function memoryCreate({ name, price, type, currency }) {
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  const item = { id, name, price, type, currency: currency || 'NGN', createdAt: now, updatedAt: now };
  memoryItems.set(id, item);
  return item;
}

function memoryList({ type } = {}) {
  const all = Array.from(memoryItems.values());
  const filtered = type ? all.filter((i) => i.type === type) : all;
  return filtered.sort((a, b) => a.name.localeCompare(b.name));
}

function memoryGet(id) {
  return memoryItems.get(id) || null;
}

function memoryUpdate(id, patch) {
  const existing = memoryItems.get(id);
  if (!existing) return null;
  const updated = { ...existing, ...patch, updatedAt: new Date().toISOString() };
  memoryItems.set(id, updated);
  return updated;
}

function memoryRemove(id) {
  return memoryItems.delete(id);
}

// ---- Supabase backend -----------------------------------------------------
function toRow(item) {
  return {
    name: item.name,
    price: item.price,
    type: item.type,
    currency: item.currency || 'NGN',
  };
}

function fromRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    price: row.price,
    type: row.type,
    currency: row.currency,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

async function supabaseCreate(item) {
  const client = getClient();
  const { data, error } = await client.from('catalog_items').insert(toRow(item)).select().single();
  if (error) throw new Error(`[catalogStore] Supabase create failed: ${error.message}`);
  return fromRow(data);
}

async function supabaseList({ type } = {}) {
  const client = getClient();
  let query = client.from('catalog_items').select('*').order('name', { ascending: true });
  if (type) query = query.eq('type', type);
  const { data, error } = await query;
  if (error) throw new Error(`[catalogStore] Supabase list failed: ${error.message}`);
  return (data || []).map(fromRow);
}

async function supabaseGet(id) {
  const client = getClient();
  const { data, error } = await client.from('catalog_items').select('*').eq('id', id).maybeSingle();
  if (error) throw new Error(`[catalogStore] Supabase get failed: ${error.message}`);
  return fromRow(data);
}

async function supabaseUpdate(id, patch) {
  const client = getClient();
  const patchRow = { updated_at: new Date().toISOString() };
  if (patch.name !== undefined) patchRow.name = patch.name;
  if (patch.price !== undefined) patchRow.price = patch.price;
  if (patch.type !== undefined) patchRow.type = patch.type;
  if (patch.currency !== undefined) patchRow.currency = patch.currency;

  const { data, error } = await client.from('catalog_items').update(patchRow).eq('id', id).select().maybeSingle();
  if (error) throw new Error(`[catalogStore] Supabase update failed: ${error.message}`);
  return fromRow(data);
}

async function supabaseRemove(id) {
  const client = getClient();
  const { error } = await client.from('catalog_items').delete().eq('id', id);
  if (error) throw new Error(`[catalogStore] Supabase delete failed: ${error.message}`);
  return true;
}

// ---- public API: picks the backend automatically ---------------------
function useSupabase() {
  return getClient() !== false;
}

async function create(item) {
  return useSupabase() ? supabaseCreate(item) : memoryCreate(item);
}

async function list(opts) {
  return useSupabase() ? supabaseList(opts) : memoryList(opts);
}

async function get(id) {
  return useSupabase() ? supabaseGet(id) : memoryGet(id);
}

async function update(id, patch) {
  return useSupabase() ? supabaseUpdate(id, patch) : memoryUpdate(id, patch);
}

async function remove(id) {
  return useSupabase() ? supabaseRemove(id) : memoryRemove(id);
}

module.exports = { create, list, get, update, remove };
