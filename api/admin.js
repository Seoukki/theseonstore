// Simple per-invocation rate limiter
const attempts = new Map();
function rateOk(ip) {
  const now = Date.now();
  const r = attempts.get(ip) || { n: 0, t: now };
  if (now - r.t > 60_000) { r.n = 0; r.t = now; }
  r.n++;
  attempts.set(ip, r);
  return r.n <= 10;
}

export default async function handler(req, res) {
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const ip = (req.headers['x-forwarded-for'] || 'unknown').split(',')[0].trim();
    if (!rateOk(ip)) return res.status(429).json({ error: 'Terlalu banyak percobaan, tunggu 1 menit' });

    const { password } = req.body || {};
    if (!password) return res.status(400).json({ error: 'Password diperlukan' });

    const stored = process.env.ADMIN_PASSWORD;
    if (!stored) return res.status(500).json({ error: 'ADMIN_PASSWORD belum diset di environment variables' });

    // Constant-time comparison
    let eq = password.length === stored.length;
    for (let i = 0; i < Math.max(password.length, stored.length); i++) {
      if ((password[i] || '') !== (stored[i] || '')) eq = false;
    }

    if (eq) return res.status(200).json({ ok: true, key: stored });
    return res.status(401).json({ error: 'Password salah' });
  } catch (err) {
    console.error('Admin error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
}
