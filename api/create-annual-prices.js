// One-time setup endpoint — creates annual Stripe prices for all three tiers.
// Call once: GET /api/create-annual-prices?secret=YOUR_SETUP_SECRET
// After running, add the returned price IDs as Vercel env vars:
//   STRIPE_PRICE_ID_STARTER_ANNUAL
//   STRIPE_PRICE_ID_PRO_ANNUAL
//   STRIPE_PRICE_ID_EMPIRE_ANNUAL
// Then delete or disable this endpoint.

const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);

module.exports = async (req, res) => {
  if (req.method !== 'GET') return res.status(405).end();

  const secret = process.env.SETUP_SECRET;
  if (!secret || req.query.secret !== secret) {
    return res.status(401).json({ error: 'Unauthorized — set SETUP_SECRET env var and pass ?secret=...' });
  }

  try {
    const created = [];

    // Starter Annual — $990.00/year (10 months × $99/mo)
    const starterProd = await stripe.products.create({
      name: 'CardBreakPro Starter — Annual',
      description: 'Starter plan, billed annually. Save $198/year vs monthly. 2 months free.'
    });
    const starterPrice = await stripe.prices.create({
      product: starterProd.id,
      unit_amount: 99000,
      currency: 'usd',
      recurring: { interval: 'year' },
      nickname: 'Starter Annual'
    });
    created.push({
      tier: 'starter_annual',
      env_var: 'STRIPE_PRICE_ID_STARTER_ANNUAL',
      price_id: starterPrice.id,
      amount: '$990.00/year',
      per_month: '$82.50/mo',
      saves: '$198/year'
    });

    // Pro Annual — $3,999.90/year (10 months × $399.99/mo)
    const proProd = await stripe.products.create({
      name: 'CardBreakPro Pro — Annual',
      description: 'Pro plan, billed annually. Save $799.98/year vs monthly. 2 months free.'
    });
    const proPrice = await stripe.prices.create({
      product: proProd.id,
      unit_amount: 399990,
      currency: 'usd',
      recurring: { interval: 'year' },
      nickname: 'Pro Annual'
    });
    created.push({
      tier: 'pro_annual',
      env_var: 'STRIPE_PRICE_ID_PRO_ANNUAL',
      price_id: proPrice.id,
      amount: '$3,999.90/year',
      per_month: '$333.33/mo',
      saves: '$799.98/year'
    });

    // Empire Annual — $9,999.90/year (10 months × $999.99/mo)
    // Note: Empire still requires Book a Demo — no self-serve checkout.
    // This price is available for manual assignment after a demo call.
    const empireProd = await stripe.products.create({
      name: 'CardBreakPro Empire — Annual',
      description: 'Empire plan, billed annually. Save $1,999.98/year vs monthly. 2 months free. Requires demo.'
    });
    const empirePrice = await stripe.prices.create({
      product: empireProd.id,
      unit_amount: 999990,
      currency: 'usd',
      recurring: { interval: 'year' },
      nickname: 'Empire Annual'
    });
    created.push({
      tier: 'empire_annual',
      env_var: 'STRIPE_PRICE_ID_EMPIRE_ANNUAL',
      price_id: empirePrice.id,
      amount: '$9,999.90/year',
      per_month: '$833.33/mo',
      saves: '$1,999.98/year'
    });

    return res.status(200).json({
      message: 'Annual prices created successfully. Add these Vercel env vars, then redeploy:',
      env_vars_to_add: created.map(p => p.env_var + '=' + p.price_id),
      details: created
    });
  } catch (err) {
    console.error('create-annual-prices error:', err);
    return res.status(500).json({ error: err.message });
  }
};
