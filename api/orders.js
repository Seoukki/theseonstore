import { createClient } from '@supabase/supabase-js';

const sb = () => createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
const adminCheck = req => (req.headers['x-admin-key'] || '') === process.env.ADMIN_PASSWORD;

export default async function handler(req, res) {
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-admin-key');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (!adminCheck(req)) return res.status(401).json({ error: 'Unauthorized' });
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const db = sb();
    const limit = Math.min(parseInt(req.query.limit || '200', 10), 500);
    const status = req.query.status; // filter by status

    let query = db
      .from('orders')
      .select('id, txn_id, product_name, email, total, status, created_at, paid_at, quantity, duration_label')
      .order('created_at', { ascending: false })
      .limit(limit);

    if (status) query = query.eq('status', status);

    const { data: orders, error } = await query;
    if (error) return res.status(500).json({ error: error.message });

    const paid = (orders || []).filter(o => o.status === 'paid');
    const totalRevenue = paid.reduce((s, o) => s + (o.total || 0), 0);

    // Revenue by product
    const revenueByProduct = {};
    paid.forEach(o => {
      const k = o.product_name || 'Lainnya';
      revenueByProduct[k] = (revenueByProduct[k] || 0) + 1;
    });

    return res.status(200).json({
      orders: orders || [],
      stats: {
        total_orders: orders?.length || 0,
        paid_orders:  paid.length,
        pending_orders: (orders || []).filter(o => o.status === 'pending').length,
        total_revenue: totalRevenue,
      },
      revenue_by_product: revenueByProduct,
    });
  } catch (err) {
    console.error('Orders error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
}
