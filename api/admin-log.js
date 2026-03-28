import { createClient } from '@supabase/supabase-js';

function getDb() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_KEY;
  if (!url || !key) throw new Error('Supabase not configured');
  return createClient(url, key);
}

async function verifyAdmin(req) {
  const token = req.headers['x-admin-token'] || '';
  if (!token) return null;
  const db = getDb();
  const { data } = await db.from('admins').select('id,username,role').eq('session_token', token).eq('active', true).single();
  return data || null;
}

export default async function handler(req, res) {
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-admin-token');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const admin = await verifyAdmin(req);
    if (!admin) return res.status(401).json({ error: 'Unauthorized' });

    const db = getDb();
    const limit = Math.min(parseInt(req.query.limit || '100', 10), 500);
    const adminId = req.query.admin_id;

    let query = db.from('admin_logs')
      .select('id, admin_id, admin_name, action, detail, created_at')
      .order('created_at', { ascending: false })
      .limit(limit);

    // Non-superadmin can only see their own logs
    if (admin.role !== 'superadmin') {
      query = query.eq('admin_id', admin.id);
    } else if (adminId) {
      query = query.eq('admin_id', adminId);
    }

    const { data, error } = await query;
    if (error) return res.status(500).json({ error: error.message });
    return res.status(200).json(data || []);
  } catch (err) {
    console.error('admin-log error:', err);
    return res.status(500).json({ error: err.message });
  }
}
