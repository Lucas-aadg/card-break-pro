// CardBreakPro — Stream Closed Notification (Trigger 1)
// POST /api/notify-stream-closed
// Called server-side after a stream status changes to 'closed'.
// Notifies all sorters in the org via in-app + email.

const { createClient } = require('@supabase/supabase-js');
const { sendEmail } = require('./send-email');

const APP_URL = process.env.APP_URL || 'https://cardbreakpro.com';

module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).end();

  const { stream_id, stream_key, break_count, org_id } = req.body || {};
  if (!org_id || !stream_key) return res.status(400).json({ error: 'org_id and stream_key required' });

  const sb = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY
  );

  // Get all sorters in this org
  const { data: sorters } = await sb
    .from('profiles')
    .select('id, display_name')
    .eq('org_id', org_id)
    .eq('role', 'sorter');

  if (!sorters || sorters.length === 0) {
    return res.status(200).json({ sent: 0, reason: 'no sorters' });
  }

  const sortUrl = APP_URL + '/sorter';
  const breaks = parseInt(break_count, 10) || 0;
  const breakWord = breaks === 1 ? 'break needs' : 'breaks need';
  const title = 'New stream ready to sort';
  const body = `${stream_key} just closed. ${breaks} ${breakWord} sorting. Oldest stream is always first in your queue.`;
  let sent = 0;

  for (const sorter of sorters) {
    // Load preferences (defaults: all enabled)
    const { data: prefs } = await sb
      .from('notification_preferences')
      .select('*')
      .eq('user_id', sorter.id)
      .maybeSingle();

    const inApp  = prefs ? prefs.in_app_notifications_enabled  : true;
    const email  = prefs ? prefs.email_notifications_enabled   : true;
    const closed = prefs ? prefs.notify_stream_closed          : true;
    if (!closed) continue;

    if (inApp) {
      await sb.from('notifications').insert({
        organization_id: org_id,
        user_id: sorter.id,
        type: 'stream_closed',
        title,
        body,
        action_url: sortUrl
      });
    }

    if (email) {
      const { data: authUser } = await sb.auth.admin.getUserById(sorter.id);
      const toEmail = authUser?.user?.email;
      if (toEmail) {
        const firstName = (sorter.display_name || '').split(' ')[0] || 'there';
        try {
          await sendEmail({
            to: toEmail,
            subject: `New stream ready to sort — ${stream_key}`,
            html: buildStreamClosedHtml(firstName, stream_key, breaks, sortUrl),
            text: buildStreamClosedText(firstName, stream_key, breaks, sortUrl)
          });
        } catch (e) {
          console.error('Email send error (stream closed):', e.message);
        }
      }
    }
    sent++;
  }

  return res.status(200).json({ sent });
};

function buildStreamClosedText(name, streamKey, breaks, sortUrl) {
  return `Hey ${name},

${streamKey} just closed. ${breaks} ${breaks === 1 ? 'break needs' : 'breaks need'} sorting.

Oldest stream is always first in your queue — start here:
${sortUrl}

— Card Break Pro`;
}

function buildStreamClosedHtml(name, streamKey, breaks, sortUrl) {
  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#f4f4f5;font-family:'Segoe UI',system-ui,-apple-system,sans-serif;">
<div style="max-width:560px;margin:40px auto;background:#ffffff;border-radius:12px;overflow:hidden;box-shadow:0 2px 12px rgba(0,0,0,0.08);">
  <div style="background:#0d0d14;padding:24px 28px;">
    <div style="font-size:1rem;font-weight:800;letter-spacing:2px;color:#e2e8f0;">CARD <span style="color:#4f6ef7;">BREAK</span> PRO</div>
  </div>
  <div style="padding:32px 28px;">
    <p style="margin:0 0 16px;font-size:1rem;color:#1e293b;">Hey ${escHtml(name)},</p>
    <p style="margin:0 0 16px;font-size:0.97rem;color:#334155;line-height:1.65;">
      <strong>${escHtml(streamKey)}</strong> just closed.
      <strong>${breaks} ${breaks === 1 ? 'break needs' : 'breaks need'} sorting.</strong>
    </p>
    <p style="margin:0 0 24px;font-size:0.9rem;color:#64748b;">Oldest stream is always first in your queue.</p>
    <a href="${sortUrl}" style="display:inline-block;background:#4f6ef7;color:#fff;text-decoration:none;padding:12px 24px;border-radius:8px;font-weight:700;font-size:0.9rem;">Go to Sort Queue →</a>
    <p style="margin:28px 0 0;font-size:0.85rem;color:#94a3b8;">— Card Break Pro</p>
  </div>
</div>
</body></html>`;
}

function escHtml(str) {
  return String(str || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}
