const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const { createClient } = require('@supabase/supabase-js');

// Disable body parsing so we get the raw body for Stripe signature verification
module.exports.config = {
  api: {
    bodyParser: false
  }
};

function getRawBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

module.exports = async (req, res) => {
  const sig = req.headers['stripe-signature'];
  let event;

  try {
    const rawBody = await getRawBody(req);
    event = stripe.webhooks.constructEvent(rawBody, sig, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    console.error('Webhook signature error:', err.message);
    return res.status(400).json({ error: 'Webhook signature verification failed: ' + err.message });
  }

  const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

  const getMetadata = (obj) => ({
    userId: obj.metadata?.user_id,
    orgId: obj.metadata?.org_id
  });

  try {
    switch (event.type) {
      case 'checkout.session.completed': {
        const session = event.data.object;
        const { userId, orgId } = getMetadata(session);
        if (!orgId) break;
        const { error } = await sb.from('subscriptions').upsert({
          org_id: orgId,
          user_id: userId,
          stripe_customer_id: session.customer,
          stripe_subscription_id: session.subscription,
          status: 'active',
          updated_at: new Date().toISOString()
        }, { onConflict: 'org_id' });
        if (error) console.error('Supabase upsert error:', error);
        break;
      }
      case 'customer.subscription.updated': {
        const sub = event.data.object;
        await sb.from('subscriptions')
          .update({ status: sub.status, updated_at: new Date().toISOString() })
          .eq('stripe_subscription_id', sub.id);
        break;
      }
      case 'customer.subscription.deleted': {
        const sub = event.data.object;
        await sb.from('subscriptions')
          .update({ status: 'cancelled', updated_at: new Date().toISOString() })
          .eq('stripe_subscription_id', sub.id);
        break;
      }
      case 'invoice.payment_failed': {
        const invoice = event.data.object;
        await sb.from('subscriptions')
          .update({ status: 'past_due', updated_at: new Date().toISOString() })
          .eq('stripe_customer_id', invoice.customer);
        break;
      }
    }
    res.status(200).json({ received: true });
  } catch (err) {
    console.error('Webhook handler error:', err);
    res.status(500).json({ error: err.message });
  }
};
