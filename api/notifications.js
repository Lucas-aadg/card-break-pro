// CardBreakPro — Notifications REST API
// GET  /api/notifications?limit=30&offset=0   → list user's notifications
// POST /api/notifications  body: { action:'mark_read', id } or { action:'mark_all_read' }

const { createClient } = require('@supabase/supabase-js');

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const authHeader = req.headers.authorization || '';
  const token = authHeader.replace('Bearer ', '');
  if (!token) return res.status(401).json({ error: 'Missing auth token' });

  // User-scoped client (respects RLS)
  const sb = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_ANON_KEY,
    { global: { headers: { Authorization: 'Bearer ' + token } } }
  );

  // Verify the user
  const { data: { user }, error: authErr } = await sb.auth.getUser();
  if (authErr || !user) return res.status(401).json({ error: 'Invalid token' });

  if (req.method === 'GET') {
    const limit  = Math.min(parseInt(req.query.limit  || '30', 10), 100);
    const offset = parseInt(req.query.offset || '0', 10);

    const { data, error, count } = await sb
      .from('notifications')
      .select('*', { count: 'exact' })
      .eq('user_id', user.id)
      .order('created_at', { ascending: false })
      .range(offset, offset + limit - 1);

    if (error) return res.status(500).json({ error: error.message });
    return res.status(200).json({ notifications: data || [], total: count || 0 });
  }

  if (req.method === 'POST') {
    const body = req.body || {};
    const { action, id } = body;

    if (action === 'mark_read' && id) {
      const { error } = await sb
        .from('notifications')
        .update({ is_read: true })
        .eq('id', id)
        .eq('user_id', user.id);
      if (error) return res.status(500).json({ error: error.message });
      return res.status(200).json({ ok: true });
    }

    if (action === 'mark_all_read') {
      const { error } = await sb
        .from('notifications')
        .update({ is_read: true })
        .eq('user_id', user.id)
        .eq('is_read', false);
      if (error) return res.status(500).json({ error: error.message });
      return res.status(200).json({ ok: true });
    }

    return res.status(400).json({ error: 'Unknown action' });
  }

  return res.status(405).json({ error: 'Method not allowed' });
};
