import { createClient } from '@supabase/supabase-js';
import crypto from 'crypto';

function getDb() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_KEY;
  if (!url || !key) throw new Error('Supabase not configured');
  return createClient(url, key);
}

const hashPw = (pw) => crypto.createHash('sha256').update(pw + (process.env.SALT || 'sp2025')).digest('hex');

// Check if requester is a valid admin (via x-admin-token header)
async function verifyAdmin(req) {
  const token = req.headers['x-admin-token'] || '';
  if (!token) return null;
  const db = getDb();
  const { data } = await db.from('admins').select('*').eq('session_token', token).eq('active', true).limit(1);
  return data?.[0] || null;
}

// Check if requester is super-admin
async function verifySuperAdmin(req) {
  const admin = await verifyAdmin(req);
  return (admin?.role === 'superadmin') ? admin : null;
}

export default async function handler(req, res) {
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-admin-token');
  if (req.method === 'OPTIONS') return res.status(200).end();

  try {
    const db = getDb();

    // GET /api/admins — list all admins (superadmin only)
    if (req.method === 'GET') {
      const admin = await verifySuperAdmin(req);
      if (!admin) return res.status(401).json({ error: 'Superadmin required' });
      const { data, error } = await db.from('admins')
        .select('id, username, email, role, active, created_at, last_login')
        .order('created_at');
      if (error) return res.status(500).json({ error: error.message });
      return res.status(200).json(data || []);
    }

    // POST /api/admins — add new admin (superadmin only)
    if (req.method === 'POST') {
      const sa = await verifySuperAdmin(req);
      if (!sa) return res.status(401).json({ error: 'Superadmin required' });

      const { username, email, password, role = 'admin' } = req.body || {};
      if (!username || !email || !password)
        return res.status(400).json({ error: 'username, email, password wajib diisi' });

      const { data, error } = await db.from('admins').insert({
        username: username.trim(),
        email: email.toLowerCase().trim(),
        password_hash: hashPw(password),
        role: role === 'superadmin' ? 'superadmin' : 'admin',
        active: true,
      }).select('id, username, email, role').single();

      if (error) return res.status(500).json({ error: error.message });

      // Log action
      await db.from('admin_logs').insert({
        admin_id: sa.id, admin_name: sa.username,
        action: 'ADD_ADMIN', detail: `Menambah admin: ${username} (${role})`,
      });

      return res.status(201).json(data);
    }

    // PUT /api/admins — update admin (superadmin only)
    if (req.method === 'PUT') {
      const sa = await verifySuperAdmin(req);
      if (!sa) return res.status(401).json({ error: 'Superadmin required' });

      const { id, active, role, password } = req.body || {};
      if (!id) return res.status(400).json({ error: 'id diperlukan' });

      const updates = {};
      if (active !== undefined) updates.active = active;
      if (role) updates.role = role;
      if (password) updates.password_hash = hashPw(password);

      const { error } = await db.from('admins').update(updates).eq('id', id);
      if (error) return res.status(500).json({ error: error.message });

      await db.from('admin_logs').insert({
        admin_id: sa.id, admin_name: sa.username,
        action: 'UPDATE_ADMIN', detail: `Update admin ID ${id}: ${JSON.stringify(updates)}`,
      });

      return res.status(200).json({ success: true });
    }

    // DELETE /api/admins — remove admin (superadmin only)
    if (req.method === 'DELETE') {
      const sa = await verifySuperAdmin(req);
      if (!sa) return res.status(401).json({ error: 'Superadmin required' });

      const { id } = req.body || {};
      if (!id) return res.status(400).json({ error: 'id diperlukan' });
      if (id === sa.id) return res.status(400).json({ error: 'Tidak bisa menghapus akun sendiri' });

      const { data: target } = await db.from('admins').select('username').eq('id', id).single();
      await db.from('admins').update({ active: false }).eq('id', id);

      await db.from('admin_logs').insert({
        admin_id: sa.id, admin_name: sa.username,
        action: 'REMOVE_ADMIN', detail: `Nonaktifkan admin: ${target?.username || id}`,
      });

      return res.status(200).json({ success: true });
    }

    return res.status(405).json({ error: 'Method not allowed' });
  } catch (err) {
    console.error('Admins error:', err);
    return res.status(500).json({ error: err.message });
  }
        }
