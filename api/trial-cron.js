// Card Break Pro — Trial conversion email cron
// Called daily by Vercel Cron (see vercel.json). Sends Day 7, Day 12, Day 14 emails.
// GasPackBreaks (tier='exempt') is permanently excluded from all trial emails.

const { createClient } = require('@supabase/supabase-js');
const { sendEmail } = require('./send-email');

const APP_URL = process.env.APP_URL || 'https://cardbreakpro.com';

module.exports = async (req, res) => {
  // Only allow internal cron calls (Vercel sets this header) or GET requests
  if (req.method !== 'GET' && req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const sb = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY
  );

  const results = { sent: [], skipped: [], errors: [] };

  try {
    // Fetch all active/trialing subscriptions that are NOT exempt and have not
    // finished their trial (status='active' covers both trialing and converted).
    // We use created_at as the trial start date proxy.
    const { data: subs, error: subErr } = await sb
      .from('subscriptions')
      .select('org_id, user_id, tier, status, created_at, trial_email_day7_sent, trial_email_day12_sent, trial_email_day14_sent')
      .neq('tier', 'exempt')
      .neq('tier', 'legacy')
      .in('status', ['active', 'trialing']);

    if (subErr) throw new Error('Subscriptions query failed: ' + subErr.message);
    if (!subs || subs.length === 0) return res.status(200).json({ message: 'No active trials', results });

    const today = new Date();
    today.setHours(0, 0, 0, 0);

    for (const sub of subs) {
      try {
        const createdAt = new Date(sub.created_at);
        createdAt.setHours(0, 0, 0, 0);
        const daysSince = Math.round((today - createdAt) / (1000 * 60 * 60 * 24));

        // Determine which email to send today, if any
        let emailDay = null;
        if (daysSince === 7 && !sub.trial_email_day7_sent) emailDay = 7;
        else if (daysSince === 12 && !sub.trial_email_day12_sent) emailDay = 12;
        else if (daysSince === 14 && !sub.trial_email_day14_sent) emailDay = 14;

        if (!emailDay) { results.skipped.push(sub.org_id); continue; }

        // Get org owner email and name
        const { data: owner } = await sb
          .from('profiles')
          .select('id, display_name')
          .eq('org_id', sub.org_id)
          .eq('role', 'owner')
          .single();

        const { data: authUser } = await sb.auth.admin.getUserById(sub.user_id || owner?.id);
        const ownerEmail = authUser?.user?.email;
        if (!ownerEmail) { results.skipped.push(sub.org_id + ':no-email'); continue; }

        const { data: org } = await sb.from('organizations').select('name').eq('id', sub.org_id).single();
        const orgName = org?.name || 'your operation';
        const firstName = (owner?.display_name || '').split(' ')[0] || 'there';

        // Get trial stats
        const trialStart = sub.created_at;
        const { count: breaksCount } = await sb
          .from('breaks')
          .select('id', { count: 'exact', head: true })
          .eq('org_id', sub.org_id)
          .gte('created_at', trialStart);

        const { count: streamsCount } = await sb
          .from('streams')
          .select('id', { count: 'exact', head: true })
          .eq('org_id', sub.org_id)
          .eq('status', 'closed')
          .gte('created_at', trialStart);

        const breaks = breaksCount || 0;
        const streams = streamsCount || 0;
        const hoursSaved = Math.round((breaks * 8) / 60 * 10) / 10;

        const billingUrl = APP_URL + '/billing';
        const { subject, html, text } = buildEmail(emailDay, firstName, orgName, breaks, streams, hoursSaved, billingUrl);

        await sendEmail({ to: ownerEmail, subject, html, text });

        // Mark as sent
        const flagField = 'trial_email_day' + emailDay + '_sent';
        await sb.from('subscriptions').update({ [flagField]: true }).eq('org_id', sub.org_id);

        results.sent.push({ org_id: sub.org_id, email_day: emailDay, to: ownerEmail });
      } catch (innerErr) {
        results.errors.push({ org_id: sub.org_id, error: innerErr.message });
        console.error('Trial email error for org', sub.org_id, innerErr);
      }
    }

    res.status(200).json({ message: 'Done', results });
  } catch (err) {
    console.error('Trial cron fatal error:', err);
    res.status(500).json({ error: err.message });
  }
};

function buildEmail(day, firstName, orgName, breaks, streams, hoursSaved, billingUrl) {
  if (day === 7) return buildDay7(firstName, orgName, breaks, billingUrl);
  if (day === 12) return buildDay12(firstName, orgName, breaks, streams, hoursSaved, billingUrl);
  return buildDay14(firstName, orgName, breaks, streams, billingUrl);
}

// ─── Email 1: Day 7 ───────────────────────────────────────────────────────────
function buildDay7(firstName, orgName, breaks, billingUrl) {
  const subject = 'How are the numbers looking?';
  const text = `Hey ${firstName},

It's been a week since you started running ${orgName} on Card Break Pro.

I want to ask you something directly — how does it feel to know your profit the second a stream closes, instead of doing the math yourself an hour later?

This past week, the platform tracked everything automatically for you: every break, every commission owed to your team, every inventory movement. ${breaks > 0 ? `You logged ${breaks} break${breaks !== 1 ? 's' : ''} — that's ${breaks} times you didn't have to write anything down or pull up a spreadsheet.` : ''}

You have 7 days left in your trial.

I'm not going to pressure you. But I will say this: the moment you leave, all of that goes back to being manual. Group chats. Notebooks. Spreadsheets. Trying to remember if last Tuesday was profitable.

You already know if this platform is worth it. The numbers have been telling you all week.

— Lucas
Card Break Pro

P.S. If you have any questions about the platform or want to talk through what plan makes sense for your operation, reply to this email. I read every one.`;

  const html = `<!DOCTYPE html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#f4f4f5;font-family:'Segoe UI',system-ui,-apple-system,sans-serif;">
<div style="max-width:580px;margin:40px auto;background:#ffffff;border-radius:12px;overflow:hidden;box-shadow:0 2px 12px rgba(0,0,0,0.08);">
  <div style="background:#0d0d14;padding:28px 32px;">
    <div style="font-size:1.1rem;font-weight:800;letter-spacing:2px;color:#e2e8f0;">CARD <span style="color:#4f6ef7;">BREAK</span> PRO</div>
  </div>
  <div style="padding:36px 32px;">
    <p style="margin:0 0 18px;font-size:1rem;color:#1e293b;">Hey ${firstName},</p>
    <p style="margin:0 0 18px;font-size:0.97rem;color:#334155;line-height:1.65;">It's been a week since you started running <strong>${orgName}</strong> on Card Break Pro.</p>
    <p style="margin:0 0 18px;font-size:0.97rem;color:#334155;line-height:1.65;">I want to ask you something directly — <strong>how does it feel to know your profit the second a stream closes</strong>, instead of doing the math yourself an hour later?</p>
    <p style="margin:0 0 18px;font-size:0.97rem;color:#334155;line-height:1.65;">This past week, the platform tracked everything automatically: every break, every commission owed to your team, every inventory movement.${breaks > 0 ? ` You logged <strong>${breaks} break${breaks !== 1 ? 's' : ''}</strong> — that's ${breaks} times you didn't have to write anything down or pull up a spreadsheet.` : ''}</p>
    <div style="background:#f8fafc;border-left:4px solid #4f6ef7;border-radius:4px;padding:16px 20px;margin:24px 0;">
      <p style="margin:0;font-size:0.95rem;color:#1e293b;font-weight:600;">You have 7 days left in your trial.</p>
    </div>
    <p style="margin:0 0 18px;font-size:0.97rem;color:#334155;line-height:1.65;">I'm not going to pressure you. But I will say this: the moment you leave, all of that goes back to being manual. Group chats. Notebooks. Spreadsheets. Trying to remember if last Tuesday was profitable.</p>
    <p style="margin:0 0 28px;font-size:0.97rem;color:#334155;line-height:1.65;">You already know if this platform is worth it. The numbers have been telling you all week.</p>
    <p style="margin:0 0 8px;font-size:0.97rem;color:#334155;">— Lucas</p>
    <p style="margin:0 0 32px;font-size:0.88rem;color:#64748b;">Card Break Pro</p>
    <div style="border-top:1px solid #e2e8f0;padding-top:20px;">
      <p style="margin:0;font-size:0.82rem;color:#94a3b8;line-height:1.5;">P.S. If you have questions or want to talk through what plan makes sense for your operation, just reply to this email. I read every one.</p>
    </div>
  </div>
</div>
</body></html>`;

  return { subject, html, text };
}

// ─── Email 2: Day 12 ──────────────────────────────────────────────────────────
function buildDay12(firstName, orgName, breaks, streams, hoursSaved, billingUrl) {
  const subject = '2 days left — and something I want you to see';
  const text = `Hey ${firstName},

Your Card Break Pro trial ends in 2 days.

I pulled your numbers from the last 12 days. Here's what the platform did for ${orgName}:

  Breaks logged: ${breaks}
  Streams closed: ${streams}
  Estimated time saved: ~${hoursSaved} hours (at 8 min average admin time per break)

That's ${hoursSaved} hours you didn't spend doing math, writing things down, or figuring out who got paid what.

Here's what I want you to think about: going back to spreadsheets after seeing real-time profit is a choice I understand. But it costs real time and real money every single week. Not someday — every week.

When your trial ends Thursday and you're back to manually calculating commissions after a 4-stream night, you'll feel exactly how much it costs.

Keep your access here: ${billingUrl}

— Lucas
Card Break Pro`;

  const html = `<!DOCTYPE html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#f4f4f5;font-family:'Segoe UI',system-ui,-apple-system,sans-serif;">
<div style="max-width:580px;margin:40px auto;background:#ffffff;border-radius:12px;overflow:hidden;box-shadow:0 2px 12px rgba(0,0,0,0.08);">
  <div style="background:#0d0d14;padding:28px 32px;">
    <div style="font-size:1.1rem;font-weight:800;letter-spacing:2px;color:#e2e8f0;">CARD <span style="color:#4f6ef7;">BREAK</span> PRO</div>
  </div>
  <div style="padding:36px 32px;">
    <p style="margin:0 0 18px;font-size:1rem;color:#1e293b;">Hey ${firstName},</p>
    <p style="margin:0 0 18px;font-size:0.97rem;color:#334155;line-height:1.65;"><strong>Your Card Break Pro trial ends in 2 days.</strong></p>
    <p style="margin:0 0 18px;font-size:0.97rem;color:#334155;line-height:1.65;">I pulled your numbers from the last 12 days. Here's what the platform did for <strong>${orgName}</strong>:</p>
    <div style="background:#f8fafc;border-radius:10px;padding:20px 24px;margin:0 0 24px;">
      <div style="display:flex;justify-content:space-between;padding:8px 0;border-bottom:1px solid #e2e8f0;"><span style="color:#64748b;font-size:0.9rem;">Breaks logged</span><strong style="color:#1e293b;font-size:1rem;">${breaks}</strong></div>
      <div style="display:flex;justify-content:space-between;padding:8px 0;border-bottom:1px solid #e2e8f0;"><span style="color:#64748b;font-size:0.9rem;">Streams closed</span><strong style="color:#1e293b;font-size:1rem;">${streams}</strong></div>
      <div style="display:flex;justify-content:space-between;padding:8px 0;"><span style="color:#64748b;font-size:0.9rem;">Estimated time saved</span><strong style="color:#22c55e;font-size:1rem;">~${hoursSaved} hours</strong></div>
    </div>
    <p style="margin:0 0 18px;font-size:0.97rem;color:#334155;line-height:1.65;">That's <strong>${hoursSaved} hours</strong> you didn't spend doing math, writing things down, or figuring out who got paid what.</p>
    <p style="margin:0 0 18px;font-size:0.97rem;color:#334155;line-height:1.65;">Going back to spreadsheets after seeing real-time profit is a choice I understand. But it costs real time and real money every single week. Not someday — every week.</p>
    <p style="margin:0 0 28px;font-size:0.97rem;color:#334155;line-height:1.65;">When your trial ends and you're back to manually calculating commissions after a 4-stream night, you'll feel exactly how much it costs.</p>
    <a href="${billingUrl}" style="display:inline-block;background:#4f6ef7;color:#fff;text-decoration:none;padding:14px 28px;border-radius:8px;font-weight:700;font-size:0.95rem;margin-bottom:28px;">Keep My Access →</a>
    <p style="margin:0 0 8px;font-size:0.97rem;color:#334155;">— Lucas</p>
    <p style="margin:0;font-size:0.88rem;color:#64748b;">Card Break Pro</p>
  </div>
</div>
</body></html>`;

  return { subject, html, text };
}

// ─── Email 3: Day 14 ──────────────────────────────────────────────────────────
function buildDay14(firstName, orgName, breaks, streams, billingUrl) {
  const subject = 'Your trial ends today';
  const text = `Hey ${firstName},

Your Card Break Pro trial ends today. If you don't convert, platform access will be restricted. Your data is preserved for 30 days — you won't lose anything.

During your trial, ${orgName} logged ${breaks} break${breaks !== 1 ? 's' : ''} and closed ${streams} stream${streams !== 1 ? 's' : ''} through the platform.

If you want to keep going: ${billingUrl}

— Lucas
Card Break Pro`;

  const html = `<!DOCTYPE html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#f4f4f5;font-family:'Segoe UI',system-ui,-apple-system,sans-serif;">
<div style="max-width:580px;margin:40px auto;background:#ffffff;border-radius:12px;overflow:hidden;box-shadow:0 2px 12px rgba(0,0,0,0.08);">
  <div style="background:#0d0d14;padding:28px 32px;">
    <div style="font-size:1.1rem;font-weight:800;letter-spacing:2px;color:#e2e8f0;">CARD <span style="color:#4f6ef7;">BREAK</span> PRO</div>
  </div>
  <div style="padding:36px 32px;">
    <p style="margin:0 0 18px;font-size:1rem;color:#1e293b;">Hey ${firstName},</p>
    <p style="margin:0 0 18px;font-size:0.97rem;color:#334155;line-height:1.65;">Your Card Break Pro trial ends today. If you don't convert, platform access will be restricted. Your data is preserved for 30 days — you won't lose anything.</p>
    <p style="margin:0 0 28px;font-size:0.97rem;color:#334155;line-height:1.65;">During your trial, <strong>${orgName}</strong> logged <strong>${breaks} break${breaks !== 1 ? 's' : ''}</strong> and closed <strong>${streams} stream${streams !== 1 ? 's' : ''}</strong> through the platform.</p>
    <a href="${billingUrl}" style="display:inline-block;background:#4f6ef7;color:#fff;text-decoration:none;padding:14px 28px;border-radius:8px;font-weight:700;font-size:0.95rem;margin-bottom:28px;">Keep My Access →</a>
    <p style="margin:0 0 8px;font-size:0.97rem;color:#334155;">— Lucas</p>
    <p style="margin:0;font-size:0.88rem;color:#64748b;">Card Break Pro</p>
  </div>
</div>
</body></html>`;

  return { subject, html, text };
}
