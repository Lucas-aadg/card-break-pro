// CardBreakPro — Shift Reminder Cron Job (Trigger 2 / Task 5)
// Vercel Cron: runs every 5 minutes (*/5 * * * *)
// Finds shifts starting in 25–35 minutes, sends reminder, marks reminder_sent=true.

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

  const now = new Date();
  // Window: shifts starting 25–35 minutes from now
  const windowStart = new Date(now.getTime() + 25 * 60 * 1000);
  const windowEnd   = new Date(now.getTime() + 35 * 60 * 1000);

  const results = { sent: [], skipped: [], errors: [] };

  try {
    // Shifts in the reminder window that haven't been reminded yet
    // scheduled_start is stored as a full ISO timestamp
    const { data: shifts, error: shiftErr } = await sb
      .from('schedules')
      .select('id, org_id, breaker_id, sorter_id, stream_key, scheduled_start, channel_id')
      .eq('reminder_sent', false)
      .neq('status', 'completed')
      .neq('status', 'cancelled')
      .gte('scheduled_start', windowStart.toISOString())
      .lte('scheduled_start', windowEnd.toISOString());

    if (shiftErr) throw new Error('Schedules query failed: ' + shiftErr.message);
    if (!shifts || shifts.length === 0) {
      return res.status(200).json({ message: 'No upcoming shifts in window', results });
    }

    for (const shift of shifts) {
      try {
        const userId = shift.breaker_id || shift.sorter_id;
        if (!userId) { results.skipped.push(shift.id + ':no-user'); continue; }

        // Get channel name if available
        let channelName = 'your channel';
        if (shift.channel_id) {
          const { data: ch } = await sb.from('channels').select('name').eq('id', shift.channel_id).maybeSingle();
          if (ch?.name) channelName = ch.name;
        }

        // Load preferences
        const { data: prefs } = await sb
          .from('notification_preferences')
          .select('*')
          .eq('user_id', userId)
          .maybeSingle();

        const inApp = prefs ? prefs.in_app_notifications_enabled : true;
        const email = prefs ? prefs.email_notifications_enabled  : true;
        const reminderEnabled = prefs ? prefs.notify_shift_reminder : true;

        if (!reminderEnabled) {
          await sb.from('schedules').update({ reminder_sent: true }).eq('id', shift.id);
          results.skipped.push(shift.id + ':pref-off');
          continue;
        }

        const shiftTime = new Date(shift.scheduled_start);
        const timeStr = shiftTime.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true });
        const streamName = shift.stream_key || 'your scheduled stream';

        const { data: profile } = await sb.from('profiles').select('display_name').eq('id', userId).maybeSingle();
        const title = 'Your shift starts in 30 minutes';
        const body  = `${streamName} on ${channelName} starts at ${timeStr}. Make sure you are clocked in before you go live.`;
        const scheduleUrl = APP_URL + '/break'; // breakers go to break page; sorters go to sorter

        if (inApp) {
          const { data: orgProfile } = await sb.from('profiles').select('org_id').eq('id', userId).maybeSingle();
          await sb.from('notifications').insert({
            organization_id: orgProfile?.org_id || shift.org_id,
            user_id: userId,
            type: 'shift_reminder',
            title,
            body,
            action_url: scheduleUrl
          });
        }

        if (email) {
          const { data: authUser } = await sb.auth.admin.getUserById(userId);
          const toEmail = authUser?.user?.email;
          if (toEmail) {
            const firstName = (profile?.display_name || '').split(' ')[0] || 'there';
            await sendEmail({
              to: toEmail,
              subject: 'Your shift starts in 30 minutes',
              html: buildShiftReminderHtml(firstName, streamName, channelName, timeStr, scheduleUrl),
              text: buildShiftReminderText(firstName, streamName, channelName, timeStr, scheduleUrl)
            });
          }
        }

        // Mark as reminded to prevent duplicates
        await sb.from('schedules').update({ reminder_sent: true }).eq('id', shift.id);
        results.sent.push({ shift_id: shift.id, user_id: userId });
      } catch (innerErr) {
        results.errors.push({ shift_id: shift.id, error: innerErr.message });
        console.error('Shift reminder error for shift', shift.id, innerErr);
      }
    }

    return res.status(200).json({ message: 'Done', results });
  } catch (err) {
    console.error('Shift reminder cron fatal error:', err);
    return res.status(500).json({ error: err.message });
  }
};

function buildShiftReminderText(name, streamName, channelName, timeStr, scheduleUrl) {
  return `Hey ${name},

Your shift starts in 30 minutes.

${streamName} on ${channelName} starts at ${timeStr}.

Make sure you are clocked in before you go live.

${scheduleUrl}

— Card Break Pro`;
}

function buildShiftReminderHtml(name, streamName, channelName, timeStr, scheduleUrl) {
  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#f4f4f5;font-family:'Segoe UI',system-ui,-apple-system,sans-serif;">
<div style="max-width:560px;margin:40px auto;background:#ffffff;border-radius:12px;overflow:hidden;box-shadow:0 2px 12px rgba(0,0,0,0.08);">
  <div style="background:#0d0d14;padding:24px 28px;">
    <div style="font-size:1rem;font-weight:800;letter-spacing:2px;color:#e2e8f0;">CARD <span style="color:#4f6ef7;">BREAK</span> PRO</div>
  </div>
  <div style="padding:32px 28px;">
    <p style="margin:0 0 16px;font-size:1rem;color:#1e293b;">Hey ${escHtml(name)},</p>
    <div style="background:#eff6ff;border:1px solid #93c5fd;border-radius:10px;padding:16px 20px;margin-bottom:20px;">
      <div style="font-size:0.75rem;font-weight:700;color:#1d4ed8;text-transform:uppercase;letter-spacing:0.5px;margin-bottom:6px;">⏰ Shift Starting Soon</div>
      <div style="font-size:1.05rem;font-weight:800;color:#1e293b;">${escHtml(streamName)}</div>
      <div style="font-size:0.9rem;color:#334155;margin-top:4px;">${escHtml(channelName)} · Starts at ${escHtml(timeStr)}</div>
    </div>
    <p style="margin:0 0 24px;font-size:0.9rem;color:#334155;line-height:1.65;">
      Make sure you are clocked in before you go live.
    </p>
    <a href="${scheduleUrl}" style="display:inline-block;background:#4f6ef7;color:#fff;text-decoration:none;padding:12px 24px;border-radius:8px;font-weight:700;font-size:0.9rem;">Open App →</a>
    <p style="margin:28px 0 0;font-size:0.85rem;color:#94a3b8;">— Card Break Pro</p>
  </div>
</div>
</body></html>`;
}

function escHtml(str) {
  return String(str || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}
