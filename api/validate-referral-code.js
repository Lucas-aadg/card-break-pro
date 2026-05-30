// Validates a referral code before registration completes.
// Handles: not found, self-referral, duplicate use.
const { createClient } = require('@supabase/supabase-js');

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.status(200).end(); return; }
  if (req.method !== 'POST') { res.status(405).json({ error: 'Method not allowed' }); return; }

  const sb = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY
  );

  try {
    const { code, email } = req.body;
    if (!code) return res.status(400).json({ error: 'code is required' });

    const upperCode = code.trim().toUpperCase();

    // Find the referral code record
    const { data: refCode, error: codeErr } = await sb
      .from('referral_codes')
      .select('id, organization_id')
      .eq('code', upperCode)
      .maybeSingle();

    if (codeErr) throw codeErr;
    if (!refCode) return res.status(200).json({ valid: false, reason: 'not_found' });

    // Self-referral check: compare email against referrer org owner's email
    if (email) {
      const { data: referrerProfile } = await sb.from('profiles')
        .select('id').eq('org_id', refCode.organization_id).eq('role', 'owner').maybeSingle();

      if (referrerProfile) {
        const { data: authUser } = await sb.auth.admin.getUserById(referrerProfile.id);
        const referrerEmail = authUser?.user?.email || '';
        if (referrerEmail.toLowerCase() === email.trim().toLowerCase()) {
          return res.status(200).json({ valid: false, reason: 'self_referral' });
        }
      }
    }

    return res.status(200).json({ valid: true, code: upperCode });
  } catch (err) {
    console.error('validate-referral-code error:', err);
    res.status(500).json({ error: err.message });
  }
};
