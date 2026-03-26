import { createClient } from '@supabase/supabase-js';

const sb = () => createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
const adminCheck = req => (req.headers['x-admin-key'] || '') === process.env.ADMIN_PASSWORD;

function stripPool(data) {
  return (data || []).map(p => ({
    ...p,
    stock: Array.isArray(p.account_pool)
      ? (p.account_pool[0]?.count ?? 0)
      : (p.stock ?? 0),
    account_pool: undefined,
  }));
}

export default async function handler(req, res) {
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-admin-key');
  if (req.method === 'OPTIONS') return res.status(200).end();

  try {
    const db = sb();
    const isAdmin = adminCheck(req);

    // ── GET ────────────────────────────────────────────────────────────
    if (req.method === 'GET') {
      let query = db.from('products').select(`
        id, name, category, description, image_url, prices, badge, active, rules, created_at,
        account_pool(count)
      `);

      if (!isAdmin) query = query.eq('active', true);

      const { q, category } = req.query;
      if (category && category !== 'all') query = query.eq('category', category);
      if (q) query = query.ilike('name', `%${q}%`);

      query = query.order('created_at', { ascending: false });

      const { data, error } = await query;
      if (error) return res.status(500).json({ error: error.message });
      return res.status(200).json(stripPool(data));
    }

    // Admin-only below
    if (!isAdmin) return res.status(401).json({ error: 'Unauthorized' });

    // ── POST ───────────────────────────────────────────────────────────
    if (req.method === 'POST') {
      const { name, category, description, image_url, prices, badge, rules } = req.body || {};
      if (!name?.trim() || !category || !prices) {
        return res.status(400).json({ error: 'name, category, prices diperlukan' });
      }
      const { data, error } = await db.from('products').insert({
        name: name.trim(), category, description, image_url,
        prices, badge: badge || '', rules: rules || '', active: true,
      }).select().single();

      if (error) return res.status(500).json({ error: error.message });
      return res.status(201).json(data);
    }

    // ── PUT ────────────────────────────────────────────────────────────
    if (req.method === 'PUT') {
      const { id, name, category, description, image_url, prices, badge, active, rules } = req.body || {};
      if (!id) return res.status(400).json({ error: 'id diperlukan' });

      const updates = { updated_at: new Date().toISOString() };
      if (name !== undefined) updates.name = name;
      if (category !== undefined) updates.category = category;
      if (description !== undefined) updates.description = description;
      if (image_url !== undefined) updates.image_url = image_url;
      if (prices !== undefined) updates.prices = prices;
      if (badge !== undefined) updates.badge = badge;
      if (active !== undefined) updates.active = active;
      if (rules !== undefined) updates.rules = rules;

      const { data, error } = await db.from('products').update(updates).eq('id', id).select().single();
      if (error) return res.status(500).json({ error: error.message });
      return res.status(200).json(data);
    }

    // ── DELETE (soft) ─────────────────────────────────────────────────
    if (req.method === 'DELETE') {
      const { id } = req.body || {};
      if (!id) return res.status(400).json({ error: 'id diperlukan' });
      const { error } = await db.from('products').update({ active: false }).eq('id', id);
      if (error) return res.status(500).json({ error: error.message });
      return res.status(200).json({ success: true });
    }

    return res.status(405).json({ error: 'Method not allowed' });
  } catch (err) {
    console.error('Products error:', err);
    return res.status(500).json({ error: 'Internal server error', detail: err.message });
  }
}
