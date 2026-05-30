// Returns (or creates) the referral code for the authenticated owner's organization.
const { createClient } = require('@supabase/supabase-js');

// 8-char alphanumeric uppercase — no O/0/I/1 to avoid confusion
function generateCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < 8; i++) code += chars[Math.floor(Math.random() * chars.length)];
  return code;
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') { res.status(200).end(); return; }
  if (req.method !== 'GET') { res.status(405).json({ error: 'Method not allowed' }); return; }

  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith('Bearer ')) return res.status(401).json({ error: 'Missing auth token' });
  const token = authHeader.slice(7);

  const sb = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY
  );

  try {
    const { data: { user }, error: authErr } = await sb.auth.getUser(token);
    if (authErr || !user) return res.status(401).json({ error: 'Invalid token' });

    const { data: profile } = await sb.from('profiles').select('org_id, role').eq('id', user.id).single();
    if (!profile || profile.role !== 'owner') return res.status(403).json({ error: 'Not an owner' });

    // Return existing code if already generated
    const { data: existing } = await sb.from('referral_codes')
      .select('*').eq('organization_id', profile.org_id).maybeSingle();
    if (existing) return res.status(200).json({ code: existing });

    // Generate unique code (retry up to 10 times on collision)
    let code;
    for (let i = 0; i < 10; i++) {
      code = generateCode();
      const { data: conflict } = await sb.from('referral_codes').select('id').eq('code', code).maybeSingle();
      if (!conflict) break;
    }

    const { data: newCode, error: insertErr } = await sb.from('referral_codes').insert({
      organization_id: profile.org_id,
      code
    }).select('*').single();

    if (insertErr) throw insertErr;
    return res.status(200).json({ code: newCode });
  } catch (err) {
    console.error('generate-referral-code error:', err);
    res.status(500).json({ error: err.message });
  }
};
