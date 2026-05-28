const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);

const PRICE_IDS = {
  starter: process.env.STRIPE_PRICE_ID_STARTER || 'price_1TcA00AQv5DHthFTUHf8QFvL',
  pro:     process.env.STRIPE_PRICE_ID_PRO,
  empire:  process.env.STRIPE_PRICE_ID_EMPIRE
};

// Trial days per tier — empire has no trial (handled as demo/sales call)
const TRIAL_DAYS = { starter: 14, pro: 7 };

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.status(200).end(); return; }
  if (req.method !== 'POST') { res.status(405).json({ error: 'Method not allowed' }); return; }

  try {
    const { userId, email, orgId, tier = 'starter' } = req.body;
    if (!userId || !email || !orgId) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    const priceId = PRICE_IDS[tier];
    if (!priceId) {
      return res.status(400).json({ error: 'Invalid plan: ' + tier });
    }

    const trialDays = TRIAL_DAYS[tier] || 0;
    const appUrl = process.env.APP_URL || 'https://cardbreakpro.com';

    const sessionParams = {
      mode: 'subscription',
      payment_method_types: ['card'],
      customer_email: email,
      line_items: [{ price: priceId, quantity: 1 }],
      metadata: { user_id: userId, org_id: orgId, tier },
      subscription_data: { metadata: { tier } },
      success_url: appUrl + '/dashboard?subscribed=true',
      cancel_url: appUrl + '/register?cancelled=true'
    };

    if (trialDays > 0) sessionParams.subscription_data.trial_period_days = trialDays;

    const session = await stripe.checkout.sessions.create(sessionParams);
    res.status(200).json({ url: session.url });
  } catch (err) {
    console.error('create-checkout error:', err);
    res.status(500).json({ error: err.message });
  }
};
