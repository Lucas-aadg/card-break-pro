// Runs daily at 9am — fires re-engagement notifications for top buyers who just went cold
const { createClient } = require('@supabase/supabase-js');
const APP_URL = process.env.APP_URL || 'https://cardbreakpro.com';

module.exports = async (req, res) => {
  const sb = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY
  );

  // Find buyers who crossed the cold threshold exactly today:
  // last_purchase_date was 20 days ago → they become cold today
  const twentyOneDaysAgo = new Date();
  twentyOneDaysAgo.setDate(twentyOneDaysAgo.getDate() - 21);
  const coldDate = twentyOneDaysAgo.toISOString().split('T')[0];

  const { data: coldBuyers, error } = await sb.from('buyers')
    .select('id, organization_id, username, total_spent, last_purchase_date')
    .eq('last_purchase_date', coldDate);

  if (error) {
    console.error('cron-buyer-alerts fetch error:', error);
    return res.status(500).json({ error: error.message });
  }

  if (!coldBuyers || coldBuyers.length === 0) {
    return res.status(200).json({ fired: 0 });
  }

  let fired = 0;

  // Group by org
  const byOrg = {};
  for (const buyer of coldBuyers) {
    if (!byOrg[buyer.organization_id]) byOrg[buyer.organization_id] = [];
    byOrg[buyer.organization_id].push(buyer);
  }

  for (const [orgId, buyers] of Object.entries(byOrg)) {
    try {
      // Check org is not exempt
      const { data: sub } = await sb.from('subscriptions').select('tier').eq('org_id', orgId).maybeSingle();
      if (sub?.tier === 'exempt') continue;

      // Get org's top 20 buyers by total_spent to filter notifications
      const { data: top20 } = await sb.from('buyers')
        .select('id')
        .eq('organization_id', orgId)
        .order('total_spent', { ascending: false })
        .limit(20);
      const top20Ids = new Set((top20 || []).map(b => b.id));

      // Get owner's profile id
      const { data: owner } = await sb.from('profiles')
        .select('id')
        .eq('org_id', orgId)
        .eq('role', 'owner')
        .maybeSingle();
      if (!owner) continue;

      for (const buyer of buyers) {
        if (!top20Ids.has(buyer.id)) continue;

        const spent = parseFloat(buyer.total_spent || 0).toLocaleString('en-US', { style: 'currency', currency: 'USD' });

        await sb.from('notifications').insert({
          organization_id: orgId,
          user_id: owner.id,
          type: 'buyer_cold',
          title: 'A top buyer went cold',
          body: `@${buyer.username} hasn't purchased in over 20 days. They previously spent ${spent} with you.`,
          action_url: APP_URL + '/dashboard'
        }).catch(e => console.error('buyer alert notif insert:', e.message));

        fired++;
      }
    } catch (e) {
      console.error('cron-buyer-alerts org error for', orgId, e);
    }
  }

  return res.status(200).json({ fired });
};
