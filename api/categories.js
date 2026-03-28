import { createClient } from '@supabase/supabase-js';

function getDb() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_KEY;
  if (!url || !key) throw new Error('Supabase not configured');
  return createClient(url, key);
}

const adminCheck = req => (req.headers['x-admin-key'] || '') === process.env.ADMIN_PASSWORD;

export default async function handler(req, res) {
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-admin-key');
  if (req.method === 'OPTIONS') return res.status(200).end();

  try {
    const db = getDb();

    if (req.method === 'GET') {
      const { data, error } = await db.from('categories').select('*').order('name');
      if (error) {
        // Fallback: derive from products
        const { data: prods } = await db.from('products').select('category').eq('active', true);
        const cats = [...new Set((prods||[]).map(p => p.category))].sort().map(name => ({id:name, name, slug:name}));
        return res.status(200).json(cats);
      }
      return res.status(200).json(data || []);
    }

    if (!adminCheck(req)) return res.status(401).json({ error: 'Unauthorized' });

    if (req.method === 'POST') {
      const { name } = req.body || {};
      if (!name?.trim()) return res.status(400).json({ error: 'name diperlukan' });
      const slug = name.trim().toLowerCase().replace(/[^a-z0-9]/g, '_');
      const { data, error } = await db.from('categories').insert({ name: name.trim(), slug }).select().single();
      if (error) return res.status(500).json({ error: error.message });
      return res.status(201).json(data);
    }

    if (req.method === 'DELETE') {
      const { id } = req.body || {};
      if (!id) return res.status(400).json({ error: 'id diperlukan' });
      const { error } = await db.from('categories').delete().eq('id', id);
      if (error) return res.status(500).json({ error: error.message });
      return res.status(200).json({ success: true });
    }

    return res.status(405).json({ error: 'Method not allowed' });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
