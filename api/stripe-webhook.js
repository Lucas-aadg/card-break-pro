const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const { createClient } = require('@supabase/supabase-js');
const { sendEmail } = require('./send-email');
const APP_URL = process.env.APP_URL || 'https://cardbreakpro.com';

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

// Maps Stripe Price IDs to tier names for plan-change events.
// New Starter price ($129.99) is hardcoded so the webhook recognizes it
// even before the STRIPE_PRICE_ID_STARTER env var is updated in Vercel.
const PRICE_TIER_MAP = {
  [process.env.STRIPE_PRICE_ID_STARTER]: 'starter',
  'price_1TcA00AQv5DHthFTUHf8QFvL':      'starter',
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
        // Update subscription status
        const { error } = await sb.from('subscriptions')
          .update({ status: 'past_due', updated_at: new Date().toISOString() })
          .eq('stripe_customer_id', invoice.customer);
        if (error) console.error('Supabase update error (invoice.payment_failed):', error);

        // Notify owner (skip GasPackBreaks / exempt tier)
        const { orgId: pfOrgId, ownerId: pfOwnerId } = await getOrgAndOwner(sb, { customerId: invoice.customer });
        if (pfOrgId && pfOwnerId) {
          // Check if exempt
          const { data: pfSub } = await sb.from('subscriptions').select('tier').eq('org_id', pfOrgId).maybeSingle();
          if (pfSub?.tier !== 'exempt') {
            const billingUrl = APP_URL + '/billing';
            const notifTitle = 'Payment failed — action required';
            const notifBody  = 'Your last payment did not go through. You have a 3-day grace period before access is restricted. Update your payment method now to avoid interruption.';

            // Check prefs
            const { data: pfPrefs } = await sb.from('notification_preferences').select('*').eq('user_id', pfOwnerId).maybeSingle();
            if (pfPrefs?.notify_payment_failed !== false) {
              if (pfPrefs?.in_app_notifications_enabled !== false) {
                await sb.from('notifications').insert({
                  organization_id: pfOrgId,
                  user_id: pfOwnerId,
                  type: 'payment_failed',
                  title: notifTitle,
                  body: notifBody,
                  action_url: billingUrl
                }).catch(e => console.error('payment_failed notif insert error:', e.message));
              }
              if (pfPrefs?.email_notifications_enabled !== false) {
                const { data: authUser } = await sb.auth.admin.getUserById(pfOwnerId);
                const ownerEmail = authUser?.user?.email;
                if (ownerEmail) {
                  const { data: ownerProfile } = await sb.from('profiles').select('display_name').eq('id', pfOwnerId).maybeSingle();
                  const firstName = (ownerProfile?.display_name || '').split(' ')[0] || 'there';
                  await sendEmail({
                    to: ownerEmail,
                    subject: 'Your CardBreakPro payment failed',
                    html: buildPaymentFailedHtml(firstName, billingUrl),
                    text: buildPaymentFailedText(firstName, billingUrl)
                  }).catch(e => console.error('payment_failed email error:', e.message));
                }
              }
            }
          }
        }
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
            organization_id: orgId,
            user_id: ownerId,
            type: 'trial_ending',
            title: 'Trial Ending in 3 Days',
            body: 'Your free trial ends in 3 days. Visit Billing to add a payment method and keep your dashboard access.',
            action_url: APP_URL + '/billing'
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
            organization_id: orgId,
            user_id: ownerId,
            type: 'renewal_reminder',
            title: 'Upcoming Renewal',
            body: `Your Card Break Pro subscription renews in ~7 days for ${amount}. Manage your billing at cardbreakpro.com/billing.`,
            action_url: APP_URL + '/billing'
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

function buildPaymentFailedText(name, billingUrl) {
  return `Hey ${name},

Your last CardBreakPro payment didn't go through.

Here's what that means: you have a 3-day grace period before access is restricted. Nothing has changed yet — your platform is still fully operational. But if this doesn't get resolved, your team will lose access.

Fix it here: ${billingUrl}

Once you update your payment method, your subscription resumes immediately and the grace period is cleared.

If you think this was an error or you have questions, reply to this email.

— Lucas
Card Break Pro`;
}

function buildPaymentFailedHtml(name, billingUrl) {
  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#f4f4f5;font-family:'Segoe UI',system-ui,-apple-system,sans-serif;">
<div style="max-width:560px;margin:40px auto;background:#ffffff;border-radius:12px;overflow:hidden;box-shadow:0 2px 12px rgba(0,0,0,0.08);">
  <div style="background:#0d0d14;padding:24px 28px;">
    <div style="font-size:1rem;font-weight:800;letter-spacing:2px;color:#e2e8f0;">CARD <span style="color:#4f6ef7;">BREAK</span> PRO</div>
  </div>
  <div style="padding:32px 28px;">
    <p style="margin:0 0 16px;font-size:1rem;color:#1e293b;">Hey ${name},</p>
    <div style="background:#fef2f2;border:1px solid #fca5a5;border-radius:10px;padding:16px 20px;margin-bottom:20px;">
      <div style="font-size:0.75rem;font-weight:700;color:#dc2626;text-transform:uppercase;letter-spacing:0.5px;margin-bottom:6px;">Payment Failed</div>
      <div style="font-size:0.95rem;font-weight:700;color:#1e293b;">Your last payment didn't go through.</div>
    </div>
    <p style="margin:0 0 16px;font-size:0.9rem;color:#334155;line-height:1.7;">You have a <strong>3-day grace period</strong> before access is restricted. Nothing has changed yet — your platform is still fully operational.</p>
    <p style="margin:0 0 24px;font-size:0.9rem;color:#334155;line-height:1.7;">Update your payment method now and your subscription resumes immediately.</p>
    <a href="${billingUrl}" style="display:inline-block;background:#ef4444;color:#fff;text-decoration:none;padding:12px 24px;border-radius:8px;font-weight:700;font-size:0.9rem;margin-bottom:24px;">Fix Payment Now →</a>
    <p style="margin:0 0 4px;font-size:0.85rem;color:#64748b;">If you think this was an error or have questions, reply to this email.</p>
    <p style="margin:24px 0 0;font-size:0.88rem;color:#334155;">— Lucas</p>
    <p style="margin:0;font-size:0.82rem;color:#94a3b8;">Card Break Pro</p>
  </div>
</div>
</body></html>`;
}
