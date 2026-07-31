// Consolidated referral handler — dispatches by ?action=generate|validate|record
const { createClient } = require('@supabase/supabase-js');

function generateCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < 8; i++) code += chars[Math.floor(Math.random() * chars.length)];
  return code;
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') { res.status(200).end(); return; }

  const action = req.query.action;

  const sb = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY
  );

  // ── generate ──────────────────────────────────────────────────────────────
  if (action === 'generate') {
    if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
    const authHeader = req.headers.authorization;
    if (!authHeader?.startsWith('Bearer ')) return res.status(401).json({ error: 'Missing auth token' });
    const token = authHeader.slice(7);

    try {
      const { data: { user }, error: authErr } = await sb.auth.getUser(token);
      if (authErr || !user) return res.status(401).json({ error: 'Invalid token' });

      const { data: profile } = await sb.from('profiles').select('org_id, role').eq('id', user.id).single();
      if (!profile || profile.role !== 'owner') return res.status(403).json({ error: 'Not an owner' });

      const { data: existing } = await sb.from('referral_codes')
        .select('*').eq('organization_id', profile.org_id).maybeSingle();
      if (existing) return res.status(200).json({ code: existing });

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
      console.error('referral generate error:', err);
      return res.status(500).json({ error: err.message });
    }
  }

  // ── validate ──────────────────────────────────────────────────────────────
  if (action === 'validate') {
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

    try {
      const { code, email } = req.body;
      if (!code) return res.status(400).json({ error: 'code is required' });
      if (typeof code !== 'string' || code.trim().length > 20) return res.status(400).json({ error: 'Invalid code format' });

      const upperCode = code.trim().toUpperCase();

      const { data: refCode, error: codeErr } = await sb
        .from('referral_codes')
        .select('id, organization_id')
        .eq('code', upperCode)
        .maybeSingle();

      if (codeErr) throw codeErr;
      if (!refCode) return res.status(200).json({ valid: false, reason: 'not_found' });

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
      console.error('referral validate error:', err);
      return res.status(500).json({ error: err.message });
    }
  }

  // ── record ────────────────────────────────────────────────────────────────
  if (action === 'record') {
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

    try {
      const { code, referredOrgId } = req.body;
      if (!code || !referredOrgId) return res.status(400).json({ error: 'code and referredOrgId are required' });
      if (typeof code !== 'string' || code.trim().length > 20) return res.status(400).json({ error: 'Invalid code format' });
      // Validate referredOrgId is UUID-shaped before querying
      if (!/^[0-9a-f-]{36}$/.test(referredOrgId)) return res.status(400).json({ error: 'Invalid referredOrgId' });

      const upperCode = code.trim().toUpperCase();

      const { data: refCode, error: codeErr } = await sb
        .from('referral_codes')
        .select('id, organization_id, times_used')
        .eq('code', upperCode)
        .maybeSingle();

      if (codeErr) throw codeErr;
      if (!refCode) return res.status(400).json({ error: 'Referral code not found' });

      const { data: existingUse } = await sb.from('referral_uses')
        .select('id').eq('referral_code_id', refCode.id)
        .eq('referred_organization_id', referredOrgId).maybeSingle();

      if (existingUse) return res.status(200).json({ ok: true, note: 'already recorded' });

      if (refCode.organization_id === referredOrgId) {
        return res.status(400).json({ error: 'Self-referral not allowed' });
      }

      const { error: useErr } = await sb.from('referral_uses').insert({
        referral_code_id:         refCode.id,
        referred_organization_id: referredOrgId,
        status:                   'pending',
        referred_trial_extended:  true
      });
      // Must surface — if this row isn't written, the conversion webhook never
      // finds it and the referrer silently never gets their free month.
      if (useErr) return res.status(500).json({ error: 'Failed to record referral: ' + useErr.message });

      await sb.from('referral_codes').update({
        times_used: (refCode.times_used || 0) + 1
      }).eq('id', refCode.id);

      return res.status(200).json({ ok: true });
    } catch (err) {
      console.error('referral record error:', err);
      return res.status(500).json({ error: err.message });
    }
  }

  return res.status(400).json({ error: 'Invalid action. Use ?action=generate|validate|record' });
};
