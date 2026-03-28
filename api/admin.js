import { createClient } from '@supabase/supabase-js';
import crypto from 'crypto';

function getDb() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_KEY;
  if (!url || !key) throw new Error('Supabase not configured');
  return createClient(url, key);
}

const hashPw   = pw => crypto.createHash('sha256').update(pw + (process.env.SALT || 'sp2025')).digest('hex');
const genToken = () => crypto.randomBytes(32).toString('hex');

const attempts = new Map();
function rateOk(ip) {
  const now = Date.now(), r = attempts.get(ip) || { n:0, t:now };
  if (now - r.t > 60000) { r.n=0; r.t=now; }
  r.n++; attempts.set(ip, r); return r.n <= 8;
}

export default async function handler(req, res) {
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-admin-token');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const ip = (req.headers['x-forwarded-for']||'unknown').split(',')[0].trim();
  const db = getDb();

  try {
    const { action, username, password, token } = req.body || {};

    // LOGOUT
    if (action === 'logout') {
      if (!token) return res.status(400).json({ error: 'token diperlukan' });
      const { data: admin } = await db.from('admins').select('id,username,login_at').eq('session_token', token).single();
      if (admin) {
        const durMin = admin.login_at ? Math.round((Date.now()-new Date(admin.login_at).getTime())/60000) : 0;
        await db.from('admins').update({ session_token: null }).eq('id', admin.id);
        await db.from('admin_logs').insert({ admin_id: admin.id, admin_name: admin.username, action: 'LOGOUT', detail: `Logout setelah ${durMin} menit` });
      }
      return res.status(200).json({ ok: true });
    }

    // VERIFY TOKEN
    if (action === 'verify') {
      if (!token) return res.status(401).json({ error: 'Token diperlukan' });
      const { data: admin } = await db.from('admins').select('id,username,email,role,login_at').eq('session_token', token).eq('active', true).single();
      if (!admin) return res.status(401).json({ error: 'Token tidak valid atau kedaluwarsa' });
      return res.status(200).json({ ok: true, admin: { id:admin.id, username:admin.username, email:admin.email, role:admin.role, login_at:admin.login_at } });
    }

    // LOGIN
    if (!rateOk(ip)) return res.status(429).json({ error: 'Terlalu banyak percobaan' });
    if (!username || !password) return res.status(400).json({ error: 'username dan password wajib diisi' });

    // Try master env admin first
    const masterUser = process.env.SUPER_ADMIN_USER || 'superadmin';
    const masterPass = process.env.ADMIN_PASSWORD   || '';
    let adminRecord;

    if (masterPass && username === masterUser && password === masterPass) {
      const { data: ex } = await db.from('admins').select('*').eq('username', masterUser).limit(1);
      if (ex?.[0]) {
        adminRecord = ex[0];
      } else {
        const { data: cr } = await db.from('admins').insert({
          username: masterUser, email: process.env.SUPER_ADMIN_EMAIL || 'admin@seonsstore.com',
          password_hash: hashPw(masterPass), role: 'superadmin', active: true,
        }).select().single();
        adminRecord = cr;
      }
    } else {
      const { data: rows } = await db.from('admins').select('*').eq('active', true)
        .or(`username.eq.${username},email.eq.${username}`).limit(1);
      const found = rows?.[0];
      if (!found || found.password_hash !== hashPw(password))
        return res.status(401).json({ error: 'Username atau password salah' });
      adminRecord = found;
    }

    if (!adminRecord) return res.status(401).json({ error: 'Login gagal' });

    const sessionToken = genToken();
    const now = new Date().toISOString();
    await db.from('admins').update({ session_token: sessionToken, last_login: now, login_at: now }).eq('id', adminRecord.id);
    await db.from('admin_logs').insert({ admin_id: adminRecord.id, admin_name: adminRecord.username, action: 'LOGIN', detail: `Login dari IP: ${ip}` });

    return res.status(200).json({
      ok: true, token: sessionToken,
      admin: { id: adminRecord.id, username: adminRecord.username, email: adminRecord.email, role: adminRecord.role },
    });
  } catch (err) {
    console.error('Admin error:', err);
    return res.status(500).json({ error: err.message });
  }
      }
