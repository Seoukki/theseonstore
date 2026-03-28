import { createClient } from '@supabase/supabase-js';

function getDb() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_KEY;
  if (!url || !key) throw new Error('Supabase not configured');
  return createClient(url, key);
}

export default async function handler(req, res) {
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const { txn_id, email, whatsapp } = req.body || {};
    if (!txn_id) return res.status(400).json({ error: 'txn_id diperlukan' });

    const db = getDb();
    const { data: orders, error } = await db
      .from('orders').select('*').eq('txn_id', txn_id).limit(1);

    if (error) return res.status(500).json({ error: error.message });
    if (!orders?.length) return res.status(404).json({ error: 'Transaksi tidak ditemukan' });

    const order = orders[0];

    // Verify identity if email/whatsapp provided (for cek-pesanan)
    if (email || whatsapp) {
      const emailOk = email ? order.email.toLowerCase() === email.toLowerCase().trim() : true;
      const waOk    = whatsapp ? order.whatsapp === whatsapp.trim() : true;
      if (!emailOk || !waOk) return res.status(403).json({ error: 'Email atau nomor WhatsApp tidak cocok' });
    }

    if (order.status === 'paid') {
      let accounts = [];
      try { accounts = JSON.parse(order.accounts_snapshot || '[]'); } catch(_) {}
      return res.status(200).json({ status: 'paid', accounts, order: {
        txn_id: order.txn_id, product_name: order.product_name,
        duration_label: order.duration_label, quantity: order.quantity,
        total: order.total, paid_at: order.paid_at, created_at: order.created_at,
      }});
    }

    if (order.status === 'expired') return res.status(200).json({ status: 'expired' });

    // Auto-expire after 6 minutes
    const created = new Date(order.created_at).getTime();
    if (Date.now() - created > 6 * 60 * 1000) {
      await db.from('orders').delete().eq('id', order.id);
      return res.status(200).json({ status: 'expired' });
    }

    return res.status(200).json({ status: 'pending' });
  } catch (err) {
    console.error('order-status error:', err);
    return res.status(500).json({ error: err.message });
  }
}
