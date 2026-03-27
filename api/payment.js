import { createClient } from '@supabase/supabase-js';

function getDb() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_KEY;
  if (!url || !key) throw new Error('SUPABASE_URL / SUPABASE_SERVICE_KEY belum dikonfigurasi');
  return createClient(url, key);
}

const DURATION_LABELS = {
  '1d':'1 Hari','3d':'3 Hari','7d':'1 Minggu','10d':'10 Hari',
  '15d':'15 Hari','20d':'20 Hari','1m':'1 Bulan','3m':'3 Bulan',
  '6m':'6 Bulan','1y':'1 Tahun',
};

function validateEmail(e) { return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e); }

export default async function handler(req, res) {
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const { product_id, duration, quantity, email, whatsapp } = req.body || {};

    if (!product_id || !duration || !quantity || !email || !whatsapp)
      return res.status(400).json({ error: 'Semua field wajib diisi' });
    if (!validateEmail(email))
      return res.status(400).json({ error: 'Format email tidak valid' });
    const qty = parseInt(quantity, 10);
    if (!qty || qty < 1 || qty > 20)
      return res.status(400).json({ error: 'Jumlah akun harus antara 1–20' });

    const merchant = process.env.TAKO_MERCHANT;
    const apiKey   = process.env.TAKO_API_KEY;
    if (!merchant || !apiKey)
      return res.status(500).json({ error: 'TAKO_MERCHANT / TAKO_API_KEY belum dikonfigurasi' });

    const db = getDb();

    // Fetch product
    const { data: rows, error: pErr } = await db
      .from('products')
      .select('id, name, category, prices, rules')
      .eq('id', product_id)
      .eq('active', true)
      .limit(1);

    if (pErr) return res.status(500).json({ error: pErr.message });
    if (!rows || rows.length === 0)
      return res.status(404).json({ error: 'Produk tidak ditemukan atau tidak aktif' });

    const prod  = rows[0];
    const price = prod.prices?.[duration];
    if (!price) return res.status(400).json({ error: 'Durasi tidak tersedia untuk produk ini' });

    // Check stock
    const { data: stockRows, error: sErr } = await db
      .from('account_pool')
      .select('id')
      .eq('product_id', product_id)
      .eq('used', false);

    if (sErr) return res.status(500).json({ error: sErr.message });
    const stockCount = (stockRows || []).length;
    if (stockCount < qty)
      return res.status(400).json({ error: `Stok tidak cukup. Tersedia: ${stockCount}, diminta: ${qty}` });

    const total    = price * qty;
    const durLabel = DURATION_LABELS[duration] || duration;
    // message = "nama produk x jumlah durasi"  (max ~40 chars for gateway)
    const msgText  = `${prod.name} x${qty} ${durLabel}`.slice(0, 40);

    // === NeoXR tako-create — GET request ===
    // amount = total price * quantity already computed as total
    const gatewayUrl = `https://api.neoxr.eu/api/tako-create`
      + `?username=${encodeURIComponent(merchant)}`
      + `&amount=${total}`
      + `&message=${encodeURIComponent(msgText)}`
      + `&apikey=${encodeURIComponent(apiKey)}`;

    let gwJson;
    try {
      const controller = new AbortController();
      const t = setTimeout(() => controller.abort(), 15_000);
      const gwRes = await fetch(gatewayUrl, { method: 'GET', signal: controller.signal });
      clearTimeout(t);

      // Always read as text first to avoid JSON parse crash
      const rawText = await gwRes.text();
      console.log('NeoXR create raw (200 chars):', rawText.slice(0, 200));

      try {
        gwJson = JSON.parse(rawText);
      } catch (_) {
        return res.status(502).json({ error: 'Gateway mengembalikan respon bukan JSON: ' + rawText.slice(0, 120) });
      }
    } catch (fetchErr) {
      return res.status(502).json({ error: 'Gagal menghubungi gateway: ' + fetchErr.message });
    }

    // Validate gateway response using NeoXR exact format
    if (!gwJson?.status) {
      const msg = gwJson?.msg || gwJson?.message || JSON.stringify(gwJson).slice(0, 120);
      return res.status(502).json({ error: 'Gateway error: ' + msg });
    }

    const txnId   = gwJson?.data?.id;
    const qrImage = gwJson?.data?.qr_image;

    if (!txnId || !qrImage) {
      console.error('NeoXR missing fields:', JSON.stringify(gwJson).slice(0, 300));
      return res.status(502).json({ error: 'Gateway tidak mengembalikan id/qr_image' });
    }

    // Save order to Supabase
    const { error: oErr } = await db.from('orders').insert({
      txn_id:         txnId,
      product_id:     prod.id,
      product_name:   prod.name,
      category:       prod.category,
      email:          email.toLowerCase().trim(),
      whatsapp:       whatsapp.trim(),
      duration,
      duration_label: durLabel,
      quantity:       qty,
      total,
      status: 'pending',
    });

    if (oErr) {
      // Ignore duplicate key (user re-submitted same payment)
      if (!oErr.code?.includes('23505') && !oErr.message?.includes('duplicate')) {
        console.error('Order insert error:', oErr);
        return res.status(500).json({ error: 'Gagal menyimpan pesanan: ' + oErr.message });
      }
    }

    return res.status(200).json({
      txn_id:   txnId,
      qr_image: qrImage,
      pay_url:  gwJson?.data?.url || null,
      total,
    });

  } catch (err) {
    console.error('Payment unhandled error:', err);
    return res.status(500).json({ error: err.message || 'Internal server error' });
  }
}
