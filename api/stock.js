import { createClient } from '@supabase/supabase-js';

function getDb() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_KEY;
  if (!url || !key) throw new Error('SUPABASE_URL / SUPABASE_SERVICE_KEY belum dikonfigurasi');
  return createClient(url, key);
}

const adminCheck = req => (req.headers['x-admin-key'] || '') === process.env.ADMIN_PASSWORD;

export default async function handler(req, res) {
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-admin-key');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (!adminCheck(req)) return res.status(401).json({ error: 'Unauthorized' });

  try {
    const db = getDb();

    // ── GET ──────────────────────────────────────────────────────────
    if (req.method === 'GET') {
      const { product_id } = req.query;
      if (!product_id) return res.status(400).json({ error: 'product_id diperlukan' });

      const { data, error } = await db
        .from('account_pool')
        .select('id, account_data, used, created_at')
        .eq('product_id', product_id)
        .eq('used', false)
        .order('created_at', { ascending: false });

      if (error) return res.status(500).json({ error: error.message });
      return res.status(200).json({ items: data || [], count: (data || []).length });
    }

    // ── POST (single) ─────────────────────────────────────────────────
    if (req.method === 'POST') {
      const { product_id, account_data } = req.body || {};
      if (!product_id) return res.status(400).json({ error: 'product_id diperlukan' });
      if (!account_data || typeof account_data !== 'object')
        return res.status(400).json({ error: 'account_data harus berupa object' });

      const { data, error } = await db.from('account_pool').insert({
        product_id,
        account_data,
        used: false,
      }).select().single();

      if (error) return res.status(500).json({ error: error.message });
      return res.status(201).json(data);
    }

    // ── DELETE ────────────────────────────────────────────────────────
    if (req.method === 'DELETE') {
      const { id } = req.body || {};
      if (!id) return res.status(400).json({ error: 'id diperlukan' });
      const { error } = await db.from('account_pool').delete().eq('id', id);
      if (error) return res.status(500).json({ error: error.message });
      return res.status(200).json({ success: true });
    }

    return res.status(405).json({ error: 'Method not allowed' });
  } catch (err) {
    console.error('Stock error:', err);
    return res.status(500).json({ error: err.message || 'Internal server error' });
  }
}
