import { createClient } from '@supabase/supabase-js';

function getDb(serviceKey = false) {
  const url = process.env.SUPABASE_URL;
  const key = serviceKey ? process.env.SUPABASE_SERVICE_KEY : process.env.SUPABASE_ANON_KEY;
  if (!url || !key) throw new Error('Supabase env vars belum dikonfigurasi (SUPABASE_URL / SUPABASE_SERVICE_KEY)');
  return createClient(url, key);
}

const adminCheck = req => (req.headers['x-admin-key'] || '') === process.env.ADMIN_PASSWORD;

export default async function handler(req, res) {
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-admin-key');
  if (req.method === 'OPTIONS') return res.status(200).end();

  try {
    const isAdmin = adminCheck(req);
    const db = getDb(true); // always use service key so admin ops work

    // ── GET ──────────────────────────────────────────────────────────
    if (req.method === 'GET') {
      let query = db.from('products')
        .select('id, name, category, description, image_url, prices, badge, active, rules, created_at')
        .order('created_at', { ascending: false });

      if (!isAdmin) query = query.eq('active', true);

      const { data: products, error } = await query;
      if (error) return res.status(500).json({ error: error.message });

      // Count stock separately — avoids subquery failures
      const { data: poolRows } = await db
        .from('account_pool')
        .select('product_id')
        .eq('used', false);

      const stockMap = {};
      (poolRows || []).forEach(r => {
        stockMap[r.product_id] = (stockMap[r.product_id] || 0) + 1;
      });

      const result = (products || []).map(p => ({
        ...p,
        stock: stockMap[p.id] || 0,
      }));

      return res.status(200).json(result);
    }

    // Admin-only below ──────────────────────────────────────────────
    if (!isAdmin) return res.status(401).json({ error: 'Unauthorized' });

    // ── POST ─────────────────────────────────────────────────────────
    if (req.method === 'POST') {
      const { name, category, description, image_url, prices, badge, rules } = req.body || {};
      if (!name?.trim() || !category || !prices)
        return res.status(400).json({ error: 'name, category, prices wajib diisi' });

      const { data, error } = await db.from('products').insert({
        name: name.trim(), category, description: description || '',
        image_url: image_url || '', prices, badge: badge || '',
        rules: rules || '', active: true,
      }).select().single();

      if (error) return res.status(500).json({ error: error.message });
      return res.status(201).json(data);
    }

    // ── PUT ──────────────────────────────────────────────────────────
    if (req.method === 'PUT') {
      const { id, ...fields } = req.body || {};
      if (!id) return res.status(400).json({ error: 'id diperlukan' });

      const allowed = ['name','category','description','image_url','prices','badge','active','rules'];
      const updates = { updated_at: new Date().toISOString() };
      allowed.forEach(k => { if (fields[k] !== undefined) updates[k] = fields[k]; });

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
    return res.status(500).json({ error: err.message || 'Internal server error' });
  }
        }
