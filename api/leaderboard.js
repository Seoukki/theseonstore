import { createClient } from '@supabase/supabase-js';

const sb = () => createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY);

function maskEmail(email) {
  const [local, domain] = email.split('@');
  if (!domain) return email.slice(0, 2) + '***';
  const masked = local.length <= 2
    ? local + '***'
    : local.slice(0, 2) + '***' + local.slice(-1);
  return `${masked}@${domain}`;
}

export default async function handler(req, res) {
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const db = sb();

    // Monthly range filter
    const now = new Date();
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1).toISOString();

    const { data, error } = await db
      .from('orders')
      .select('email, total, product_name, created_at')
      .eq('status', 'paid')
      .gte('created_at', monthStart)
      .order('created_at', { ascending: false });

    if (error) return res.status(500).json({ error: error.message });

    const map = {};
    for (const o of data || []) {
      if (!map[o.email]) {
        map[o.email] = {
          email: maskEmail(o.email),
          total: 0,
          count: 0,
          products: new Set(),
        };
      }
      map[o.email].total += o.total || 0;
      map[o.email].count += 1;
      if (o.product_name) map[o.email].products.add(o.product_name.split(' ')[0]);
    }

    const leaderboard = Object.values(map)
      .sort((a, b) => b.total - a.total)
      .slice(0, 10)
      .map(({ products, ...rest }) => ({ ...rest, top_product: [...products][0] || null }));

    return res.status(200).json({
      leaderboard,
      total_customers: Object.keys(map).length,
      month: now.toLocaleString('id-ID', { month: 'long', year: 'numeric' }),
    });
  } catch (err) {
    console.error('Leaderboard error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
}
