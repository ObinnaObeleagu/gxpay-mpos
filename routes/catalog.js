'use strict';

const express = require('express');
const store = require('../store/catalogStore');

const router = express.Router();

const VALID_TYPES = ['sale', 'service'];

function validateItem(body, { partial = false } = {}) {
  const errors = [];
  if (!partial || body.name !== undefined) {
    if (!body.name || typeof body.name !== 'string' || !body.name.trim()) {
      errors.push('name is required');
    }
  }
  if (!partial || body.price !== undefined) {
    if (body.price === undefined || Number.isNaN(Number(body.price)) || Number(body.price) < 0) {
      errors.push('price must be a non-negative number');
    }
  }
  if (!partial || body.type !== undefined) {
    if (!VALID_TYPES.includes(body.type)) {
      errors.push(`type must be one of: ${VALID_TYPES.join(', ')}`);
    }
  }
  return errors;
}

/**
 * GET /api/catalog
 * Lists items/services, alphabetical by name. Query param: type
 * (sale|service) to filter. Powers both the Items tab and the checkout
 * screen's item picker.
 */
router.get('/', async (req, res) => {
  try {
    const { type } = req.query;
    const items = await store.list({ type });
    return res.json({ status: 'ok', count: items.length, items });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[catalog/list] failed:', err.message);
    return res.status(500).json({ status: 'error', message: 'Failed to list catalog items' });
  }
});

/**
 * POST /api/catalog
 * Body: { name, price, type: 'sale'|'service', currency? }
 */
router.post('/', async (req, res) => {
  const body = req.body || {};
  const errors = validateItem(body);
  if (errors.length) {
    return res.status(400).json({ status: 'error', errors });
  }
  try {
    const item = await store.create({
      name: body.name.trim(),
      price: Number(body.price),
      type: body.type,
      currency: body.currency || 'NGN',
    });
    return res.status(201).json({ status: 'ok', item });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[catalog/create] failed:', err.message);
    return res.status(500).json({ status: 'error', message: 'Failed to create catalog item' });
  }
});

/**
 * PATCH /api/catalog/:id
 * Body: any subset of { name, price, type, currency }
 */
router.patch('/:id', async (req, res) => {
  const body = req.body || {};
  const errors = validateItem(body, { partial: true });
  if (errors.length) {
    return res.status(400).json({ status: 'error', errors });
  }
  try {
    const patch = {};
    if (body.name !== undefined) patch.name = body.name.trim();
    if (body.price !== undefined) patch.price = Number(body.price);
    if (body.type !== undefined) patch.type = body.type;
    if (body.currency !== undefined) patch.currency = body.currency;

    const item = await store.update(req.params.id, patch);
    if (!item) {
      return res.status(404).json({ status: 'error', message: 'Item not found' });
    }
    return res.json({ status: 'ok', item });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[catalog/update] failed:', err.message);
    return res.status(500).json({ status: 'error', message: 'Failed to update catalog item' });
  }
});

/**
 * DELETE /api/catalog/:id
 */
router.delete('/:id', async (req, res) => {
  try {
    const existing = await store.get(req.params.id);
    if (!existing) {
      return res.status(404).json({ status: 'error', message: 'Item not found' });
    }
    await store.remove(req.params.id);
    return res.json({ status: 'ok' });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[catalog/delete] failed:', err.message);
    return res.status(500).json({ status: 'error', message: 'Failed to delete catalog item' });
  }
});

module.exports = router;
