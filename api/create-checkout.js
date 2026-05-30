const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);

const PRICE_IDS = {
  starter:        process.env.STRIPE_PRICE_ID_STARTER || 'price_1TcA00AQv5DHthFTUHf8QFvL',
  pro:            process.env.STRIPE_PRICE_ID_PRO,
  empire:         process.env.STRIPE_PRICE_ID_EMPIRE,
  starter_annual: process.env.STRIPE_PRICE_ID_STARTER_ANNUAL,
  pro_annual:     process.env.STRIPE_PRICE_ID_PRO_ANNUAL,
  empire_annual:  process.env.STRIPE_PRICE_ID_EMPIRE_ANNUAL
};

// Trial days for monthly plans only. Annual plans have no trial — paid upfront.
const TRIAL_DAYS = { starter: 14, pro: 7 };

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.status(200).end(); return; }
  if (req.method !== 'POST') { res.status(405).json({ error: 'Method not allowed' }); return; }

  try {
    const { userId, email, orgId, tier = 'starter', billingCycle = 'monthly', trialDaysOverride } = req.body;
    if (!userId || !email || !orgId) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    const priceLookupKey = billingCycle === 'annual' ? tier + '_annual' : tier;
    const priceId = PRICE_IDS[priceLookupKey];
    if (!priceId) {
      return res.status(400).json({ error: 'Invalid plan or billing cycle: ' + priceLookupKey });
    }

    const baseTrial = TRIAL_DAYS[tier] || 0;
    // Annual plans: no trial. Monthly: use override (from referral) or base.
    const trialDays = billingCycle === 'annual' ? 0 : (trialDaysOverride || baseTrial);
    const appUrl = process.env.APP_URL || 'https://cardbreakpro.com';

    const sessionParams = {
      mode: 'subscription',
      payment_method_types: ['card'],
      customer_email: email,
      line_items: [{ price: priceId, quantity: 1 }],
      metadata: { user_id: userId, org_id: orgId, tier, billing_cycle: billingCycle },
      subscription_data: { metadata: { tier, billing_cycle: billingCycle } },
      success_url: appUrl + '/dashboard?subscribed=true',
      cancel_url:  appUrl + '/register?cancelled=true'
    };

    if (trialDays > 0) sessionParams.subscription_data.trial_period_days = trialDays;

    const session = await stripe.checkout.sessions.create(sessionParams);
    res.status(200).json({ url: session.url });
  } catch (err) {
    console.error('create-checkout error:', err);
    res.status(500).json({ error: err.message });
  }
};
