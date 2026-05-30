// Called from register.html after account + org creation succeeds with a valid referral code.
// Creates the referral_uses record and increments times_used on the referral code.
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
    const { code, referredOrgId } = req.body;
    if (!code || !referredOrgId) return res.status(400).json({ error: 'code and referredOrgId are required' });

    const upperCode = code.trim().toUpperCase();

    const { data: refCode, error: codeErr } = await sb
      .from('referral_codes')
      .select('id, organization_id, times_used')
      .eq('code', upperCode)
      .maybeSingle();

    if (codeErr) throw codeErr;
    if (!refCode) return res.status(400).json({ error: 'Referral code not found' });

    // Duplicate use prevention: one org can only use a code once
    const { data: existing } = await sb.from('referral_uses')
      .select('id').eq('referral_code_id', refCode.id)
      .eq('referred_organization_id', referredOrgId).maybeSingle();

    if (existing) return res.status(200).json({ ok: true, note: 'already recorded' });

    // Self-referral prevention at org level
    if (refCode.organization_id === referredOrgId) {
      return res.status(400).json({ error: 'Self-referral not allowed' });
    }

    await sb.from('referral_uses').insert({
      referral_code_id:         refCode.id,
      referred_organization_id: referredOrgId,
      status:                   'pending',
      referred_trial_extended:  true
    });

    await sb.from('referral_codes').update({
      times_used: (refCode.times_used || 0) + 1
    }).eq('id', refCode.id);

    return res.status(200).json({ ok: true });
  } catch (err) {
    console.error('record-referral-use error:', err);
    res.status(500).json({ error: err.message });
  }
};
