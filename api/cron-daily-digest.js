// CardBreakPro — Combined Daily Cron (7am UTC)
// Runs: daily digest, renewal reminders, buyer cold alerts
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

  const results = { digest: { sent: [], skipped: [], errors: [] }, renewal: { sent: [], skipped: [], errors: [] }, buyerAlerts: { fired: 0 } };

  await Promise.all([
    runDailyDigest(sb, results.digest),
    runRenewalReminders(sb, results.renewal),
    runBuyerAlerts(sb, results.buyerAlerts)
  ]);

  return res.status(200).json({ message: 'Done', results });
};

// ── Daily Digest ──────────────────────────────────────────────────────────────

async function runDailyDigest(sb, results) {
  try {
    const now = new Date();
    const todayUTC = now.toISOString().slice(0, 10);
    const currentTimeStr = String(now.getUTCHours()).padStart(2, '0') + ':' + String(now.getUTCMinutes()).padStart(2, '0');

    const { data: prefs, error: prefsErr } = await sb
      .from('notification_preferences')
      .select('user_id, organization_id, daily_digest_time, notify_daily_digest, email_notifications_enabled, last_digest_sent')
      .eq('notify_daily_digest', true)
      .eq('email_notifications_enabled', true)
      .or(`last_digest_sent.is.null,last_digest_sent.lt.${todayUTC}`);

    if (prefsErr || !prefs || prefs.length === 0) return;

    for (const pref of prefs) {
      try {
        const { data: profile } = await sb.from('profiles').select('role, display_name, org_id').eq('id', pref.user_id).maybeSingle();
        if (!profile || profile.role !== 'owner') continue;

        const { data: sub } = await sb.from('subscriptions').select('tier').eq('org_id', profile.org_id || pref.organization_id).maybeSingle();
        if (sub?.tier === 'exempt') { results.skipped.push((profile.org_id || pref.organization_id) + ':exempt'); continue; }

        const digestTime = (pref.daily_digest_time || '08:30').slice(0, 5);
        if (digestTime !== currentTimeStr) continue;

        const orgId = profile.org_id || pref.organization_id;
        if (!orgId) continue;

        const yesterday = new Date(now);
        yesterday.setUTCDate(yesterday.getUTCDate() - 1);
        const yesterdayStr = yesterday.toISOString().slice(0, 10);
        const stats = await compileStats(sb, orgId, yesterdayStr + 'T00:00:00.000Z', yesterdayStr + 'T23:59:59.999Z');

        const { data: authUser } = await sb.auth.admin.getUserById(pref.user_id);
        const ownerEmail = authUser?.user?.email;
        if (!ownerEmail) { results.skipped.push(pref.user_id + ':no-email'); continue; }

        const firstName = (profile.display_name || '').split(' ')[0] || 'there';
        const { data: org } = await sb.from('organizations').select('name').eq('id', orgId).maybeSingle();
        const dateLabel = yesterday.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' });

        await sendEmail({
          to: ownerEmail,
          subject: `Your CardBreakPro daily summary — ${dateLabel}`,
          html: buildDigestHtml(firstName, org?.name || 'your operation', dateLabel, stats, APP_URL + '/dashboard'),
          text: buildDigestText(firstName, org?.name || 'your operation', dateLabel, stats, APP_URL + '/dashboard')
        });

        await sb.from('notification_preferences').update({ last_digest_sent: todayUTC, updated_at: new Date().toISOString() }).eq('user_id', pref.user_id);
        results.sent.push({ user_id: pref.user_id, org_id: orgId });
      } catch (innerErr) {
        results.errors.push({ user_id: pref.user_id, error: innerErr.message });
      }
    }
  } catch (err) {
    console.error('Daily digest fatal:', err);
  }
}

// ── Renewal Reminders ─────────────────────────────────────────────────────────

async function runRenewalReminders(sb, results) {
  try {
    const now = new Date();
    const { data: subs } = await sb
      .from('subscriptions')
      .select('org_id, user_id, tier, status, current_period_end, renewal_reminder_7d_sent, renewal_reminder_3d_sent')
      .neq('tier', 'exempt')
      .eq('status', 'active')
      .eq('cancel_at_period_end', true);

    if (!subs || subs.length === 0) return;

    for (const sub of subs) {
      try {
        if (!sub.current_period_end) { results.skipped.push(sub.org_id + ':no-end-date'); continue; }
        const renewalDate = new Date(sub.current_period_end);
        const daysUntil = Math.round((renewalDate - now) / (1000 * 60 * 60 * 24));
        let reminderDay = null;
        if (daysUntil === 7 && !sub.renewal_reminder_7d_sent) reminderDay = 7;
        else if (daysUntil === 3 && !sub.renewal_reminder_3d_sent) reminderDay = 3;
        if (!reminderDay) { results.skipped.push(sub.org_id); continue; }

        const { data: owner } = await sb.from('profiles').select('id, display_name').eq('org_id', sub.org_id).eq('role', 'owner').maybeSingle();
        if (!owner) { results.skipped.push(sub.org_id + ':no-owner'); continue; }

        const { data: prefs } = await sb.from('notification_preferences').select('*').eq('user_id', owner.id).maybeSingle();
        const renewalDateStr = renewalDate.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });
        const tierPrice = TIER_PRICES[sub.tier] || '$0.00/mo';
        const tierName = sub.tier ? (sub.tier.charAt(0).toUpperCase() + sub.tier.slice(1)) : 'Plan';
        const title = `Your subscription renews in ${reminderDay} days`;
        const body  = `Your ${tierName} plan renews on ${renewalDateStr} for ${tierPrice}. Auto-renew is currently off.`;

        if (prefs?.in_app_notifications_enabled !== false) {
          await sb.from('notifications').insert({ organization_id: sub.org_id, user_id: owner.id, type: 'renewal_reminder', title, body, action_url: APP_URL + '/billing' });
        }

        if (prefs?.email_notifications_enabled !== false) {
          const { data: authUser } = await sb.auth.admin.getUserById(owner.id);
          const ownerEmail = authUser?.user?.email;
          if (ownerEmail) {
            const firstName = (owner.display_name || '').split(' ')[0] || 'there';
            await sendEmail({
              to: ownerEmail,
              subject: `Your CardBreakPro subscription ${reminderDay === 7 ? 'renews in 7 days' : 'renews in 3 days — last reminder'}`,
              html: buildRenewalHtml(firstName, reminderDay, tierName, renewalDateStr, tierPrice, APP_URL + '/billing'),
              text: `Hey ${firstName},\n\nYour ${tierName} plan renews in ${reminderDay} day${reminderDay !== 1 ? 's' : ''} on ${renewalDateStr} for ${tierPrice}.\n\nAuto-renew is off. Update your payment: ${APP_URL}/billing\n\n— Lucas\nCard Break Pro`
            });
          }
        }

        const flagField = reminderDay === 7 ? 'renewal_reminder_7d_sent' : 'renewal_reminder_3d_sent';
        await sb.from('subscriptions').update({ [flagField]: true }).eq('org_id', sub.org_id);
        results.sent.push({ org_id: sub.org_id, reminder_day: reminderDay });
      } catch (innerErr) {
        results.errors.push({ org_id: sub.org_id, error: innerErr.message });
      }
    }
  } catch (err) {
    console.error('Renewal reminders fatal:', err);
  }
}

// ── Buyer Cold Alerts ─────────────────────────────────────────────────────────

async function runBuyerAlerts(sb, results) {
  try {
    const twentyOneDaysAgo = new Date();
    twentyOneDaysAgo.setDate(twentyOneDaysAgo.getDate() - 21);
    const coldDate = twentyOneDaysAgo.toISOString().split('T')[0];

    const { data: coldBuyers, error } = await sb.from('buyers')
      .select('id, organization_id, username, total_spent')
      .eq('last_purchase_date', coldDate);

    if (error || !coldBuyers || coldBuyers.length === 0) return;

    const byOrg = {};
    for (const buyer of coldBuyers) {
      if (!byOrg[buyer.organization_id]) byOrg[buyer.organization_id] = [];
      byOrg[buyer.organization_id].push(buyer);
    }

    for (const [orgId, buyers] of Object.entries(byOrg)) {
      try {
        const { data: sub } = await sb.from('subscriptions').select('tier').eq('org_id', orgId).maybeSingle();
        if (sub?.tier === 'exempt') continue;

        const { data: top20 } = await sb.from('buyers').select('id').eq('organization_id', orgId).order('total_spent', { ascending: false }).limit(20);
        const top20Ids = new Set((top20 || []).map(b => b.id));

        const { data: owner } = await sb.from('profiles').select('id').eq('org_id', orgId).eq('role', 'owner').maybeSingle();
        if (!owner) continue;

        for (const buyer of buyers) {
          if (!top20Ids.has(buyer.id)) continue;
          const spent = parseFloat(buyer.total_spent || 0).toLocaleString('en-US', { style: 'currency', currency: 'USD' });
          await sb.from('notifications').insert({
            organization_id: orgId, user_id: owner.id, type: 'buyer_cold',
            title: 'A top buyer went cold',
            body: `@${buyer.username} hasn't purchased in over 20 days. They previously spent ${spent} with you.`,
            action_url: APP_URL + '/dashboard'
          }).catch(() => {});
          results.fired++;
        }
      } catch (e) {
        console.error('buyer alert org error:', orgId, e);
      }
    }
  } catch (err) {
    console.error('Buyer alerts fatal:', err);
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

async function compileStats(sb, orgId, dayStart, dayEnd) {
  const { data: streams } = await sb.from('streams').select('id, final_sales, net_profit, break_count').eq('org_id', orgId).gte('closed_at', dayStart).lte('closed_at', dayEnd).eq('status', 'closed');
  const closedStreams = streams || [];
  const streamsRun = closedStreams.length;
  const totalRevenue = closedStreams.reduce((s, st) => s + (parseFloat(st.final_sales) || 0), 0);
  const totalProfit  = closedStreams.reduce((s, st) => s + (parseFloat(st.net_profit) || 0), 0);
  const totalBreaks  = closedStreams.reduce((s, st) => s + (st.break_count || 0), 0);

  let topBreaker = null;
  if (streamsRun > 0) {
    const { data: breakData } = await sb.from('breaks').select('breaker_id, revenue').in('stream_id', closedStreams.map(st => st.id));
    if (breakData && breakData.length > 0) {
      const byBreaker = {};
      for (const b of breakData) { if (b.breaker_id) byBreaker[b.breaker_id] = (byBreaker[b.breaker_id] || 0) + (parseFloat(b.revenue) || 0); }
      const topId = Object.entries(byBreaker).sort((a, b) => b[1] - a[1])[0];
      if (topId) {
        const { data: bp } = await sb.from('profiles').select('display_name').eq('id', topId[0]).maybeSingle();
        topBreaker = { name: bp?.display_name || 'Unknown', revenue: topId[1] };
      }
    }
  }

  const { data: lowProducts } = await sb.from('products').select('name, current_stock').eq('org_id', orgId).lte('current_stock', 3).eq('is_active', true);
  const { data: pendingSort } = await sb.from('streams').select('id').eq('org_id', orgId).eq('status', 'closed').neq('sort_status', 'completed');

  return { streamsRun, totalRevenue, totalProfit, totalBreaks, topBreaker, lowProducts: lowProducts || [], pendingSort: pendingSort ? pendingSort.length : 0 };
}

function fmt(n) { return '$' + (parseFloat(n) || 0).toFixed(2); }
function escHtml(str) { return String(str || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }

function buildDigestText(firstName, orgName, dateLabel, stats, dashUrl) {
  const noStreams = stats.streamsRun === 0;
  const lines = [`Hey ${firstName},`, '', `Here is what your operation did yesterday${noStreams ? ' — no streams ran.' : '.'}`, ''];
  if (!noStreams) {
    lines.push('Yesterday — ' + dateLabel);
    lines.push(`  Revenue:   ${fmt(stats.totalRevenue)}`);
    lines.push(`  Profit:    ${fmt(stats.totalProfit)}`);
    lines.push(`  Streams:   ${stats.streamsRun}`);
    lines.push(`  Breaks:    ${stats.totalBreaks}`);
    if (stats.topBreaker) lines.push(`  Top Breaker: ${stats.topBreaker.name} (${fmt(stats.topBreaker.revenue)})`);
    lines.push('');
  }
  if (stats.lowProducts.length > 0) { lines.push('Low Inventory:'); for (const p of stats.lowProducts) lines.push(`  • ${p.name} — ${p.current_stock} left`); lines.push(''); }
  if (stats.pendingSort > 0) { lines.push(`Sort Queue: ${stats.pendingSort} stream${stats.pendingSort !== 1 ? 's' : ''} pending.`); lines.push(''); }
  lines.push(dashUrl, '', '— Lucas', 'Card Break Pro');
  return lines.join('\n');
}

function buildDigestHtml(firstName, orgName, dateLabel, stats, dashUrl) {
  const noStreams = stats.streamsRun === 0;
  const profitColor = stats.totalProfit >= 0 ? '#22c55e' : '#ef4444';
  let statsRows = '';
  if (!noStreams) {
    statsRows = `<div style="background:#f8fafc;border-radius:10px;padding:16px 20px;margin:0 0 20px;"><div style="font-size:0.7rem;font-weight:700;color:#64748b;text-transform:uppercase;letter-spacing:0.5px;margin-bottom:12px;">${escHtml(dateLabel)}</div><div style="display:flex;justify-content:space-between;padding:7px 0;border-bottom:1px solid #e2e8f0;"><span style="color:#64748b;font-size:0.88rem;">Revenue</span><strong style="color:#1e293b;">${fmt(stats.totalRevenue)}</strong></div><div style="display:flex;justify-content:space-between;padding:7px 0;border-bottom:1px solid #e2e8f0;"><span style="color:#64748b;font-size:0.88rem;">Profit</span><strong style="color:${profitColor};">${fmt(stats.totalProfit)}</strong></div><div style="display:flex;justify-content:space-between;padding:7px 0;border-bottom:1px solid #e2e8f0;"><span style="color:#64748b;font-size:0.88rem;">Streams run</span><strong style="color:#1e293b;">${stats.streamsRun}</strong></div><div style="display:flex;justify-content:space-between;padding:7px 0;""><span style="color:#64748b;font-size:0.88rem;">Breaks</span><strong style="color:#1e293b;">${stats.totalBreaks}</strong></div>${stats.topBreaker ? `<div style="display:flex;justify-content:space-between;padding:7px 0;"><span style="color:#64748b;font-size:0.88rem;">Top breaker</span><strong style="color:#4f6ef7;">${escHtml(stats.topBreaker.name)} · ${fmt(stats.topBreaker.revenue)}</strong></div>` : ''}</div>`;
  }
  let alertRows = stats.lowProducts.length > 0 ? `<div style="background:#fffbeb;border:1px solid #fbbf24;border-radius:10px;padding:14px 18px;margin:0 0 16px;"><div style="font-size:0.72rem;font-weight:700;color:#b45309;text-transform:uppercase;margin-bottom:8px;">Low Inventory</div>${stats.lowProducts.map(p => `<div style="font-size:0.88rem;color:#1e293b;padding:3px 0;">⚠ ${escHtml(p.name)} — <strong>${p.current_stock}</strong> left</div>`).join('')}</div>` : '';
  let sortRow = stats.pendingSort > 0 ? `<div style="background:#eff6ff;border:1px solid #93c5fd;border-radius:10px;padding:14px 18px;margin:0 0 20px;"><div style="font-size:0.72rem;font-weight:700;color:#1d4ed8;text-transform:uppercase;margin-bottom:4px;">Sort Queue</div><div style="font-size:0.88rem;color:#1e293b;">${stats.pendingSort} stream${stats.pendingSort !== 1 ? 's' : ''} pending sort.</div></div>` : '';
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head><body style="margin:0;padding:0;background:#f4f4f5;font-family:'Segoe UI',system-ui,sans-serif;"><div style="max-width:560px;margin:40px auto;background:#ffffff;border-radius:12px;overflow:hidden;box-shadow:0 2px 12px rgba(0,0,0,0.08);"><div style="background:#0d0d14;padding:24px 28px;"><div style="font-size:1rem;font-weight:800;letter-spacing:2px;color:#e2e8f0;">CARD <span style="color:#4f6ef7;">BREAK</span> PRO</div></div><div style="padding:32px 28px;"><p style="margin:0 0 6px;font-size:1rem;color:#1e293b;">Hey ${escHtml(firstName)},</p><p style="margin:0 0 20px;font-size:0.9rem;color:#64748b;">${noStreams ? 'No streams ran yesterday for ' + escHtml(orgName) + '.' : 'Here is what ' + escHtml(orgName) + ' did yesterday.'}</p>${statsRows}${alertRows}${sortRow}<a href="${dashUrl}" style="display:inline-block;background:#4f6ef7;color:#fff;text-decoration:none;padding:12px 24px;border-radius:8px;font-weight:700;font-size:0.9rem;margin-bottom:24px;">Open Dashboard →</a><p style="margin:0 0 4px;font-size:0.88rem;color:#334155;">— Lucas</p><p style="margin:0;font-size:0.82rem;color:#94a3b8;">Card Break Pro</p></div></div></body></html>`;
}

function buildRenewalHtml(name, days, tierName, renewalDate, price, billingUrl) {
  const urgencyColor = days <= 3 ? '#ef4444' : '#f59e0b';
  const urgencyBg    = days <= 3 ? '#fef2f2' : '#fffbeb';
  const urgencyBorder = days <= 3 ? '#fca5a5' : '#fbbf24';
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head><body style="margin:0;padding:0;background:#f4f4f5;font-family:'Segoe UI',system-ui,sans-serif;"><div style="max-width:560px;margin:40px auto;background:#ffffff;border-radius:12px;overflow:hidden;box-shadow:0 2px 12px rgba(0,0,0,0.08);"><div style="background:#0d0d14;padding:24px 28px;"><div style="font-size:1rem;font-weight:800;letter-spacing:2px;color:#e2e8f0;">CARD <span style="color:#4f6ef7;">BREAK</span> PRO</div></div><div style="padding:32px 28px;"><p style="margin:0 0 16px;font-size:1rem;color:#1e293b;">Hey ${escHtml(name)},</p><div style="background:${urgencyBg};border:1px solid ${urgencyBorder};border-radius:10px;padding:16px 20px;margin-bottom:20px;"><div style="font-size:0.75rem;font-weight:700;color:${urgencyColor};text-transform:uppercase;letter-spacing:0.5px;margin-bottom:6px;">Renewal in ${days} day${days !== 1 ? 's' : ''}</div><div style="font-size:1.05rem;font-weight:800;color:#1e293b;">${escHtml(tierName)} Plan</div><div style="font-size:0.9rem;color:#334155;margin-top:4px;">${escHtml(renewalDate)} · ${escHtml(price)}</div></div><p style="margin:0 0 24px;font-size:0.9rem;color:#334155;line-height:1.65;"><strong>Auto-renew is currently off.</strong> Update your payment method before ${escHtml(renewalDate)} to avoid interruption.</p><a href="${billingUrl}" style="display:inline-block;background:#4f6ef7;color:#fff;text-decoration:none;padding:12px 24px;border-radius:8px;font-weight:700;font-size:0.9rem;">Update Payment Method →</a><p style="margin:28px 0 0;font-size:0.85rem;color:#94a3b8;">— Lucas · Card Break Pro</p></div></div></body></html>`;
}
