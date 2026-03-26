import { createClient } from '@supabase/supabase-js';

const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const { product_id, duration, quantity, email, whatsapp } = req.body;

    if (!product_id || !duration || !quantity || !email || !whatsapp) {
      return res.status(400).json({ error: 'Data tidak lengkap' });
    }

    const { data: product, error: pErr } = await sb
      .from('products')
      .select('*')
      .eq('id', product_id)
      .eq('active', true)
      .single();

    if (pErr || !product) return res.status(404).json({ error: 'Produk tidak ditemukan' });

    const price = product.prices[duration];
    if (!price) return res.status(400).json({ error: 'Durasi tidak valid' });

    const { count: stockCount } = await sb
      .from('account_pool')
      .select('id', { count: 'exact', head: true })
      .eq('product_id', product_id)
      .eq('used', false);

