import { createClient } from '@supabase/supabase-js';

const sb = () => createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
const adminCheck = req => (req.headers['x-admin-key'] || '') === process.env.ADMIN_PASSWORD;

function cors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-admin-key');
  res.setHeader('Content-Type', 'application/json');
}

export default async function handler(req, res) {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();

  const db = sb();

  // GET — public: latest active; admin: all history
  if (req.method === 'GET') {
    const isAdmin = adminCheck(req);

    if (isAdmin) {
      // Return full history for admin panel
      const { data, error } = await db
        .from('broadcasts')
        .select('id, message, active, created_at')
        .order('created_at', { ascending: false })
        .limit(50);
      if (error) return res.status(500).json({ error: error.message });
      return res.status(200).json({ history: data || [] });
    }

    // Public: only the latest active broadcast
    const { data, error } = await db
      .from('broadcasts')
      .select('id, message, created_at')
      .eq('active', true)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    if (error) return res.status(500).json({ error: error.message });
    if (!data) return res.status(204).end();
    return res.status(200).json(data);
  }

  // Admin-only beyond this point
  if (!adminCheck(req)) return res.status(401).json({ error: 'Unauthorized' });

  // POST — create new broadcast
  if (req.method === 'POST') {
    const { message } = req.body || {};
    if (!message?.trim()) return res.status(400).json({ error: 'Pesan tidak boleh kosong' });

    // Deactivate all previous broadcasts
    await db.from('broadcasts').update({ active: false }).eq('active', true);

    const { data, error } = await db
      .from('broadcasts')
      .insert({ message: message.trim(), active: true })
      .select()
      .single();

    if (error) return res.status(500).json({ error: error.message });
    return res.status(201).json(data);
  }

  // DELETE — remove a broadcast by id, or deactivate
  if (req.method === 'DELETE') {
    const { id, deactivate } = req.body || {};
    if (!id) return res.status(400).json({ error: 'ID diperlukan' });

    if (deactivate) {
      const { error } = await db.from('broadcasts').update({ active: false }).eq('id', id);
      if (error) return res.status(500).json({ error: error.message });
    } else {
      const { error } = await db.from('broadcasts').delete().eq('id', id);
      if (error) return res.status(500).json({ error: error.message });
    }
    return res.status(200).json({ success: true });
  }

  return res.status(405).json({ error: 'Method not allowed' });
                                            }
