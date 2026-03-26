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

// Parse NeoXR response — handles both JSON and plain-string formats
function parseGatewayResponse(rawText) {
  const trimmed = (rawText || '').trim();

  // Try JSON first
  try {
    const j = JSON.parse(trimmed);
    // Check for error in JSON
    if (j?.status === false || j?.error || j?.message?.toLowerCase?.().includes('error')) {
      return { error: j?.message || j?.error || 'Gateway menolak request' };
    }
    const id = j?.data?.id || j?.id || j?.transaction_id;
    const qr = j?.data?.qr_image || j?.qr_image || j?.data?.qr || j?.qr || j?.data?.image;
    if (id && qr) return { txnId: String(id), qrImage: String(qr) };
    return { error: 'Response gateway tidak lengkap: ' + trimmed.slice(0, 120) };
  } catch (_) { /* not JSON, continue */ }

  // Plain string handling — NeoXR sometimes returns "id|qrImageUrl" or just the QR
  if (!trimmed) return { error: 'Gateway mengembalikan response kosong' };

  // Format: "txnId|qrImageData"
  if (trimmed.includes('|')) {
    const [id, ...rest] = trimmed.split('|');
    const qr = rest.join('|');
    if (id && qr) return { txnId: id.trim(), qrImage: qr.trim() };
  }

  // Format: just QR image (base64 or URL)
  if (trimmed.startsWith('data:image') || trimmed.startsWith('http')) {
    const txnId = `TKN_${Date.now()}_${Math.random().toString(36).slice(2, 7).toUpperCase()}`;
    return { txnId, qrImage: trimmed };
  }

  // Looks like an error message
  return { error: 'Gateway error: ' + trimmed.slice(0, 200) };
}

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

    const db = getDb();

    // Validate env vars for gateway
    const merchant = process.env.TAKO_MERCHANT;
    const apiKey   = process.env.TAKO_API_KEY;
    if (!merchant || !apiKey)
      return res.status(500).json({ error: 'TAKO_MERCHANT / TAKO_API_KEY belum dikonfigurasi di environment variables' });

    // Fetch product
    const { data: product, error: pErr } = await db
      .from('products')
      .select('id, name, category, prices, rules')
      .eq('id', product_id)
      .eq('active', true)
      .limit(1);

    if (pErr) return res.status(500).json({ error: pErr.message });
    if (!product || product.length === 0) return res.status(404).json({ error: 'Produk tidak ditemukan atau tidak aktif' });

    const prod = product[0];
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

    const total   = price * qty;
    const msgText = `${prod.name} x${qty} ${DURATION_LABELS[duration] || duration}`;

    // Call NeoXR gateway — GET request, returns string or JSON
    const gatewayUrl = `https://api.neoxr.eu/api/tako-create`
      + `?username=${encodeURIComponent(merchant)}`
      + `&amount=${total}`
      + `&message=${encodeURIComponent(msgText)}`
      + `&apikey=${encodeURIComponent(apiKey)}`;

    let gatewayText = '';
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 12_000);
      const payRes = await fetch(gatewayUrl, { signal: controller.signal });
      clearTimeout(timeout);
      gatewayText = await payRes.text(); // Always read as text first
    } catch (fetchErr) {
      return res.status(502).json({ error: 'Gagal menghubungi gateway pembayaran: ' + fetchErr.message });
    }

    console.log('Gateway raw response (first 300):', gatewayText.slice(0, 300));

    const parsed = parseGatewayResponse(gatewayText);
    if (parsed.error) return res.status(502).json({ error: parsed.error });

    const { txnId, qrImage } = parsed;

    // Save order
    const { error: oErr } = await db.from('orders').insert({
      txn_id:         txnId,
      product_id:     prod.id,
      product_name:   prod.name,
      category:       prod.category,
      email:          email.toLowerCase().trim(),
      whatsapp:       whatsapp.trim(),
      duration,
      duration_label: DURATION_LABELS[duration] || duration,
      quantity:       qty,
      total,
      status: 'pending',
    });

    if (oErr) {
      console.error('Order insert error:', oErr);
      // If order save fails, still return QR so user can pay
      // (order might be a duplicate if they retry)
      if (!oErr.code?.includes('duplicate') && !oErr.message?.includes('duplicate')) {
        return res.status(500).json({ error: 'Gagal menyimpan pesanan: ' + oErr.message });
      }
    }

    return res.status(200).json({ txn_id: txnId, qr_image: qrImage, total });
  } catch (err) {
    console.error('Payment error:', err);
    return res.status(500).json({ error: err.message || 'Internal server error' });
  }
  }
