import { createClient } from '@supabase/supabase-js';

function getDb() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_KEY;
  if (!url || !key) throw new Error('SUPABASE_URL / SUPABASE_SERVICE_KEY belum dikonfigurasi');
  return createClient(url, key);
}

// Parse NeoXR check response — might be JSON or plain string ("paid"/"pending"/etc)
function parseCheckStatus(rawText) {
  const trimmed = (rawText || '').trim().toLowerCase();
  try {
    const j = JSON.parse(rawText);
    const s = (j?.data?.status || j?.status || '').toLowerCase();
    return s;
  } catch (_) { /* not JSON */ }
  // Plain string: "paid", "pending", "expired", "failed", "success"
  return trimmed;
}

const PAID_STATUSES   = new Set(['paid','success','completed','settlement']);
const FAILED_STATUSES = new Set(['expired','failed','cancelled','cancel','deny','failure']);

export default async function handler(req, res) {
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const { txn_id } = req.body || {};
    if (!txn_id) return res.status(400).json({ error: 'txn_id diperlukan' });

    const db = getDb();

    // Fetch order
    const { data: orders, error: oErr } = await db
      .from('orders')
      .select('*')
      .eq('txn_id', txn_id)
      .limit(1);

    if (oErr) return res.status(500).json({ error: oErr.message });
    if (!orders || orders.length === 0) return res.status(404).json({ error: 'Transaksi tidak ditemukan' });

    const order = orders[0];

    // Already resolved
    if (order.status === 'paid') {
      const { data: pool } = await db
        .from('account_pool')
        .select('account_data')
        .eq('order_id', order.id);

      const { data: prodRows } = await db
        .from('products')
        .select('rules')
        .eq('id', order.product_id)
        .limit(1);

      const rules = prodRows?.[0]?.rules || '';
      const accounts = (pool || []).map(a => ({ ...a.account_data, ...(rules ? { rules } : {}) }));
      return res.status(200).json({ status: 'paid', accounts, order });
    }

    if (order.status === 'expired' || order.status === 'failed') {
      return res.status(200).json({ status: order.status });
    }

    // Query gateway
    const apiKey = process.env.TAKO_API_KEY;
    if (!apiKey) return res.status(500).json({ error: 'TAKO_API_KEY belum dikonfigurasi' });

    const checkUrl = `https://api.neoxr.eu/api/tako-check?id=${encodeURIComponent(txn_id)}&apikey=${encodeURIComponent(apiKey)}`;

    let rawText = '';
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 10_000);
      const gwRes = await fetch(checkUrl, { signal: controller.signal });
      clearTimeout(timeout);
      rawText = await gwRes.text();
    } catch (fetchErr) {
      // Network error — return pending so user can retry
      console.error('Gateway check fetch error:', fetchErr.message);
      return res.status(200).json({ status: 'pending', message: 'Cek koneksi gateway, coba lagi' });
    }

    console.log('Check gateway response:', rawText.slice(0, 200));
    const payStatus = parseCheckStatus(rawText);

    if (PAID_STATUSES.has(payStatus)) {
      // Claim accounts atomically
      const { data: pool, error: pErr } = await db
        .from('account_pool')
        .select('id, account_data')
        .eq('product_id', order.product_id)
        .eq('used', false)
        .order('created_at', { ascending: true })
        .limit(order.quantity);

      if (pErr) return res.status(500).json({ error: pErr.message });

      const now = new Date().toISOString();
      const ids = (pool || []).map(a => a.id);

      if (ids.length > 0) {
        await db.from('account_pool')
          .update({ used: true, order_id: order.id, used_at: now })
          .in('id', ids);
      }

      await db.from('orders').update({ status: 'paid', paid_at: now }).eq('id', order.id);

      const { data: prodRows } = await db.from('products').select('rules').eq('id', order.product_id).limit(1);
      const rules = prodRows?.[0]?.rules || '';
      const accounts = (pool || []).map(a => ({ ...a.account_data, ...(rules ? { rules } : {}) }));

      return res.status(200).json({
        status: 'paid',
        accounts,
        order: { ...order, status: 'paid', paid_at: now },
      });
    }

    if (FAILED_STATUSES.has(payStatus)) {
      await db.from('orders').update({ status: 'expired' }).eq('id', order.id);
      return res.status(200).json({ status: 'expired' });
    }

    return res.status(200).json({ status: 'pending' });
  } catch (err) {
    console.error('Check error:', err);
    return res.status(500).json({ error: err.message || 'Internal server error' });
  }
        }
