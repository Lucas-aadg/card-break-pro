// CardBreakPro — Daily Operations Digest (Trigger 6 / Task 5)
// Vercel Cron: runs every minute (* * * * *)
// Checks each org's configured digest time, sends email when it matches current UTC minute.
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

  const now = new Date();
  const todayUTC = now.toISOString().slice(0, 10);
  const currentHour   = now.getUTCHours();
  const currentMinute = now.getUTCMinutes();

  // Format current time as HH:MM for comparison
  const currentTimeStr = String(currentHour).padStart(2, '0') + ':' + String(currentMinute).padStart(2, '0');

  const results = { sent: [], skipped: [], errors: [] };

  try {
    // Find owners whose digest time matches current UTC time and haven't been sent today
    const { data: prefs, error: prefsErr } = await sb
      .from('notification_preferences')
      .select('user_id, organization_id, daily_digest_time, notify_daily_digest, email_notifications_enabled, last_digest_sent')
      .eq('notify_daily_digest', true)
      .eq('email_notifications_enabled', true)
      .or(`last_digest_sent.is.null,last_digest_sent.lt.${todayUTC}`);

    if (prefsErr) throw new Error('Prefs query failed: ' + prefsErr.message);
    if (!prefs || prefs.length === 0) {
      return res.status(200).json({ message: 'No matching digest prefs', results });
    }

    for (const pref of prefs) {
      try {
        // Only owners get daily digest
        const { data: profile } = await sb
          .from('profiles')
          .select('role, display_name, org_id')
          .eq('id', pref.user_id)
          .maybeSingle();

        if (!profile || profile.role !== 'owner') continue;

        // Check if org is exempt
        const { data: sub } = await sb
          .from('subscriptions')
          .select('tier')
          .eq('org_id', profile.org_id || pref.organization_id)
          .maybeSingle();

        if (sub?.tier === 'exempt') {
          results.skipped.push((profile.org_id || pref.organization_id) + ':exempt');
          continue;
        }

        // Check if digest time matches current minute (UTC)
        const digestTime = (pref.daily_digest_time || '08:30').slice(0, 5); // "HH:MM"
        if (digestTime !== currentTimeStr) continue;

        const orgId = profile.org_id || pref.organization_id;
        if (!orgId) continue;

        // Build yesterday's date range
        const yesterday = new Date(now);
        yesterday.setUTCDate(yesterday.getUTCDate() - 1);
        const yesterdayStr = yesterday.toISOString().slice(0, 10);
        const dayStart = yesterdayStr + 'T00:00:00.000Z';
        const dayEnd   = yesterdayStr + 'T23:59:59.999Z';

        // Compile stats
        const stats = await compileStats(sb, orgId, dayStart, dayEnd);

        const { data: authUser } = await sb.auth.admin.getUserById(pref.user_id);
        const ownerEmail = authUser?.user?.email;
        if (!ownerEmail) { results.skipped.push(pref.user_id + ':no-email'); continue; }

        const firstName = (profile.display_name || '').split(' ')[0] || 'there';
        const { data: org } = await sb.from('organizations').select('name').eq('id', orgId).maybeSingle();
        const orgName = org?.name || 'your operation';

        const dateLabel = yesterday.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' });
        const subject = `Your CardBreakPro daily summary — ${dateLabel}`;

        await sendEmail({
          to: ownerEmail,
          subject,
          html: buildDigestHtml(firstName, orgName, dateLabel, stats, APP_URL + '/dashboard'),
          text: buildDigestText(firstName, orgName, dateLabel, stats, APP_URL + '/dashboard')
        });

        // Mark sent
        await sb.from('notification_preferences')
          .update({ last_digest_sent: todayUTC, updated_at: new Date().toISOString() })
          .eq('user_id', pref.user_id);

        results.sent.push({ user_id: pref.user_id, org_id: orgId, email: ownerEmail });
      } catch (innerErr) {
        results.errors.push({ user_id: pref.user_id, error: innerErr.message });
        console.error('Daily digest error for user', pref.user_id, innerErr);
      }
    }

    return res.status(200).json({ message: 'Done', results });
  } catch (err) {
    console.error('Daily digest cron fatal error:', err);
    return res.status(500).json({ error: err.message });
  }
};

async function compileStats(sb, orgId, dayStart, dayEnd) {
  // Yesterday's streams
  const { data: streams } = await sb
    .from('streams')
    .select('id, stream_key, final_sales, net_profit, break_count, status')
    .eq('org_id', orgId)
    .gte('closed_at', dayStart)
    .lte('closed_at', dayEnd)
    .eq('status', 'closed');

  const closedStreams = streams || [];
  const streamsRun = closedStreams.length;
  const totalRevenue = closedStreams.reduce((s, st) => s + (parseFloat(st.final_sales) || 0), 0);
  const totalProfit  = closedStreams.reduce((s, st) => s + (parseFloat(st.net_profit) || 0), 0);
  const totalBreaks  = closedStreams.reduce((s, st) => s + (st.break_count || 0), 0);

  // Top performing breaker by revenue yesterday
  let topBreaker = null;
  if (streamsRun > 0) {
    const streamIds = closedStreams.map(st => st.id);
    const { data: breakData } = await sb
      .from('breaks')
      .select('breaker_id, revenue')
      .in('stream_id', streamIds);

    if (breakData && breakData.length > 0) {
      const byBreaker = {};
      for (const b of breakData) {
        if (!b.breaker_id) continue;
        byBreaker[b.breaker_id] = (byBreaker[b.breaker_id] || 0) + (parseFloat(b.revenue) || 0);
      }
      const topId = Object.entries(byBreaker).sort((a, b) => b[1] - a[1])[0];
      if (topId) {
        const { data: bp } = await sb.from('profiles').select('display_name').eq('id', topId[0]).maybeSingle();
        topBreaker = { name: bp?.display_name || 'Unknown', revenue: topId[1] };
      }
    }
  }

  // Current inventory alerts (products ≤ 3)
  const { data: lowProducts } = await sb
    .from('products')
    .select('name, current_stock')
    .eq('org_id', orgId)
    .lte('current_stock', 3)
    .eq('is_active', true);

  // Sort queue: streams closed but not fully sorted
  const { data: pendingSort } = await sb
    .from('streams')
    .select('id')
    .eq('org_id', orgId)
    .eq('status', 'closed')
    .neq('sort_status', 'completed');

  return {
    streamsRun,
    totalRevenue,
    totalProfit,
    totalBreaks,
    topBreaker,
    lowProducts: lowProducts || [],
    pendingSort: pendingSort ? pendingSort.length : 0
  };
}

function fmt(n) { return '$' + (parseFloat(n) || 0).toFixed(2); }
function escHtml(str) {
  return String(str || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function buildDigestText(firstName, orgName, dateLabel, stats, dashUrl) {
  const noStreams = stats.streamsRun === 0;
  const lines = [
    `Hey ${firstName},`,
    '',
    `Here is what your operation did yesterday${noStreams ? ' — no streams ran.' : '.'}`,
    ''
  ];

  if (!noStreams) {
    lines.push('Yesterday — ' + dateLabel);
    lines.push(`  Revenue:   ${fmt(stats.totalRevenue)}`);
    lines.push(`  Profit:    ${fmt(stats.totalProfit)}`);
    lines.push(`  Streams:   ${stats.streamsRun}`);
    lines.push(`  Breaks:    ${stats.totalBreaks}`);
    if (stats.topBreaker) {
      lines.push(`  Top Breaker: ${stats.topBreaker.name} (${fmt(stats.topBreaker.revenue)})`);
    }
    lines.push('');
  }

  if (stats.lowProducts.length > 0) {
    lines.push('Low Inventory:');
    for (const p of stats.lowProducts) {
      lines.push(`  • ${p.name} — ${p.current_stock} ${p.current_stock === 1 ? 'box' : 'boxes'} left`);
    }
    lines.push('');
  }

  if (stats.pendingSort > 0) {
    lines.push(`Sort Queue: ${stats.pendingSort} stream${stats.pendingSort !== 1 ? 's' : ''} pending sort.`);
    lines.push('');
  }

  lines.push(dashUrl);
  lines.push('');
  lines.push('— Lucas');
  lines.push('Card Break Pro');
  return lines.join('\n');
}

function buildDigestHtml(firstName, orgName, dateLabel, stats, dashUrl) {
  const noStreams = stats.streamsRun === 0;
  const profitColor = stats.totalProfit >= 0 ? '#22c55e' : '#ef4444';

  let statsRows = '';
  if (!noStreams) {
    statsRows = `
      <div style="background:#f8fafc;border-radius:10px;padding:16px 20px;margin:0 0 20px;">
        <div style="font-size:0.7rem;font-weight:700;color:#64748b;text-transform:uppercase;letter-spacing:0.5px;margin-bottom:12px;">${escHtml(dateLabel)}</div>
        <div style="display:flex;justify-content:space-between;padding:7px 0;border-bottom:1px solid #e2e8f0;">
          <span style="color:#64748b;font-size:0.88rem;">Revenue</span>
          <strong style="color:#1e293b;font-size:0.95rem;">${fmt(stats.totalRevenue)}</strong>
        </div>
        <div style="display:flex;justify-content:space-between;padding:7px 0;border-bottom:1px solid #e2e8f0;">
          <span style="color:#64748b;font-size:0.88rem;">Profit</span>
          <strong style="color:${profitColor};font-size:0.95rem;">${fmt(stats.totalProfit)}</strong>
        </div>
        <div style="display:flex;justify-content:space-between;padding:7px 0;border-bottom:1px solid #e2e8f0;">
          <span style="color:#64748b;font-size:0.88rem;">Streams run</span>
          <strong style="color:#1e293b;font-size:0.95rem;">${stats.streamsRun}</strong>
        </div>
        <div style="display:flex;justify-content:space-between;padding:7px 0;${stats.topBreaker ? 'border-bottom:1px solid #e2e8f0;' : ''}">
          <span style="color:#64748b;font-size:0.88rem;">Breaks logged</span>
          <strong style="color:#1e293b;font-size:0.95rem;">${stats.totalBreaks}</strong>
        </div>
        ${stats.topBreaker ? `
        <div style="display:flex;justify-content:space-between;padding:7px 0;">
          <span style="color:#64748b;font-size:0.88rem;">Top breaker</span>
          <strong style="color:#4f6ef7;font-size:0.88rem;">${escHtml(stats.topBreaker.name)} · ${fmt(stats.topBreaker.revenue)}</strong>
        </div>` : ''}
      </div>`;
  }

  let alertRows = '';
  if (stats.lowProducts.length > 0) {
    alertRows = `
      <div style="background:#fffbeb;border:1px solid #fbbf24;border-radius:10px;padding:14px 18px;margin:0 0 16px;">
        <div style="font-size:0.72rem;font-weight:700;color:#b45309;text-transform:uppercase;letter-spacing:0.5px;margin-bottom:8px;">Low Inventory</div>
        ${stats.lowProducts.map(p =>
          `<div style="font-size:0.88rem;color:#1e293b;padding:3px 0;">⚠ ${escHtml(p.name)} — <strong>${p.current_stock} ${p.current_stock === 1 ? 'box' : 'boxes'}</strong> left</div>`
        ).join('')}
      </div>`;
  }

  let sortRow = '';
  if (stats.pendingSort > 0) {
    sortRow = `
      <div style="background:#eff6ff;border:1px solid #93c5fd;border-radius:10px;padding:14px 18px;margin:0 0 20px;">
        <div style="font-size:0.72rem;font-weight:700;color:#1d4ed8;text-transform:uppercase;letter-spacing:0.5px;margin-bottom:4px;">Sort Queue</div>
        <div style="font-size:0.88rem;color:#1e293b;">${stats.pendingSort} stream${stats.pendingSort !== 1 ? 's' : ''} pending sort.</div>
      </div>`;
  }

  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#f4f4f5;font-family:'Segoe UI',system-ui,-apple-system,sans-serif;">
<div style="max-width:560px;margin:40px auto;background:#ffffff;border-radius:12px;overflow:hidden;box-shadow:0 2px 12px rgba(0,0,0,0.08);">
  <div style="background:#0d0d14;padding:24px 28px;display:flex;align-items:center;justify-content:space-between;">
    <div style="font-size:1rem;font-weight:800;letter-spacing:2px;color:#e2e8f0;">CARD <span style="color:#4f6ef7;">BREAK</span> PRO</div>
    <div style="font-size:0.75rem;color:#64748b;">Daily Summary</div>
  </div>
  <div style="padding:32px 28px;">
    <p style="margin:0 0 6px;font-size:1rem;color:#1e293b;">Hey ${escHtml(firstName)},</p>
    <p style="margin:0 0 20px;font-size:0.9rem;color:#64748b;">
      ${noStreams ? 'No streams ran yesterday for ' + escHtml(orgName) + '.' : 'Here is what ' + escHtml(orgName) + ' did yesterday.'}
    </p>
    ${statsRows}
    ${alertRows}
    ${sortRow}
    <a href="${dashUrl}" style="display:inline-block;background:#4f6ef7;color:#fff;text-decoration:none;padding:12px 24px;border-radius:8px;font-weight:700;font-size:0.9rem;margin-bottom:24px;">Open Dashboard →</a>
    <p style="margin:0 0 4px;font-size:0.88rem;color:#334155;">— Lucas</p>
    <p style="margin:0;font-size:0.82rem;color:#94a3b8;">Card Break Pro</p>
  </div>
</div>
</body></html>`;
}
