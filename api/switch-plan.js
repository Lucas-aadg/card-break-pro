// CardBreakPro — Switch subscription tier (upgrade or downgrade)
// POST /api/switch-plan  body: { targetTier, confirm }
//   confirm:false → preview (returns charge_today, renewal_date)
//   confirm:true  → executes the switch

const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const { createClient } = require('@supabase/supabase-js');

const MONTHLY_PRICE_IDS = {
  starter: process.env.STRIPE_PRICE_ID_STARTER || 'price_1TcA00AQv5DHthFTUHf8QFvL',
  pro:     process.env.STRIPE_PRICE_ID_PRO,
  empire:  process.env.STRIPE_PRICE_ID_EMPIRE
};

const ANNUAL_PRICE_IDS = {
  starter: process.env.STRIPE_PRICE_ID_STARTER_ANNUAL,
  pro:     process.env.STRIPE_PRICE_ID_PRO_ANNUAL,
  empire:  process.env.STRIPE_PRICE_ID_EMPIRE_ANNUAL
};

const TIER_ORDER  = { starter: 1, pro: 2, empire: 3 };

const TIER_LIMITS = {
  starter: { max_breakers: 3,    max_sorters: 2,    max_managers: 1 },
  pro:     { max_breakers: 8,    max_sorters: 4,    max_managers: 2 },
  empire:  { max_breakers: null, max_sorters: null, max_managers: null }
};

const TIER_DISPLAY = {
  starter: { monthly: '$129.99/mo', annual: '$1,299.90/yr' },
  pro:     { monthly: '$399.99/mo', annual: '$3,999.90/yr' },
  empire:  { monthly: '$999.99/mo', annual: '$9,999.90/yr' }
};

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') { res.status(200).end(); return; }
  if (req.method !== 'POST') { res.status(405).json({ error: 'Method not allowed' }); return; }

  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Missing auth token' });
  }
  const token = authHeader.slice(7);

  const sb = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY
  );

  try {
    const { data: { user }, error: authErr } = await sb.auth.getUser(token);
    if (authErr || !user) return res.status(401).json({ error: 'Invalid token' });

    const { data: profile } = await sb.from('profiles')
      .select('org_id, role').eq('id', user.id).single();
    if (!profile || profile.role !== 'owner') {
      return res.status(403).json({ error: 'Owner access only' });
    }

    const { data: sub } = await sb.from('subscriptions')
      .select('stripe_subscription_id, tier, billing_cycle, status, stripe_customer_id')
      .eq('org_id', profile.org_id).single();

    if (!sub || !sub.stripe_subscription_id) {
      return res.status(400).json({ error: 'No active subscription found' });
    }
    if (sub.status !== 'active') {
      return res.status(400).json({ error: 'Subscription must be active to change plans' });
    }
    if (['exempt', 'legacy'].includes(sub.tier)) {
      return res.status(400).json({ error: 'Plan changes are not available on this account. Contact support.' });
    }

    const { targetTier, confirm } = req.body || {};
    if (!targetTier || !['starter', 'pro'].includes(targetTier)) {
      return res.status(400).json({ error: 'Invalid target tier. Self-serve supports starter and pro.' });
    }
    if (targetTier === sub.tier) {
      return res.status(400).json({ error: 'Already on this plan' });
    }

    const currentCycle = sub.billing_cycle || 'monthly';
    const priceIdMap = currentCycle === 'annual' ? ANNUAL_PRICE_IDS : MONTHLY_PRICE_IDS;
    const newPriceId = priceIdMap[targetTier];
    if (!newPriceId) {
      return res.status(400).json({ error: 'Price not configured for ' + targetTier + '. Contact support.' });
    }

    const isUpgrade = (TIER_ORDER[targetTier] || 0) > (TIER_ORDER[sub.tier] || 0);
    const stripeSub = await stripe.subscriptions.retrieve(sub.stripe_subscription_id);

    // Use Stripe's upcoming invoice for accurate proration preview
    let chargeToday = 0;
    if (isUpgrade) {
      try {
        const upcoming = await stripe.invoices.retrieveUpcoming({
          customer: stripeSub.customer,
          subscription: sub.stripe_subscription_id,
          subscription_items: [{ id: stripeSub.items.data[0].id, price: newPriceId }],
          subscription_proration_behavior: 'create_prorations'
        });
        chargeToday = Math.max(0, upcoming.amount_due);
      } catch (e) {
        console.error('Upcoming invoice error:', e.message);
      }
    }

    const renewalDate = new Date(stripeSub.current_period_end * 1000).toISOString().split('T')[0];

    if (!confirm) {
      return res.status(200).json({
        preview:          true,
        currentTier:      sub.tier,
        targetTier,
        isUpgrade,
        billing_cycle:    currentCycle,
        new_price_label:  TIER_DISPLAY[targetTier]?.[currentCycle] || '',
        charge_today:     chargeToday,
        renewal_date:     renewalDate
      });
    }

    // Execute the plan switch
    await stripe.subscriptions.update(sub.stripe_subscription_id, {
      items: [{ id: stripeSub.items.data[0].id, price: newPriceId }],
      proration_behavior: isUpgrade ? 'create_prorations' : 'none'
    });

    const limits = TIER_LIMITS[targetTier] || {};
    await sb.from('subscriptions').update({
      tier:         targetTier,
      max_breakers: limits.max_breakers !== undefined ? limits.max_breakers : null,
      max_sorters:  limits.max_sorters  !== undefined ? limits.max_sorters  : null,
      max_managers: limits.max_managers !== undefined ? limits.max_managers : null,
      updated_at:   new Date().toISOString()
    }).eq('org_id', profile.org_id);

    return res.status(200).json({
      success:      true,
      targetTier,
      isUpgrade,
      charge_today: chargeToday,
      renewal_date: renewalDate
    });

  } catch (err) {
    console.error('switch-plan error:', err);
    return res.status(500).json({ error: err.message });
  }
};
