const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const { createClient } = require('@supabase/supabase-js');
const { sendEmail } = require('./send-email');
const APP_URL = process.env.APP_URL || 'https://cardbreakpro.com';

module.exports.config = { api: { bodyParser: false } };

function getRawBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

async function getOrgAndOwner(sb, { subscriptionId, customerId }) {
  const query = sb.from('subscriptions').select('org_id');
  if (subscriptionId) query.eq('stripe_subscription_id', subscriptionId);
  else if (customerId) query.eq('stripe_customer_id', customerId);
  const { data: subRecord } = await query.maybeSingle();
  if (!subRecord?.org_id) return { orgId: null, ownerId: null };
  const { data: owner } = await sb.from('profiles').select('id').eq('org_id', subRecord.org_id).eq('role', 'owner').maybeSingle();
  return { orgId: subRecord.org_id, ownerId: owner?.id ?? null };
}

const TIER_LIMITS = {
  starter: { max_breakers: 3,    max_sorters: 2, max_managers: 1 },
  pro:     { max_breakers: 8,    max_sorters: 4, max_managers: 2 },
  empire:  { max_breakers: null, max_sorters: null, max_managers: null },
  legacy:  { max_breakers: null, max_sorters: null, max_managers: null }
};

const PRICE_TIER_MAP = {
  [process.env.STRIPE_PRICE_ID_STARTER]:        'starter',
  'price_1TcA00AQv5DHthFTUHf8QFvL':             'starter',
  [process.env.STRIPE_PRICE_ID_PRO]:            'pro',
  [process.env.STRIPE_PRICE_ID_EMPIRE]:         'empire',
  [process.env.STRIPE_PRICE_ID_STARTER_ANNUAL]: 'starter',
  [process.env.STRIPE_PRICE_ID_PRO_ANNUAL]:     'pro',
  [process.env.STRIPE_PRICE_ID_EMPIRE_ANNUAL]:  'empire'
};

const ANNUAL_PRICE_IDS = new Set([
  process.env.STRIPE_PRICE_ID_STARTER_ANNUAL,
  process.env.STRIPE_PRICE_ID_PRO_ANNUAL,
  process.env.STRIPE_PRICE_ID_EMPIRE_ANNUAL
].filter(Boolean));

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

  const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY);

  const getMetadata = (obj) => ({
    userId:  obj.metadata?.user_id,
    orgId:   obj.metadata?.org_id,
    billing_cycle: obj.metadata?.billing_cycle || 'monthly'
  });

  try {
    switch (event.type) {

      // ── checkout.session.completed ─────────────────────────────────────────
      case 'checkout.session.completed': {
        const session = event.data.object;
        const { userId, orgId, billing_cycle } = getMetadata(session);
        if (!orgId) break;

        const tier   = session.metadata?.tier || 'starter';
        const limits = TIER_LIMITS[tier] || TIER_LIMITS.starter;

        // Detect billing cycle from metadata OR from the price ID on the subscription
        let resolvedCycle = billing_cycle;
        if (session.subscription) {
          try {
            const stripeSub = await stripe.subscriptions.retrieve(session.subscription);
            const priceId = stripeSub.items?.data?.[0]?.price?.id;
            if (priceId && ANNUAL_PRICE_IDS.has(priceId)) resolvedCycle = 'annual';
          } catch (e) { /* non-fatal */ }
        }

        const upsertData = {
          org_id:                 orgId,
          user_id:                userId,
          stripe_customer_id:     session.customer,
          stripe_subscription_id: session.subscription,
          status:                 'active',
          tier,
          billing_cycle:          resolvedCycle,
          max_breakers:           limits.max_breakers,
          max_sorters:            limits.max_sorters,
          max_managers:           limits.max_managers,
          updated_at:             new Date().toISOString()
        };

        if (resolvedCycle === 'annual') {
          const renewalDate = new Date();
          renewalDate.setFullYear(renewalDate.getFullYear() + 1);
          upsertData.annual_renewal_date = renewalDate.toISOString().split('T')[0];
        }

        const { error } = await sb.from('subscriptions').upsert(upsertData, { onConflict: 'org_id' });
        if (error) console.error('Supabase upsert error (checkout.session.completed):', error);

        // ── Referral conversion trigger ──
        if (tier !== 'exempt') {
          await processReferralConversion(sb, orgId).catch(e => console.error('Referral conversion error:', e.message));
        }
        break;
      }

      // ── customer.subscription.updated ────────────────────────────────────
      case 'customer.subscription.updated': {
        const sub = event.data.object;
        const status = sub.status === 'trialing' ? 'active' : sub.status;
        const updateFields = {
          status,
          cancel_at_period_end: sub.cancel_at_period_end || false,
          current_period_end:   sub.current_period_end ? new Date(sub.current_period_end * 1000).toISOString() : null,
          updated_at:           new Date().toISOString()
        };

        const priceId = sub.items?.data?.[0]?.price?.id;
        const newTier = PRICE_TIER_MAP[priceId];
        if (newTier) {
          const limits = TIER_LIMITS[newTier] || {};
          updateFields.tier        = newTier;
          updateFields.max_breakers = limits.max_breakers !== undefined ? limits.max_breakers : null;
          updateFields.max_sorters  = limits.max_sorters  !== undefined ? limits.max_sorters  : null;
          updateFields.max_managers = limits.max_managers !== undefined ? limits.max_managers : null;
        }

        // Sync billing_cycle if price switched to/from annual
        if (priceId) {
          if (ANNUAL_PRICE_IDS.has(priceId)) {
            updateFields.billing_cycle = 'annual';
            const renewalDate = new Date();
            renewalDate.setFullYear(renewalDate.getFullYear() + 1);
            updateFields.annual_renewal_date = renewalDate.toISOString().split('T')[0];
          } else {
            updateFields.billing_cycle = 'monthly';
          }
        }

        const { error } = await sb.from('subscriptions').update(updateFields).eq('stripe_subscription_id', sub.id);
        if (error) console.error('Supabase update error (customer.subscription.updated):', error);
        break;
      }

      // ── customer.subscription.deleted ────────────────────────────────────
      case 'customer.subscription.deleted': {
        const sub = event.data.object;
        const { error } = await sb.from('subscriptions')
          .update({ status: 'cancelled', updated_at: new Date().toISOString() })
          .eq('stripe_subscription_id', sub.id);
        if (error) console.error('Supabase update error (customer.subscription.deleted):', error);
        break;
      }

      // ── invoice.payment_failed ────────────────────────────────────────────
      case 'invoice.payment_failed': {
        const invoice = event.data.object;
        const { error } = await sb.from('subscriptions')
          .update({ status: 'past_due', updated_at: new Date().toISOString() })
          .eq('stripe_customer_id', invoice.customer);
        if (error) console.error('Supabase update error (invoice.payment_failed):', error);

        const { orgId: pfOrgId, ownerId: pfOwnerId } = await getOrgAndOwner(sb, { customerId: invoice.customer });
        if (pfOrgId && pfOwnerId) {
          const { data: pfSub } = await sb.from('subscriptions').select('tier').eq('org_id', pfOrgId).maybeSingle();
          if (pfSub?.tier !== 'exempt') {
            const billingUrl = APP_URL + '/billing';
            const notifTitle = 'Payment failed — action required';
            const notifBody  = 'Your last payment did not go through. You have a 3-day grace period before access is restricted. Update your payment method now to avoid interruption.';
            const { data: pfPrefs } = await sb.from('notification_preferences').select('*').eq('user_id', pfOwnerId).maybeSingle();
            if (pfPrefs?.notify_payment_failed !== false) {
              if (pfPrefs?.in_app_notifications_enabled !== false) {
                await sb.from('notifications').insert({
                  organization_id: pfOrgId, user_id: pfOwnerId,
                  type: 'payment_failed', title: notifTitle, body: notifBody, action_url: billingUrl
                }).catch(e => console.error('payment_failed notif error:', e.message));
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

      // ── customer.subscription.created ────────────────────────────────────
      case 'customer.subscription.created': {
        const sub = event.data.object;
        const status = sub.status === 'trialing' ? 'active' : sub.status;
        const { error } = await sb.from('subscriptions')
          .update({
            stripe_subscription_id: sub.id,
            status,
            cancel_at_period_end: sub.cancel_at_period_end || false,
            current_period_end:   sub.current_period_end ? new Date(sub.current_period_end * 1000).toISOString() : null,
            updated_at:           new Date().toISOString()
          })
          .eq('stripe_customer_id', sub.customer);
        if (error) console.error('Supabase update error (customer.subscription.created):', error);
        break;
      }

      // ── invoice.payment_succeeded ─────────────────────────────────────────
      case 'invoice.payment_succeeded': {
        const invoice = event.data.object;
        if (!invoice.subscription) break;
        const { error } = await sb.from('subscriptions')
          .update({ status: 'active', updated_at: new Date().toISOString() })
          .eq('stripe_subscription_id', invoice.subscription);
        if (error) console.error('Supabase update error (invoice.payment_succeeded):', error);

        // Annual renewal confirmation email
        const { orgId, ownerId } = await getOrgAndOwner(sb, { subscriptionId: invoice.subscription });
        if (orgId && ownerId) {
          const { data: subData } = await sb.from('subscriptions').select('tier, billing_cycle').eq('org_id', orgId).maybeSingle();
          if (subData?.billing_cycle === 'annual' && subData?.tier !== 'exempt') {
            // Reset annual reminder flags for next year
            const nextRenewal = new Date();
            nextRenewal.setFullYear(nextRenewal.getFullYear() + 1);
            await sb.from('subscriptions').update({
              annual_renewal_date:      nextRenewal.toISOString().split('T')[0],
              annual_reminder_30_sent:  false,
              annual_reminder_7_sent:   false,
              updated_at:               new Date().toISOString()
            }).eq('org_id', orgId);

            // Send renewal success email
            const { data: authUser } = await sb.auth.admin.getUserById(ownerId);
            const ownerEmail = authUser?.user?.email;
            if (ownerEmail) {
              const { data: ownerProfile } = await sb.from('profiles').select('display_name').eq('id', ownerId).maybeSingle();
              const firstName = (ownerProfile?.display_name || '').split(' ')[0] || 'there';
              const tierName  = (subData.tier || 'starter').charAt(0).toUpperCase() + (subData.tier || 'starter').slice(1);
              await sendEmail({
                to: ownerEmail,
                subject: 'Your CardBreakPro annual subscription has renewed',
                html: buildAnnualRenewalSuccessHtml(firstName, tierName, APP_URL + '/billing'),
                text: buildAnnualRenewalSuccessText(firstName, tierName, APP_URL + '/billing')
              }).catch(e => console.error('annual renewal success email error:', e.message));
            }
          }
        }
        break;
      }

      // ── customer.subscription.trial_will_end ─────────────────────────────
      case 'customer.subscription.trial_will_end': {
        const sub = event.data.object;
        const { orgId, ownerId } = await getOrgAndOwner(sb, { subscriptionId: sub.id });
        if (orgId && ownerId) {
          const { error } = await sb.from('notifications').insert({
            organization_id: orgId, user_id: ownerId,
            type: 'trial_ending',
            title: 'Trial Ending in 3 Days',
            body: 'Your free trial ends in 3 days. Visit Billing to add a payment method and keep your dashboard access.',
            action_url: APP_URL + '/billing'
          });
          if (error) console.error('Supabase insert error (trial_will_end notification):', error);
        }
        break;
      }

      // ── invoice.upcoming ──────────────────────────────────────────────────
      case 'invoice.upcoming': {
        const invoice = event.data.object;
        if (!invoice.subscription) break;
        const { orgId, ownerId } = await getOrgAndOwner(sb, { subscriptionId: invoice.subscription });
        if (orgId && ownerId) {
          const amount = invoice.amount_due ? '$' + (invoice.amount_due / 100).toFixed(2) : '$250.00';
          const { error } = await sb.from('notifications').insert({
            organization_id: orgId, user_id: ownerId,
            type: 'renewal_reminder',
            title: 'Upcoming Renewal',
            body: `Your Card Break Pro subscription renews in ~7 days for ${amount}. Manage your billing at cardbreakpro.com/billing.`,
            action_url: APP_URL + '/billing'
          });
          if (error) console.error('Supabase insert error (invoice.upcoming notification):', error);
        }
        break;
      }

      // ── payment_intent.payment_failed ─────────────────────────────────────
      case 'payment_intent.payment_failed': {
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

// ── Referral conversion reward ─────────────────────────────────────────────
async function processReferralConversion(sb, referredOrgId) {
  // Check if this org used a referral code
  const { data: org } = await sb.from('organizations').select('referral_code_used, name').eq('id', referredOrgId).maybeSingle();
  if (!org?.referral_code_used) return;

  // Find the referral code record
  const { data: refCode } = await sb.from('referral_codes')
    .select('id, organization_id, times_converted, total_credits_earned')
    .eq('code', org.referral_code_used)
    .maybeSingle();
  if (!refCode) return;

  // Find the referral_uses record
  const { data: refUse } = await sb.from('referral_uses')
    .select('id, status, reward_granted')
    .eq('referral_code_id', refCode.id)
    .eq('referred_organization_id', referredOrgId)
    .eq('status', 'pending')
    .maybeSingle();
  if (!refUse || refUse.reward_granted) return;

  const now = new Date().toISOString();

  // Mark use as converted
  await sb.from('referral_uses').update({
    status: 'converted', converted_at: now, reward_granted: false
  }).eq('id', refUse.id);

  // Get referrer organization subscription
  const { data: referrerSub } = await sb.from('subscriptions')
    .select('org_id, tier, billing_cycle, stripe_subscription_id, annual_renewal_date, months_credited, status')
    .eq('org_id', refCode.organization_id)
    .maybeSingle();

  if (!referrerSub || referrerSub.status !== 'active' || referrerSub.tier === 'exempt') return;

  let rewardApplied = false;

  if (referrerSub.billing_cycle === 'monthly' && referrerSub.stripe_subscription_id) {
    // Monthly: extend current period by 30 days
    try {
      const stripeSub = await stripe.subscriptions.retrieve(referrerSub.stripe_subscription_id);
      const newPeriodEnd = stripeSub.current_period_end + (30 * 24 * 60 * 60);
      await stripe.subscriptions.update(referrerSub.stripe_subscription_id, {
        trial_end: newPeriodEnd,
        proration_behavior: 'none'
      });
      rewardApplied = true;
    } catch (e) {
      console.error('Referral monthly reward error:', e.message);
    }
  } else if (referrerSub.billing_cycle === 'annual' && referrerSub.annual_renewal_date) {
    // Annual: extend renewal date by 30 days
    const currentRenewal = new Date(referrerSub.annual_renewal_date + 'T12:00:00Z');
    currentRenewal.setDate(currentRenewal.getDate() + 30);
    await sb.from('subscriptions').update({
      annual_renewal_date: currentRenewal.toISOString().split('T')[0],
      months_credited: (referrerSub.months_credited || 0) + 1,
      updated_at: now
    }).eq('org_id', refCode.organization_id);
    rewardApplied = true;
  }

  if (!rewardApplied) return;

  // Mark reward granted
  await sb.from('referral_uses').update({
    reward_granted: true, referrer_credited_at: now
  }).eq('id', refUse.id);

  // Update referral code stats
  await sb.from('referral_codes').update({
    times_converted:      (refCode.times_converted || 0) + 1,
    total_credits_earned: (refCode.total_credits_earned || 0) + 1
  }).eq('id', refCode.id);

  // Notify referrer
  const { data: referrerOwner } = await sb.from('profiles')
    .select('id, display_name')
    .eq('org_id', refCode.organization_id).eq('role', 'owner').maybeSingle();
  if (!referrerOwner) return;

  // In-app notification
  await sb.from('notifications').insert({
    organization_id: refCode.organization_id,
    user_id:         referrerOwner.id,
    type:            'referral_reward',
    title:           'You earned a free month',
    body:            (org.name || 'A business you referred') + ' just became a paying CardBreakPro customer using your referral code. We\'ve added one free month to your subscription.',
    action_url:      APP_URL + '/dashboard'
  }).catch(e => console.error('referral reward notification error:', e.message));

  // Email notification
  const { data: authUser } = await sb.auth.admin.getUserById(referrerOwner.id);
  const ownerEmail = authUser?.user?.email;
  if (ownerEmail) {
    const firstName = (referrerOwner.display_name || '').split(' ')[0] || 'there';
    await sendEmail({
      to: ownerEmail,
      subject: 'You just earned a free month on CardBreakPro',
      html: buildReferralRewardHtml(firstName, org.name || 'A business you referred', APP_URL + '/dashboard'),
      text: buildReferralRewardText(firstName, org.name || 'A business you referred', APP_URL + '/dashboard')
    }).catch(e => console.error('referral reward email error:', e.message));
  }
}

// ── Email builders ─────────────────────────────────────────────────────────

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

function buildAnnualRenewalSuccessText(name, tierName, billingUrl) {
  return `Hey ${name},

Your CardBreakPro ${tierName} annual subscription has renewed successfully.

Another year locked in. Your operation keeps running without interruption, and you're still saving two months versus monthly billing.

Manage your account: ${billingUrl}

— Lucas
Card Break Pro`;
}

function buildAnnualRenewalSuccessHtml(name, tierName, billingUrl) {
  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#f4f4f5;font-family:'Segoe UI',system-ui,-apple-system,sans-serif;">
<div style="max-width:560px;margin:40px auto;background:#ffffff;border-radius:12px;overflow:hidden;box-shadow:0 2px 12px rgba(0,0,0,0.08);">
  <div style="background:#0d0d14;padding:24px 28px;">
    <div style="font-size:1rem;font-weight:800;letter-spacing:2px;color:#e2e8f0;">CARD <span style="color:#4f6ef7;">BREAK</span> PRO</div>
  </div>
  <div style="padding:32px 28px;">
    <p style="margin:0 0 16px;font-size:1rem;color:#1e293b;">Hey ${name},</p>
    <div style="background:#f0fdf4;border:1px solid #86efac;border-radius:10px;padding:16px 20px;margin-bottom:20px;">
      <div style="font-size:0.75rem;font-weight:700;color:#16a34a;text-transform:uppercase;letter-spacing:0.5px;margin-bottom:6px;">Renewal Successful</div>
      <div style="font-size:0.95rem;font-weight:700;color:#1e293b;">${tierName} Annual — another year locked in.</div>
    </div>
    <p style="margin:0 0 16px;font-size:0.9rem;color:#334155;line-height:1.7;">Your operation keeps running without interruption. You're still saving two months of billing versus monthly — every year.</p>
    <a href="${billingUrl}" style="display:inline-block;background:#4f6ef7;color:#fff;text-decoration:none;padding:12px 24px;border-radius:8px;font-weight:700;font-size:0.9rem;margin-bottom:24px;">Manage Billing →</a>
    <p style="margin:24px 0 0;font-size:0.88rem;color:#334155;">— Lucas</p>
    <p style="margin:0;font-size:0.82rem;color:#94a3b8;">Card Break Pro</p>
  </div>
</div>
</body></html>`;
}

function buildReferralRewardText(name, referredOrgName, dashboardUrl) {
  return `Hey ${name},

Good news — ${referredOrgName} just became a paying CardBreakPro customer using your referral code.

Here's what that means for you: we've added one free month to your subscription. No action needed on your end — it's already applied.

That's what the referral program is built for. Every operation you bring onto the platform earns you time back.

Go to your dashboard: ${dashboardUrl}

— Lucas
Card Break Pro`;
}

function buildReferralRewardHtml(name, referredOrgName, dashboardUrl) {
  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#f4f4f5;font-family:'Segoe UI',system-ui,-apple-system,sans-serif;">
<div style="max-width:560px;margin:40px auto;background:#ffffff;border-radius:12px;overflow:hidden;box-shadow:0 2px 12px rgba(0,0,0,0.08);">
  <div style="background:#0d0d14;padding:24px 28px;">
    <div style="font-size:1rem;font-weight:800;letter-spacing:2px;color:#e2e8f0;">CARD <span style="color:#4f6ef7;">BREAK</span> PRO</div>
  </div>
  <div style="padding:32px 28px;">
    <p style="margin:0 0 16px;font-size:1rem;color:#1e293b;">Hey ${name},</p>
    <div style="background:#f0fdf4;border:1px solid #86efac;border-radius:10px;padding:16px 20px;margin-bottom:20px;">
      <div style="font-size:0.75rem;font-weight:700;color:#16a34a;text-transform:uppercase;letter-spacing:0.5px;margin-bottom:6px;">You Earned a Free Month</div>
      <div style="font-size:0.95rem;font-weight:700;color:#1e293b;">${referredOrgName} just became a paying customer.</div>
    </div>
    <p style="margin:0 0 16px;font-size:0.9rem;color:#334155;line-height:1.7;"><strong>${referredOrgName}</strong> used your referral code to sign up and just converted to a paying CardBreakPro customer.</p>
    <p style="margin:0 0 24px;font-size:0.9rem;color:#334155;line-height:1.7;">We've added <strong>one free month</strong> to your subscription. No action needed — it's already applied to your account.</p>
    <a href="${dashboardUrl}" style="display:inline-block;background:#22c55e;color:#fff;text-decoration:none;padding:12px 24px;border-radius:8px;font-weight:700;font-size:0.9rem;margin-bottom:24px;">View Dashboard →</a>
    <p style="margin:24px 0 0;font-size:0.88rem;color:#334155;">— Lucas</p>
    <p style="margin:0;font-size:0.82rem;color:#94a3b8;">Card Break Pro</p>
  </div>
</div>
</body></html>`;
}
