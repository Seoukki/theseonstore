import { createClient } from '@supabase/supabase-js';

function getDb() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_KEY;
  if (!url || !key) throw new Error('Supabase not configured');
  return createClient(url, key);
}

async function getAdmin(req) {
  const token = req.headers['x-admin-token'] || '';
  const legacyKey = req.headers['x-admin-key'] || '';
  if (!token && !legacyKey) return null;
  const db = getDb();
  if (token) {
    const { data } = await db.from('admins').select('id,username,role').eq('session_token', token).eq('active', true).single();
    return data || null;
  }
  // Legacy: x-admin-key for backwards compat
  if (legacyKey === process.env.ADMIN_PASSWORD) return { id: 'legacy', username: 'legacy', role: 'admin' };
  return null;
}

async function logAction(db, admin, action, detail) {
  if (!admin || admin.id === 'legacy') return;
  await db.from('admin_logs').insert({ admin_id: admin.id, admin_name: admin.username, action, detail }).catch(()=>{});
}

export default async function handler(req, res) {
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-admin-token, x-admin-key');
  if (req.method === 'OPTIONS') return res.status(200).end();

  try {
    const db = getDb();
    const admin = await getAdmin(req);
    const isAdmin = !!admin;

    if (req.method === 'GET') {
      let q = db.from('products')
        .select('id,name,category,description,image_url,prices,badge,active,rules,created_at')
        .order('created_at', { ascending: false });
      if (!isAdmin) q = q.eq('active', true);

      const { data: products, error } = await q;
      if (error) return res.status(500).json({ error: error.message });

      // Count stock per product
      const { data: poolRows } = await db.from('account_pool').select('product_id,duration').eq('used', false);
      const stockMap = {};
      (poolRows||[]).forEach(r => {
        stockMap[r.product_id] = (stockMap[r.product_id]||0) + 1;
      });

      return res.status(200).json((products||[]).map(p => ({ ...p, stock: stockMap[p.id]||0 })));
    }

    if (!isAdmin) return res.status(401).json({ error: 'Unauthorized' });

    if (req.method === 'POST') {
      const { name, category, description, image_url, prices, badge, rules } = req.body || {};
      if (!name?.trim() || !category || !prices) return res.status(400).json({ error: 'name, category, prices wajib' });
      const { data, error } = await db.from('products').insert({ name:name.trim(), category, description:'', image_url:'', prices, badge:badge||'', rules:rules||'', active:true, ...{description,image_url} }).select().single();
      if (error) return res.status(500).json({ error: error.message });
      await logAction(db, admin, 'ADD_PRODUCT', `Tambah produk: ${name}`);
      return res.status(201).json(data);
    }

    if (req.method === 'PUT') {
      const { id, ...fields } = req.body || {};
      if (!id) return res.status(400).json({ error: 'id diperlukan' });
      const allowed = ['name','category','description','image_url','prices','badge','active','rules'];
      const updates = { updated_at: new Date().toISOString() };
      allowed.forEach(k => { if (fields[k] !== undefined) updates[k] = fields[k]; });
      const { data, error } = await db.from('products').update(updates).eq('id', id).select().single();
      if (error) return res.status(500).json({ error: error.message });
      await logAction(db, admin, 'EDIT_PRODUCT', `Edit produk ID: ${id} — ${JSON.stringify(updates)}`);
      return res.status(200).json(data);
    }

    if (req.method === 'DELETE') {
      const { id } = req.body || {};
      if (!id) return res.status(400).json({ error: 'id diperlukan' });
      const { data: prod } = await db.from('products').select('name').eq('id', id).single();
      await db.from('products').update({ active: false }).eq('id', id);
      await logAction(db, admin, 'DELETE_PRODUCT', `Hapus produk: ${prod?.name || id}`);
      return res.status(200).json({ success: true });
    }

    return res.status(405).json({ error: 'Method not allowed' });
  } catch (err) {
    console.error('Products error:', err);
    return res.status(500).json({ error: err.message });
  }
}
