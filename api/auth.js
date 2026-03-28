import { createClient } from '@supabase/supabase-js';
import crypto from 'crypto';

function getDb() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_KEY;
  if (!url || !key) throw new Error('Supabase not configured');
  return createClient(url, key);
}

const hashPw   = pw => crypto.createHash('sha256').update(pw + (process.env.SALT || 'sp2025')).digest('hex');
const genToken = () => crypto.randomBytes(24).toString('hex');

const validateEmail = e => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e);
const validatePhone = p => /^[0-9+\-\s]{8,15}$/.test(p);

export default async function handler(req, res) {
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-user-token');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const db = getDb();
    const { action, name, email, phone, password, token } = req.body || {};

    // VERIFY TOKEN
    if (action === 'verify') {
      if (!token) return res.status(401).json({ error: 'Token diperlukan' });
      const { data: user } = await db.from('users').select('id,name,email,phone').eq('session_token', token).single();
      if (!user) return res.status(401).json({ error: 'Sesi tidak valid atau kedaluwarsa' });
      return res.status(200).json({ ok: true, user });
    }

    // LOGOUT
    if (action === 'logout') {
      if (token) await db.from('users').update({ session_token: null }).eq('session_token', token);
      return res.status(200).json({ ok: true });
    }

    // REGISTER
    if (action === 'register') {
      if (!name?.trim() || !email || !phone || !password)
        return res.status(400).json({ error: 'Semua field wajib diisi' });
      if (!validateEmail(email)) return res.status(400).json({ error: 'Format email tidak valid' });
      if (!validatePhone(phone)) return res.status(400).json({ error: 'Format nomor telepon tidak valid' });
      if (password.length < 6)   return res.status(400).json({ error: 'Password minimal 6 karakter' });

      // Check duplicate
      const { data: exist } = await db.from('users').select('id').eq('email', email.toLowerCase()).limit(1);
      if (exist?.length) return res.status(409).json({ error: 'Email sudah terdaftar' });

      const sessionToken = genToken();
      const { data: user, error } = await db.from('users').insert({
        name:          name.trim(),
        email:         email.toLowerCase().trim(),
        phone:         phone.trim(),
        password_hash: hashPw(password),
        session_token: sessionToken,
      }).select('id,name,email,phone').single();

      if (error) return res.status(500).json({ error: error.message });
      return res.status(201).json({ ok: true, token: sessionToken, user });
    }

    // LOGIN
    if (action === 'login') {
      if (!email || !password) return res.status(400).json({ error: 'Email dan password wajib diisi' });

      const { data: users } = await db.from('users').select('*')
        .or(`email.eq.${email.toLowerCase().trim()},phone.eq.${email.trim()}`).limit(1);
      const user = users?.[0];
      if (!user || user.password_hash !== hashPw(password))
        return res.status(401).json({ error: 'Email/nomor atau password salah' });

      const sessionToken = genToken();
      await db.from('users').update({ session_token: sessionToken, last_login: new Date().toISOString() }).eq('id', user.id);
      return res.status(200).json({ ok: true, token: sessionToken, user: { id: user.id, name: user.name, email: user.email, phone: user.phone } });
    }

    return res.status(400).json({ error: 'action tidak dikenal' });
  } catch (err) {
    console.error('Auth error:', err);
    return res.status(500).json({ error: err.message });
  }
}
