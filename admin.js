// Simple in-memory rate limiter (resets per cold-start)
const attempts = new Map();
const MAX = 5, WINDOW = 60_000;

function rateCheck(ip) {
  const now = Date.now();
  const rec = attempts.get(ip) || { count: 0, start: now };
  if (now - rec.start > WINDOW) { rec.count = 0; rec.start = now; }
  rec.count++;
  attempts.set(ip, rec);
  return rec.count <= MAX;
}

export default async function handler(req, res) {
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || 'unknown';
  if (!rateCheck(ip)) return res.status(429).json({ error: 'Too many attempts, try again later' });

  const { password } = req.body || {};
  if (!password) return res.status(400).json({ error: 'Password diperlukan' });

  const stored = process.env.ADMIN_PASSWORD;
  if (!stored) return res.status(500).json({ error: 'Admin not configured' });

  // Constant-time comparison to prevent timing attacks
  const equal = password.length === stored.length &&
    [...password].every((c, i) => c === stored[i]);

  if (equal) return res.status(200).json({ ok: true, key: stored });
  return res.status(401).json({ error: 'Password salah' });
}
