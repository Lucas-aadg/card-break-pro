// CardBreakPro — Renewal Reminder Cron Job (Trigger 5 / Task 5)
// Vercel Cron: runs daily at 10:00 UTC (0 10 * * *)
// Sends 7-day and 3-day renewal reminders when auto-renew is OFF.
// GasPackBreaks (tier='exempt') is permanently excluded.

const { createClient } = require('@supabase/supabase-js');
const { sendEmail } = require('./send-email');

const APP_URL = process.env.APP_URL || 'https://cardbreakpro.com';

const TIER_PRICES = {
  starter: '$129.99/mo',
  pro:     '$399.99/mo',
  empire:  '$999.99/mo',
  legacy:  '$250.00/mo'
};

module.exports = async (req, res) => {
  if (req.method !== 'GET' && req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const sb = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY
  );

  const results = { sent: [], skipped: [], errors: [] };
  const now = new Date();

  try {
    // Active subscriptions with auto-renew off, not exempt
    const { data: subs, error: subErr } = await sb
      .from('subscriptions')
      .select('org_id, user_id, tier, status, current_period_end, renewal_reminder_7d_sent, renewal_reminder_3d_sent')
      .neq('tier', 'exempt')
      .eq('status', 'active')
      .eq('cancel_at_period_end', true); // auto-renew is OFF

    if (subErr) throw new Error('Subscriptions query: ' + subErr.message);
    if (!subs || subs.length === 0) {
      return res.status(200).json({ message: 'No qualifying subscriptions', results });
    }

    for (const sub of subs) {
      try {
        if (!sub.current_period_end) { results.skipped.push(sub.org_id + ':no-end-date'); continue; }

        const renewalDate = new Date(sub.current_period_end);
        const daysUntil = Math.round((renewalDate - now) / (1000 * 60 * 60 * 24));

        let reminderDay = null;
        if (daysUntil === 7 && !sub.renewal_reminder_7d_sent) reminderDay = 7;
        else if (daysUntil === 3 && !sub.renewal_reminder_3d_sent) reminderDay = 3;

        if (!reminderDay) { results.skipped.push(sub.org_id); continue; }

        // Get owner
        const { data: owner } = await sb
          .from('profiles')
          .select('id, display_name')
          .eq('org_id', sub.org_id)
          .eq('role', 'owner')
          .maybeSingle();

        if (!owner) { results.skipped.push(sub.org_id + ':no-owner'); continue; }

        const { data: prefs } = await sb
          .from('notification_preferences')
          .select('*')
          .eq('user_id', owner.id)
          .maybeSingle();

        const billingUrl = APP_URL + '/billing';
        const renewalDateStr = renewalDate.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });
        const tierPrice = TIER_PRICES[sub.tier] || '$0.00/mo';
        const tierName = sub.tier ? (sub.tier.charAt(0).toUpperCase() + sub.tier.slice(1)) : 'Plan';

        const title = `Your subscription renews in ${reminderDay} days`;
        const body  = `Your ${tierName} plan renews on ${renewalDateStr} for ${tierPrice}. Auto-renew is currently off — make sure your payment method is up to date to avoid losing access.`;

        if (prefs?.in_app_notifications_enabled !== false) {
          await sb.from('notifications').insert({
            organization_id: sub.org_id,
            user_id: owner.id,
            type: 'renewal_reminder',
            title,
            body,
            action_url: billingUrl
          });
        }

        if (prefs?.email_notifications_enabled !== false) {
          const { data: authUser } = await sb.auth.admin.getUserById(owner.id);
          const ownerEmail = authUser?.user?.email;
          if (ownerEmail) {
            const firstName = (owner.display_name || '').split(' ')[0] || 'there';
            const subject = `Your CardBreakPro subscription ${reminderDay === 7 ? 'renews in 7 days' : 'renews in 3 days — last reminder'}`;
            await sendEmail({
              to: ownerEmail,
              subject,
              html: buildRenewalReminderHtml(firstName, reminderDay, tierName, renewalDateStr, tierPrice, billingUrl),
              text: buildRenewalReminderText(firstName, reminderDay, tierName, renewalDateStr, tierPrice, billingUrl)
            });
          }
        }

        // Mark sent
        const flagField = reminderDay === 7 ? 'renewal_reminder_7d_sent' : 'renewal_reminder_3d_sent';
        await sb.from('subscriptions').update({ [flagField]: true }).eq('org_id', sub.org_id);
        results.sent.push({ org_id: sub.org_id, reminder_day: reminderDay });
      } catch (innerErr) {
        results.errors.push({ org_id: sub.org_id, error: innerErr.message });
        console.error('Renewal reminder error for org', sub.org_id, innerErr);
      }
    }

    return res.status(200).json({ message: 'Done', results });
  } catch (err) {
    console.error('Renewal reminder cron fatal error:', err);
    return res.status(500).json({ error: err.message });
  }
};

function buildRenewalReminderText(name, days, tierName, renewalDate, price, billingUrl) {
  return `Hey ${name},

Your ${tierName} plan renews in ${days} day${days !== 1 ? 's' : ''} on ${renewalDate} for ${price}.

Auto-renew is currently off. If you don't update your payment method before that date, your access will be interrupted.

Update your payment method here:
${billingUrl}

— Lucas
Card Break Pro`;
}

function buildRenewalReminderHtml(name, days, tierName, renewalDate, price, billingUrl) {
  const urgencyColor = days <= 3 ? '#ef4444' : '#f59e0b';
  const urgencyBg    = days <= 3 ? '#fef2f2' : '#fffbeb';
  const urgencyBorder = days <= 3 ? '#fca5a5' : '#fbbf24';
  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#f4f4f5;font-family:'Segoe UI',system-ui,-apple-system,sans-serif;">
<div style="max-width:560px;margin:40px auto;background:#ffffff;border-radius:12px;overflow:hidden;box-shadow:0 2px 12px rgba(0,0,0,0.08);">
  <div style="background:#0d0d14;padding:24px 28px;">
    <div style="font-size:1rem;font-weight:800;letter-spacing:2px;color:#e2e8f0;">CARD <span style="color:#4f6ef7;">BREAK</span> PRO</div>
  </div>
  <div style="padding:32px 28px;">
    <p style="margin:0 0 16px;font-size:1rem;color:#1e293b;">Hey ${escHtml(name)},</p>
    <div style="background:${urgencyBg};border:1px solid ${urgencyBorder};border-radius:10px;padding:16px 20px;margin-bottom:20px;">
      <div style="font-size:0.75rem;font-weight:700;color:${urgencyColor};text-transform:uppercase;letter-spacing:0.5px;margin-bottom:6px;">Renewal in ${days} day${days !== 1 ? 's' : ''}</div>
      <div style="font-size:1.05rem;font-weight:800;color:#1e293b;">${escHtml(tierName)} Plan</div>
      <div style="font-size:0.9rem;color:#334155;margin-top:4px;">${escHtml(renewalDate)} · ${escHtml(price)}</div>
    </div>
    <p style="margin:0 0 12px;font-size:0.95rem;color:#334155;line-height:1.65;"><strong>Auto-renew is currently off.</strong></p>
    <p style="margin:0 0 24px;font-size:0.9rem;color:#334155;line-height:1.65;">If you don't update your payment method before ${escHtml(renewalDate)}, your access will be interrupted.</p>
    <a href="${billingUrl}" style="display:inline-block;background:#4f6ef7;color:#fff;text-decoration:none;padding:12px 24px;border-radius:8px;font-weight:700;font-size:0.9rem;">Update Payment Method →</a>
    <p style="margin:28px 0 0;font-size:0.85rem;color:#94a3b8;">— Lucas · Card Break Pro</p>
  </div>
</div>
</body></html>`;
}

function escHtml(str) {
  return String(str || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}
