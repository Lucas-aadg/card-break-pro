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

// Look up org_id and owner profile_id from a stripe_subscription_id or stripe_customer_id.
// Used by notification-generating events.
async function getOrgAndOwner(sb, { subscriptionId, customerId }) {
  const query = sb.from('subscriptions').select('org_id');
  if (subscriptionId) query.eq('stripe_subscription_id', subscriptionId);
  else if (customerId) query.eq('stripe_customer_id', customerId);

  const { data: subRecord } = await query.maybeSingle();
  if (!subRecord?.org_id) return { orgId: null, ownerId: null };

  const { data: owner } = await sb
    .from('profiles')
    .select('id')
    .eq('org_id', subRecord.org_id)
    .eq('role', 'owner')
    .maybeSingle();

  return { orgId: subRecord.org_id, ownerId: owner?.id ?? null };
}

// Maps tier name to seat limits stored in subscriptions table
const TIER_LIMITS = {
  starter: { max_breakers: 3,    max_sorters: 2, max_managers: 1 },
  pro:     { max_breakers: 8,    max_sorters: 4, max_managers: 2 },
  empire:  { max_breakers: null, max_sorters: null, max_managers: null },
  legacy:  { max_breakers: null, max_sorters: null, max_managers: null }
};

// Maps Stripe Price IDs to tier names for plan-change events
const PRICE_TIER_MAP = {
  [process.env.STRIPE_PRICE_ID_STARTER]: 'starter',
  [process.env.STRIPE_PRICE_ID_PRO]:     'pro',
  [process.env.STRIPE_PRICE_ID_EMPIRE]:  'empire'
};

module.exports = async (req, res) => {
  const sig = req.headers['stripe-signature'];
  let event;

  // ── Signature verification — rejects all unsigned/tampered requests ──
  try {
    const rawBody = await getRawBody(req);
    event = stripe.webhooks.constructEvent(rawBody, sig, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    console.error('Webhook signature error:', err.message);
    return res.status(400).json({ error: 'Webhook signature verification failed: ' + err.message });
  }

  const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY);

  const getMetadata = (obj) => ({
    userId: obj.metadata?.user_id,
    orgId: obj.metadata?.org_id
  });

  try {
    switch (event.type) {

      // ── Original 4 events ──────────────────────────────────────────────

      case 'checkout.session.completed': {
        const session = event.data.object;
        const { userId, orgId } = getMetadata(session);
        if (!orgId) break;
        const tier = session.metadata?.tier || 'starter';
        const limits = TIER_LIMITS[tier] || TIER_LIMITS.starter;
        const { error } = await sb.from('subscriptions').upsert({
          org_id: orgId,
          user_id: userId,
          stripe_customer_id: session.customer,
          stripe_subscription_id: session.subscription,
          status: 'active',
          tier,
          max_breakers:  limits.max_breakers,
          max_sorters:   limits.max_sorters,
          max_managers:  limits.max_managers,
          updated_at: new Date().toISOString()
        }, { onConflict: 'org_id' });
        if (error) console.error('Supabase upsert error (checkout.session.completed):', error);
        break;
      }

      case 'customer.subscription.updated': {
        const sub = event.data.object;
        const status = sub.status === 'trialing' ? 'active' : sub.status;
        const updateFields = { status, updated_at: new Date().toISOString() };
        // Detect plan change via portal (price switched) and update tier + limits
        const priceId = sub.items?.data?.[0]?.price?.id;
        const newTier = PRICE_TIER_MAP[priceId];
        if (newTier) {
          const limits = TIER_LIMITS[newTier] || {};
          updateFields.tier = newTier;
          updateFields.max_breakers = limits.max_breakers !== undefined ? limits.max_breakers : null;
          updateFields.max_sorters  = limits.max_sorters  !== undefined ? limits.max_sorters  : null;
          updateFields.max_managers = limits.max_managers !== undefined ? limits.max_managers : null;
        }
        const { error } = await sb.from('subscriptions')
          .update(updateFields)
          .eq('stripe_subscription_id', sub.id);
        if (error) console.error('Supabase update error (customer.subscription.updated):', error);
        break;
      }

      case 'customer.subscription.deleted': {
        const sub = event.data.object;
        const { error } = await sb.from('subscriptions')
          .update({ status: 'cancelled', updated_at: new Date().toISOString() })
          .eq('stripe_subscription_id', sub.id);
        if (error) console.error('Supabase update error (customer.subscription.deleted):', error);
        break;
      }

      case 'invoice.payment_failed': {
        const invoice = event.data.object;
        const { error } = await sb.from('subscriptions')
          .update({ status: 'past_due', updated_at: new Date().toISOString() })
          .eq('stripe_customer_id', invoice.customer);
        if (error) console.error('Supabase update error (invoice.payment_failed):', error);
        break;
      }

      // ── 5 New events ───────────────────────────────────────────────────

      case 'customer.subscription.created': {
        // Fires when a subscription object is first created.
        // checkout.session.completed handles initial DB creation with org metadata.
        // This event provides a safety net to update status if checkout event was missed.
        const sub = event.data.object;
        const status = sub.status === 'trialing' ? 'active' : sub.status;
        const { error } = await sb.from('subscriptions')
          .update({
            stripe_subscription_id: sub.id,
            status,
            updated_at: new Date().toISOString()
          })
          .eq('stripe_customer_id', sub.customer);
        if (error) console.error('Supabase update error (customer.subscription.created):', error);
        break;
      }

      case 'invoice.payment_succeeded': {
        // Fires when any invoice pays successfully.
        // Critical for recovering from past_due state when a failed payment is retried.
        const invoice = event.data.object;
        if (!invoice.subscription) break;
        const { error } = await sb.from('subscriptions')
          .update({ status: 'active', updated_at: new Date().toISOString() })
          .eq('stripe_subscription_id', invoice.subscription);
        if (error) console.error('Supabase update error (invoice.payment_succeeded):', error);
        break;
      }

      case 'customer.subscription.trial_will_end': {
        // Fires 3 days before the trial period ends.
        // Creates an in-app notification for the org owner.
        const sub = event.data.object;
        const { orgId, ownerId } = await getOrgAndOwner(sb, { subscriptionId: sub.id });
        if (orgId && ownerId) {
          const { error } = await sb.from('notifications').insert({
            org_id: orgId,
            profile_id: ownerId,
            title: 'Trial Ending in 3 Days',
            message: 'Your free trial ends in 3 days. Visit Billing to add a payment method and keep your dashboard access.',
            read: false
          });
          if (error) console.error('Supabase insert error (trial_will_end notification):', error);
        }
        break;
      }

      case 'invoice.upcoming': {
        // Fires approximately 7 days before a renewal charge.
        // Creates an in-app billing reminder for the org owner.
        const invoice = event.data.object;
        if (!invoice.subscription) break;
        const { orgId, ownerId } = await getOrgAndOwner(sb, { subscriptionId: invoice.subscription });
        if (orgId && ownerId) {
          const amount = invoice.amount_due ? '$' + (invoice.amount_due / 100).toFixed(2) : '$250.00';
          const { error } = await sb.from('notifications').insert({
            org_id: orgId,
            profile_id: ownerId,
            title: 'Upcoming Renewal',
            message: `Your Card Break Pro subscription renews in ~7 days for ${amount}. Manage your billing at cardbreakpro.com/billing.`,
            read: false
          });
          if (error) console.error('Supabase insert error (invoice.upcoming notification):', error);
        }
        break;
      }

      case 'payment_intent.payment_failed': {
        // Fires when a PaymentIntent fails — complements invoice.payment_failed.
        // Only acts on subscription-linked failures (those attached to an invoice).
        const pi = event.data.object;
        if (!pi.customer || !pi.invoice) break;
        const { error } = await sb.from('subscriptions')
          .update({ status: 'past_due', updated_at: new Date().toISOString() })
          .eq('stripe_customer_id', pi.customer);
        if (error) console.error('Supabase update error (payment_intent.payment_failed):', error);
        break;
      }

      default:
        console.log('Unhandled event type:', event.type);
    }

    res.status(200).json({ received: true });
  } catch (err) {
    console.error('Webhook handler error:', err);
    res.status(500).json({ error: err.message });
  }
};
