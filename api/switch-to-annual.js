const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const { createClient } = require('@supabase/supabase-js');

const ANNUAL_PRICE_IDS = {
  starter: process.env.STRIPE_PRICE_ID_STARTER_ANNUAL,
  pro:     process.env.STRIPE_PRICE_ID_PRO_ANNUAL,
  empire:  process.env.STRIPE_PRICE_ID_EMPIRE_ANNUAL
};

// Monthly prices in cents for proration calculation
const MONTHLY_PRICES_CENTS = { starter: 12999, pro: 39999, empire: 99999 };
const ANNUAL_PRICES_CENTS  = { starter: 129990, pro: 399990, empire: 999990 };

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') { res.status(200).end(); return; }
  if (req.method !== 'POST') { res.status(405).json({ error: 'Method not allowed' }); return; }

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

    const { data: sub } = await sb.from('subscriptions')
      .select('stripe_subscription_id, tier, billing_cycle, status')
      .eq('org_id', profile.org_id).single();

    if (!sub || !sub.stripe_subscription_id) return res.status(400).json({ error: 'No active subscription found' });
    if (sub.billing_cycle === 'annual') return res.status(400).json({ error: 'Already on annual billing' });
    if (sub.status !== 'active') return res.status(400).json({ error: 'Subscription must be active to switch' });
    if (['exempt', 'legacy'].includes(sub.tier)) return res.status(400).json({ error: 'Billing cycle change not available for this plan' });

    const annualPriceId = ANNUAL_PRICE_IDS[sub.tier];
    if (!annualPriceId) return res.status(400).json({ error: 'Annual price not configured for this tier. Contact support.' });

    const { confirm } = req.body;

    // Fetch current Stripe subscription for proration
    const stripeSub = await stripe.subscriptions.retrieve(sub.stripe_subscription_id);
    const now = Math.floor(Date.now() / 1000);
    const remainingSeconds = Math.max(0, stripeSub.current_period_end - now);
    const remainingDays    = Math.floor(remainingSeconds / 86400);

    const prorationCredit = Math.min(
      Math.floor((remainingDays / 30) * MONTHLY_PRICES_CENTS[sub.tier]),
      ANNUAL_PRICES_CENTS[sub.tier]
    );
    const chargeToday = Math.max(0, ANNUAL_PRICES_CENTS[sub.tier] - prorationCredit);

    const renewalDate = new Date();
    renewalDate.setFullYear(renewalDate.getFullYear() + 1);
    const renewalDateStr = renewalDate.toISOString().split('T')[0];

    if (!confirm) {
      // Preview — return the numbers without making changes
      return res.status(200).json({
        preview:          true,
        tier:             sub.tier,
        annual_price:     ANNUAL_PRICES_CENTS[sub.tier],
        proration_credit: prorationCredit,
        charge_today:     chargeToday,
        remaining_days:   remainingDays,
        renewal_date:     renewalDateStr
      });
    }

    // Execute the switch
    await stripe.subscriptions.update(sub.stripe_subscription_id, {
      items: [{ id: stripeSub.items.data[0].id, price: annualPriceId }],
      proration_behavior: 'create_prorations',
      billing_cycle_anchor: 'now'
    });

    await sb.from('subscriptions').update({
      billing_cycle:       'annual',
      annual_renewal_date: renewalDateStr,
      updated_at:          new Date().toISOString()
    }).eq('org_id', profile.org_id);

    return res.status(200).json({ success: true, renewal_date: renewalDateStr, charge_today: chargeToday });
  } catch (err) {
    console.error('switch-to-annual error:', err);
    res.status(500).json({ error: err.message });
  }
};
