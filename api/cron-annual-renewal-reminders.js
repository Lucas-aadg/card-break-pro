// Card Break Pro — Annual Renewal Reminder Cron
// Runs daily via Vercel Cron. Sends 30-day and 7-day renewal reminders.
// GasPackBreaks (tier='exempt') is permanently excluded.

const { createClient } = require('@supabase/supabase-js');
const { sendEmail } = require('./send-email');
const APP_URL = process.env.APP_URL || 'https://cardbreakpro.com';

module.exports = async (req, res) => {
  if (req.method !== 'GET' && req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const sb = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY
  );

  const results = { sent: [], skipped: [], errors: [] };

  try {
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    const in30 = new Date(today); in30.setDate(in30.getDate() + 30);
    const in7  = new Date(today); in7.setDate(in7.getDate() + 7);
    const in30Str = in30.toISOString().split('T')[0];
    const in7Str  = in7.toISOString().split('T')[0];

    const { data: subs, error: subErr } = await sb
      .from('subscriptions')
      .select('org_id, user_id, tier, billing_cycle, annual_renewal_date, annual_reminder_30_sent, annual_reminder_7_sent')
      .eq('billing_cycle', 'annual')
      .eq('status', 'active')
      .neq('tier', 'exempt')
      .or('annual_renewal_date.eq.' + in30Str + ',annual_renewal_date.eq.' + in7Str);

    if (subErr) throw new Error('Subscriptions query failed: ' + subErr.message);
    if (!subs || subs.length === 0) return res.status(200).json({ message: 'No upcoming annual renewals today', results });

    const ANNUAL_PRICES = { starter: 990.00, pro: 3999.90, empire: 9999.90 };

    for (const sub of subs) {
      try {
        const renewalDate = sub.annual_renewal_date;
        const daysUntil   = renewalDate === in30Str ? 30 : 7;
        const flagField   = daysUntil === 30 ? 'annual_reminder_30_sent' : 'annual_reminder_7_sent';

        if (sub[flagField]) { results.skipped.push({ org_id: sub.org_id, reason: 'already-sent-' + daysUntil }); continue; }

        const { data: owner } = await sb.from('profiles')
          .select('id, display_name').eq('org_id', sub.org_id).eq('role', 'owner').maybeSingle();

        const { data: authUser } = await sb.auth.admin.getUserById(sub.user_id || owner?.id);
        const ownerEmail = authUser?.user?.email;
        if (!ownerEmail) { results.skipped.push({ org_id: sub.org_id, reason: 'no-email' }); continue; }

        const firstName  = (owner?.display_name || '').split(' ')[0] || 'there';
        const tierName   = (sub.tier || 'starter').charAt(0).toUpperCase() + (sub.tier || 'starter').slice(1);
        const amount     = ANNUAL_PRICES[sub.tier] || 0;
        const renewalFmt = new Date(renewalDate + 'T12:00:00Z').toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });
        const billingUrl = APP_URL + '/billing';

        const { subject, html, text } = buildReminderEmail(daysUntil, firstName, tierName, amount, renewalFmt, billingUrl);
        await sendEmail({ to: ownerEmail, subject, html, text });
        await sb.from('subscriptions').update({ [flagField]: true }).eq('org_id', sub.org_id);
        results.sent.push({ org_id: sub.org_id, days_until: daysUntil, to: ownerEmail });
      } catch (innerErr) {
        results.errors.push({ org_id: sub.org_id, error: innerErr.message });
        console.error('Annual renewal reminder error for org', sub.org_id, innerErr);
      }
    }

    res.status(200).json({ message: 'Done', results });
  } catch (err) {
    console.error('Annual renewal cron fatal error:', err);
    res.status(500).json({ error: err.message });
  }
};

function buildReminderEmail(days, firstName, tierName, amount, renewalDate, billingUrl) {
  const subject = days === 30
    ? 'Your CardBreakPro annual plan renews in 30 days'
    : 'CardBreakPro renewal in 7 days — $' + amount.toFixed(2) + ' on ' + renewalDate;

  const urgencyColor = days === 30 ? '#4f6ef7' : '#f59e0b';
  const intro = days === 30
    ? 'Heads up — your CardBreakPro ' + tierName + ' annual plan renews in 30 days.'
    : 'Your CardBreakPro ' + tierName + ' annual plan renews in 7 days.';

  const text = `Hey ${firstName},

${intro}

Renewal date: ${renewalDate}
Amount: $${amount.toFixed(2)}

Everything continues uninterrupted. If you need to update your payment method or make any changes, do it before your renewal date.

Manage billing: ${billingUrl}

— Lucas
Card Break Pro`;

  const html = `<!DOCTYPE html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#f4f4f5;font-family:'Segoe UI',system-ui,-apple-system,sans-serif;">
<div style="max-width:560px;margin:40px auto;background:#ffffff;border-radius:12px;overflow:hidden;box-shadow:0 2px 12px rgba(0,0,0,0.08);">
  <div style="background:#0d0d14;padding:24px 28px;">
    <div style="font-size:1rem;font-weight:800;letter-spacing:2px;color:#e2e8f0;">CARD <span style="color:#4f6ef7;">BREAK</span> PRO</div>
  </div>
  <div style="padding:32px 28px;">
    <p style="margin:0 0 16px;font-size:1rem;color:#1e293b;">Hey ${firstName},</p>
    <div style="background:${urgencyColor}1a;border:1px solid ${urgencyColor}44;border-radius:10px;padding:16px 20px;margin-bottom:20px;">
      <div style="font-size:0.75rem;font-weight:700;color:${urgencyColor};text-transform:uppercase;letter-spacing:0.5px;margin-bottom:6px;">${days} Days Until Renewal</div>
      <div style="font-size:0.95rem;font-weight:700;color:#1e293b;">${tierName} Annual — $${amount.toFixed(2)}</div>
      <div style="font-size:0.85rem;color:#64748b;margin-top:4px;">Renews ${renewalDate}</div>
    </div>
    <p style="margin:0 0 16px;font-size:0.9rem;color:#334155;line-height:1.7;">${intro}</p>
    <p style="margin:0 0 24px;font-size:0.9rem;color:#334155;line-height:1.7;">Everything continues uninterrupted. If you need to update your payment method or make any changes to your plan, take care of it before your renewal date.</p>
    <a href="${billingUrl}" style="display:inline-block;background:#4f6ef7;color:#fff;text-decoration:none;padding:12px 24px;border-radius:8px;font-weight:700;font-size:0.9rem;margin-bottom:24px;">Manage Billing →</a>
    <p style="margin:24px 0 0;font-size:0.88rem;color:#334155;">— Lucas</p>
    <p style="margin:0;font-size:0.82rem;color:#94a3b8;">Card Break Pro</p>
  </div>
</div>
</body></html>`;

  return { subject, html, text };
}
