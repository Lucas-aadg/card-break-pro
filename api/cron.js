// CardBreakPro — Consolidated Cron Handler
// Dispatch via ?type= query param:
//   trial          → trial conversion emails (day 7, 12, 14)
//   shift-reminder → 30-min shift reminders
//   daily-digest   → daily summary + renewal reminders + buyer cold alerts
//   annual-renewal → annual subscription 30-day and 7-day renewal reminders
// GasPackBreaks (tier='exempt') permanently excluded from all jobs.

const { createClient } = require('@supabase/supabase-js');
const { sendEmail } = require('./send-email');
const { CBP } = require('../shared.js');   // same timezone / period math the pages use
const APP_URL = process.env.APP_URL || 'https://cardbreakpro.com';

// ── shared per-run lookups (each job used to re-query these per org) ─────────
async function exemptOrgSet(sb) {
  const { data } = await sb.from('subscriptions').select('org_id').eq('tier', 'exempt');
  return new Set((data || []).map(s => s.org_id));
}
async function orgTimezones(sb) {
  const out = {};
  const r = await sb.from('organizations').select('id, timezone');
  if (!r.error) (r.data || []).forEach(o => { out[o.id] = o.timezone || CBP.DEFAULT_TZ; });
  return out;
}

module.exports = async (req, res) => {
  if (req.method !== 'GET' && req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const type = req.query.type;
  if (!type) return res.status(400).json({ error: 'Missing ?type= param' });

  const sb = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY
  );

  try {
    // ?mode=day|30min comes from the cron path in vercel.json so the schedule
    // and the job's assumptions can't drift apart (Hobby = daily crons only).
    const mode = String(req.query.mode || process.env.SHIFT_REMINDER_MODE || 'day') === '30min' ? '30min' : 'day';
    if (type === 'trial')             return await runTrialEmails(sb, res);
    if (type === 'shift-reminder')    return await runShiftReminders(sb, res, mode);
    if (type === 'digest')            return await runDigestOnly(sb, res, mode);   // day: send to everyone due today; 30min/hourly: at their chosen local time
    if (type === 'daily-digest')      return await runDailyDigest(sb, res);        // daily: renewals, cold alerts, slip nags (+ digest catch-up)
    if (type === 'annual-renewal')    return await runAnnualRenewalReminders(sb, res);
    if (type === 'goal-prompt')       return await runGoalPrompt(sb, res);
    if (type === 'leaderboard-reset') return await runLeaderboardReset(sb, res);
    return res.status(400).json({ error: 'Unknown type: ' + type });
  } catch (err) {
    console.error('Cron fatal error [' + type + ']:', err);
    return res.status(500).json({ error: err.message });
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// TRIAL EMAILS  (day 7, 12, 14)
// ─────────────────────────────────────────────────────────────────────────────
async function runTrialEmails(sb, res) {
  const results = { sent: [], skipped: [], errors: [] };

  const { data: subs, error: subErr } = await sb
    .from('subscriptions')
    .select('org_id, user_id, tier, status, created_at, trial_email_day7_sent, trial_email_day12_sent, trial_email_day14_sent')
    .neq('tier', 'exempt').neq('tier', 'legacy').in('status', ['active', 'trialing']);

  if (subErr) throw new Error('Subscriptions query failed: ' + subErr.message);
  if (!subs || subs.length === 0) return res.status(200).json({ message: 'No active trials', results });

  const today = new Date(); today.setHours(0, 0, 0, 0);

  for (const sub of subs) {
    try {
      const createdAt = new Date(sub.created_at); createdAt.setHours(0, 0, 0, 0);
      const daysSince = Math.round((today - createdAt) / (1000 * 60 * 60 * 24));
      let emailDay = null;
      if      (daysSince === 7  && !sub.trial_email_day7_sent)  emailDay = 7;
      else if (daysSince === 12 && !sub.trial_email_day12_sent) emailDay = 12;
      else if (daysSince === 14 && !sub.trial_email_day14_sent) emailDay = 14;
      if (!emailDay) { results.skipped.push(sub.org_id); continue; }

      const { data: owner } = await sb.from('profiles').select('id, display_name').eq('org_id', sub.org_id).eq('role', 'owner').single();
      const { data: authUser } = await sb.auth.admin.getUserById(sub.user_id || owner?.id);
      const ownerEmail = authUser?.user?.email;
      if (!ownerEmail) { results.skipped.push(sub.org_id + ':no-email'); continue; }

      const { data: org } = await sb.from('organizations').select('name').eq('id', sub.org_id).single();
      const orgName = org?.name || 'your operation';
      const firstName = (owner?.display_name || '').split(' ')[0] || 'there';

      const trialStart = sub.created_at;
      const { count: breaks } = await sb.from('breaks').select('id', { count: 'exact', head: true }).eq('org_id', sub.org_id).gte('created_at', trialStart);
      const { count: streams } = await sb.from('streams').select('id', { count: 'exact', head: true }).eq('org_id', sub.org_id).eq('status', 'closed').gte('created_at', trialStart);
      const breaksCount  = breaks  || 0;
      const streamsCount = streams || 0;
      const hoursSaved   = Math.round((breaksCount * 8) / 60 * 10) / 10;
      const billingUrl   = APP_URL + '/billing';

      const { subject, html, text } = buildTrialEmail(emailDay, firstName, orgName, breaksCount, streamsCount, hoursSaved, billingUrl);
      await sendEmail({ to: ownerEmail, subject, html, text });
      await sb.from('subscriptions').update({ ['trial_email_day' + emailDay + '_sent']: true }).eq('org_id', sub.org_id);
      results.sent.push({ org_id: sub.org_id, email_day: emailDay, to: ownerEmail });
    } catch (innerErr) {
      results.errors.push({ org_id: sub.org_id, error: innerErr.message });
    }
  }
  return res.status(200).json({ message: 'Done', results });
}

// ─────────────────────────────────────────────────────────────────────────────
// SHIFT REMINDERS  (30-min window)
// ─────────────────────────────────────────────────────────────────────────────
// Two modes, chosen by ?mode= on the cron path (fallback SHIFT_REMINDER_MODE):
//   'day'   (default) — a heads-up for every shift LATER TODAY in the org's
//                       timezone. Works on a once-a-day cron (Vercel Hobby).
//   '30min'           — the original "starts in 30 minutes" ping. Only correct
//                       when this job runs every ~5 minutes (Vercel Pro / pg_cron).
// The old code did '30min' logic on a daily cron, and treated scheduled_time as
// UTC, so it matched nothing (AUDIT BL-13). Vercel Hobby rejects any cron more
// frequent than daily at deploy time, so 'day' is the default that always works.
async function runShiftReminders(sb, res, mode) {
  mode = mode === '30min' ? '30min' : 'day';
  const now = new Date();
  const results = { mode, sent: [], skipped: [], errors: [] };

  const tzByOrg = await orgTimezones(sb);
  const exempt = await exemptOrgSet(sb);

  // Candidate rows: unreminded, still scheduled, dated yesterday..tomorrow in
  // UTC terms (covers every timezone's "today"); the precise filter is below.
  const dates = [isoDaysAgo(1), isoDaysAgo(0), isoDaysAgo(-1)];
  const { data: allShifts, error: shiftErr } = await sb
    .from('schedules')
    .select('id, org_id, breaker_id, sorter_id, stream_key, scheduled_date, scheduled_time, channel_id')
    .eq('reminder_sent', false)
    .neq('status', 'completed').neq('status', 'cancelled')
    .in('scheduled_date', dates);
  if (shiftErr) throw new Error('Schedules query failed: ' + shiftErr.message);

  const shifts = (allShifts || []).filter(function (s) {
    if (exempt.has(s.org_id)) return false;
    const tz = tzByOrg[s.org_id] || CBP.DEFAULT_TZ;
    if (mode === '30min') {
      if (!s.scheduled_time) return false;
      const t = new Date(CBP.localTimeISO(s.scheduled_date, s.scheduled_time, tz)).getTime();
      return t >= now.getTime() + 25 * 60000 && t <= now.getTime() + 35 * 60000;
    }
    if (s.scheduled_date !== CBP.dateInTz(now, tz)) return false;          // today, org-local
    if (!s.scheduled_time) return true;
    const t = new Date(CBP.localTimeISO(s.scheduled_date, s.scheduled_time, tz)).getTime();
    return t > now.getTime() - 60 * 60000;                                  // hasn't started >1h ago
  });
  if (shifts.length === 0) return res.status(200).json({ message: 'No shifts to remind', results });

  // One lookup each for prefs, profiles and channels instead of per shift
  const userIds = [...new Set(shifts.map(s => s.breaker_id || s.sorter_id).filter(Boolean))];
  const chIds   = [...new Set(shifts.map(s => s.channel_id).filter(Boolean))];
  const [prefRes, profRes, chRes] = await Promise.all([
    sb.from('notification_preferences').select('*').in('user_id', userIds),
    sb.from('profiles').select('id, display_name, org_id').in('id', userIds),
    chIds.length ? sb.from('channels').select('id, name').in('id', chIds) : Promise.resolve({ data: [] })
  ]);
  const prefsBy = {}; (prefRes.data || []).forEach(p => { prefsBy[p.user_id] = p; });
  const profBy  = {}; (profRes.data || []).forEach(p => { profBy[p.id] = p; });
  const chBy    = {}; (chRes.data || []).forEach(c => { chBy[c.id] = c.name; });

  for (const shift of shifts) {
    try {
      const userId = shift.breaker_id || shift.sorter_id;
      if (!userId) { results.skipped.push(shift.id + ':no-user'); continue; }
      const prefs = prefsBy[userId];
      const inApp = prefs ? prefs.in_app_notifications_enabled !== false : true;
      const emailEnabled = prefs ? prefs.email_notifications_enabled !== false : true;
      const reminderEnabled = prefs ? prefs.notify_shift_reminder !== false : true;
      if (!reminderEnabled) {
        await sb.from('schedules').update({ reminder_sent: true }).eq('id', shift.id);
        results.skipped.push(shift.id + ':pref-off'); continue;
      }

      const tz = tzByOrg[shift.org_id] || CBP.DEFAULT_TZ;
      const channelName = (shift.channel_id && chBy[shift.channel_id]) || 'your channel';
      const timeStr = shift.scheduled_time
        ? new Date(CBP.localTimeISO(shift.scheduled_date, shift.scheduled_time, tz)).toLocaleTimeString('en-US', { timeZone: tz, hour: 'numeric', minute: '2-digit', hour12: true })
        : null;
      const streamName = shift.stream_key || 'your scheduled stream';
      const profile = profBy[userId] || {};
      const isSorter = !!shift.sorter_id && !shift.breaker_id;
      const title = mode === '30min' ? 'Your shift starts in 30 minutes' : 'You have a shift today' + (timeStr ? ' at ' + timeStr : '');
      const body  = mode === '30min'
        ? streamName + ' on ' + channelName + ' starts at ' + timeStr + '. Make sure you are clocked in before you go live.'
        : (isSorter ? 'Sorting shift' : streamName + ' on ' + channelName) + (timeStr ? ' at ' + timeStr : '') + '. Clock in when you start.';
      const link = APP_URL + (isSorter ? '/sorter' : '/break');

      if (inApp) {
        const ins = await sb.from('notifications').insert({ organization_id: profile.org_id || shift.org_id, user_id: userId, type: 'shift_reminder', title, body, action_url: link });
        if (ins.error) throw ins.error;
      }
      if (emailEnabled) {
        const { data: authUser } = await sb.auth.admin.getUserById(userId);
        const toEmail = authUser?.user?.email;
        if (toEmail) {
          const firstName = (profile.display_name || '').split(' ')[0] || 'there';
          await sendEmail({
            to: toEmail,
            subject: title,
            html: buildShiftReminderHtml(firstName, streamName, channelName, timeStr || 'today'),
            text: 'Hey ' + firstName + ',\n\n' + title + '.\n\n' + body + '\n\n— Card Break Pro'
          });
        }
      }

      await sb.from('schedules').update({ reminder_sent: true }).eq('id', shift.id);
      results.sent.push({ shift_id: shift.id, user_id: userId });
    } catch (innerErr) {
      results.errors.push({ shift_id: shift.id, error: innerErr.message });
    }
  }
  return res.status(200).json({ message: 'Done', results });
}

// ─────────────────────────────────────────────────────────────────────────────
// DAILY DIGEST  (digest + renewal reminders + buyer cold alerts)
// ─────────────────────────────────────────────────────────────────────────────
// Single plan: "standard" — $99/mo. Legacy tiers kept so existing subscribers
// still get correctly-priced reminder emails.
const TIER_PRICES = { standard: '$99.00/mo', starter: '$129.99/mo', pro: '$399.99/mo', empire: '$999.99/mo', legacy: '$250.00/mo' };
const TIER_NAMES  = { standard: 'CardBreakPro' };

function tierDisplayName(tier) {
  if (!tier) return 'Plan';
  return TIER_NAMES[tier] || (tier.charAt(0).toUpperCase() + tier.slice(1));
}

async function runDigestOnly(sb, res, mode) {
  const results = { mode: mode || 'day', digest: { sent: [], skipped: [], errors: [] } };
  // On a once-a-day cron the owner's chosen time can't be honoured (the job
  // only runs at one fixed hour), so 'day' sends to everyone not yet sent today.
  await runDigestEmails(sb, results.digest, { anyTime: (mode || 'day') === 'day' });
  return res.status(200).json({ message: 'Done', results });
}

async function runDailyDigest(sb, res) {
  const results = { digest: { sent: [], skipped: [], errors: [] }, renewal: { sent: [], skipped: [], errors: [] }, buyerAlerts: { fired: 0, orgs: 0, errors: [] }, slipNags: { fired: 0, streams: 0, errors: [] } };
  await Promise.all([
    runDigestEmails(sb, results.digest),
    runRenewalReminders(sb, results.renewal),
    runBuyerAlerts(sb, results.buyerAlerts),
    runSlipNags(sb, results.slipNags)
  ]);
  return res.status(200).json({ message: 'Done', results });
}

// Sends once per org-local day, the first time the job runs at/after the
// owner's chosen digest time (org timezone). The old check required the cron
// to run in the exact same minute as the setting — on a daily cron that meant
// it effectively never sent (AUDIT AB-4).
async function runDigestEmails(sb, results, opts) {
  const anyTime = !!(opts && opts.anyTime);
  const now = new Date();

  const { data: prefs, error: prefsErr } = await sb.from('notification_preferences')
    .select('user_id, organization_id, daily_digest_time, notify_daily_digest, email_notifications_enabled, last_digest_sent')
    .eq('notify_daily_digest', true).eq('email_notifications_enabled', true);
  if (prefsErr || !prefs || prefs.length === 0) return;

  const userIds = prefs.map(p => p.user_id);
  const [profRes, exempt, tzByOrg] = await Promise.all([
    sb.from('profiles').select('id, role, display_name, org_id').in('id', userIds),
    exemptOrgSet(sb), orgTimezones(sb)
  ]);
  const profBy = {}; (profRes.data || []).forEach(p => { profBy[p.id] = p; });
  const orgNames = {};
  const orgIds = [...new Set(Object.values(profBy).map(p => p.org_id).filter(Boolean))];
  if (orgIds.length) { const { data: orgs } = await sb.from('organizations').select('id, name').in('id', orgIds); (orgs || []).forEach(o => { orgNames[o.id] = o.name; }); }

  for (const pref of prefs) {
    try {
      const profile = profBy[pref.user_id];
      if (!profile || profile.role !== 'owner') continue;
      const orgId = profile.org_id || pref.organization_id;
      if (!orgId) continue;
      if (exempt.has(orgId)) { results.skipped.push(orgId + ':exempt'); continue; }

      const tz = tzByOrg[orgId] || CBP.DEFAULT_TZ;
      const localToday = CBP.dateInTz(now, tz);
      if (pref.last_digest_sent && pref.last_digest_sent >= localToday) continue;          // already sent today
      const digestTime = (pref.daily_digest_time || '08:30').slice(0, 5);
      const dueAt = new Date(CBP.localTimeISO(localToday, digestTime, tz)).getTime();
      if (!anyTime && now.getTime() < dueAt) { results.skipped.push(pref.user_id + ':not-yet'); continue; } // before their chosen time

      const yesterday = CBP.addDays(localToday, -1);
      const stats = await compileStats(sb, orgId, CBP.localMidnightISO(yesterday, tz), CBP.localMidnightISO(localToday, tz));
      const { data: authUser } = await sb.auth.admin.getUserById(pref.user_id);
      const ownerEmail = authUser?.user?.email;
      if (!ownerEmail) { results.skipped.push(pref.user_id + ':no-email'); continue; }
      const firstName = (profile.display_name || '').split(' ')[0] || 'there';
      const dateLabel = new Date(yesterday + 'T12:00:00Z').toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', timeZone: 'UTC' });
      await sendEmail({ to: ownerEmail, subject: 'Your CardBreakPro daily summary — ' + dateLabel, html: buildDigestHtml(firstName, orgNames[orgId] || 'your operation', dateLabel, stats, APP_URL + '/dashboard'), text: buildDigestText(firstName, orgNames[orgId] || 'your operation', dateLabel, stats, APP_URL + '/dashboard') });
      await sb.from('notification_preferences').update({ last_digest_sent: localToday, updated_at: new Date().toISOString() }).eq('user_id', pref.user_id);
      results.sent.push({ user_id: pref.user_id, org_id: orgId });
    } catch (innerErr) { results.errors.push({ user_id: pref.user_id, error: innerErr.message }); }
  }
}

async function runRenewalReminders(sb, results) {
  const now = new Date();
  const { data: subs } = await sb.from('subscriptions').select('org_id, user_id, tier, status, current_period_end, renewal_reminder_7d_sent, renewal_reminder_3d_sent').neq('tier', 'exempt').eq('status', 'active').eq('cancel_at_period_end', true);
  if (!subs || subs.length === 0) return;
  for (const sub of subs) {
    try {
      if (!sub.current_period_end) { results.skipped.push(sub.org_id + ':no-end-date'); continue; }
      const renewalDate = new Date(sub.current_period_end);
      const daysUntil = Math.round((renewalDate - now) / (1000 * 60 * 60 * 24));
      // Windows, not exact days — a missed/failed run no longer skips a reminder forever
      let reminderDay = null;
      if (daysUntil <= 3 && daysUntil >= 0 && !sub.renewal_reminder_3d_sent) reminderDay = 3;
      else if (daysUntil <= 7 && daysUntil > 3 && !sub.renewal_reminder_7d_sent) reminderDay = 7;
      if (!reminderDay) { results.skipped.push(sub.org_id); continue; }
      const { data: owner } = await sb.from('profiles').select('id, display_name').eq('org_id', sub.org_id).eq('role', 'owner').maybeSingle();
      if (!owner) { results.skipped.push(sub.org_id + ':no-owner'); continue; }
      const { data: prefs } = await sb.from('notification_preferences').select('*').eq('user_id', owner.id).maybeSingle();
      const renewalDateStr = renewalDate.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });
      const tierPrice = TIER_PRICES[sub.tier] || '$0.00/mo';
      const tierName  = tierDisplayName(sub.tier);
      if (prefs?.in_app_notifications_enabled !== false) {
        await sb.from('notifications').insert({ organization_id: sub.org_id, user_id: owner.id, type: 'renewal_reminder', title: 'Your subscription renews in ' + reminderDay + ' days', body: 'Your ' + tierName + ' plan renews on ' + renewalDateStr + ' for ' + tierPrice + '.', action_url: APP_URL + '/billing' });
      }
      if (prefs?.email_notifications_enabled !== false) {
        const { data: authUser } = await sb.auth.admin.getUserById(owner.id);
        const ownerEmail = authUser?.user?.email;
        if (ownerEmail) {
          const firstName = (owner.display_name || '').split(' ')[0] || 'there';
          await sendEmail({ to: ownerEmail, subject: 'Your CardBreakPro subscription renews in ' + reminderDay + ' days', html: buildRenewalHtml(firstName, reminderDay, tierName, renewalDateStr, tierPrice, APP_URL + '/billing'), text: 'Hey ' + firstName + ',\n\nYour ' + tierName + ' plan renews in ' + reminderDay + ' day' + (reminderDay !== 1 ? 's' : '') + ' on ' + renewalDateStr + ' for ' + tierPrice + '.\n\nManage: ' + APP_URL + '/billing\n\n— Lucas\nCard Break Pro' });
        }
      }
      const flagField = reminderDay === 7 ? 'renewal_reminder_7d_sent' : 'renewal_reminder_3d_sent';
      await sb.from('subscriptions').update({ [flagField]: true }).eq('org_id', sub.org_id);
      results.sent.push({ org_id: sub.org_id, reminder_day: reminderDay });
    } catch (innerErr) { results.errors.push({ org_id: sub.org_id, error: innerErr.message }); }
  }
}

function isoDaysAgo(n) { const d = new Date(); d.setDate(d.getDate() - n); return d.toISOString().split('T')[0]; }
function isMissingColumn(err) { return !!err && /does not exist|could not find|schema cache/i.test(err.message || ''); }

// Going-cold alerts. Uses the SAME rule as the Buyer Board (buyer-intel.js):
// a buyer who has spent whale-threshold+ lifetime and whose last purchase is
// between cold_after_days and 120 days ago. Window-based, not "exactly day 21",
// so a missed cron run can't silently skip anyone. Fires once per cold episode
// (cold_notified_at resets the moment they buy again) to the owner and every
// manager, with a deep link straight to the Board.
async function runBuyerAlerts(sb, results) {
  let orgsRes = await sb.from('organizations').select('id, whale_threshold, cold_after_days');
  if (orgsRes.error && isMissingColumn(orgsRes.error)) orgsRes = await sb.from('organizations').select('id, whale_threshold');
  if (orgsRes.error) { results.errors.push('orgs: ' + orgsRes.error.message); return; }

  // One lookup for exempt orgs and one for all owners/managers (was 2 queries per org)
  const exempt = await exemptOrgSet(sb);
  const { data: allStaff } = await sb.from('profiles').select('id, org_id, role').in('role', ['owner', 'manager', 'breaker/manager']);
  const staffByOrg = {}; (allStaff || []).forEach(p => { (staffByOrg[p.org_id] = staffByOrg[p.org_id] || []).push(p); });

  for (const org of (orgsRes.data || [])) {
    try {
      if (exempt.has(org.id)) continue;
      const whaleMin  = Number(org.whale_threshold) || 1000;
      const coldAfter = Math.max(7, Number(org.cold_after_days) || 21);
      const newest = isoDaysAgo(coldAfter), oldest = isoDaysAgo(120);

      let q = await sb.from('buyers')
        .select('id, username, total_spent, last_purchase_date, cold_notified_at, assigned_to')
        .eq('organization_id', org.id).gte('total_spent', whaleMin)
        .lte('last_purchase_date', newest).gte('last_purchase_date', oldest);
      let haveStamp = true;
      if (q.error && isMissingColumn(q.error)) {
        // Migration 010 not run yet — fall back to the board's "contacted" stamp for de-duping.
        haveStamp = false;
        q = await sb.from('buyers')
          .select('id, username, total_spent, last_purchase_date, last_cold_alert_at')
          .eq('organization_id', org.id).gte('total_spent', whaleMin)
          .lte('last_purchase_date', newest).gte('last_purchase_date', oldest);
      }
      if (q.error) { results.errors.push(org.id + ': ' + q.error.message); continue; }

      const due = (q.data || []).filter(b => {
        const stamp = haveStamp ? b.cold_notified_at : b.last_cold_alert_at;
        return !stamp || String(stamp).slice(0, 10) <= String(b.last_purchase_date);   // never notified since their last purchase
      }).sort((a, b) => Number(b.total_spent) - Number(a.total_spent));
      if (!due.length) continue;
      results.orgs++;

      const staff = staffByOrg[org.id] || [];
      if (!staff.length) continue;

      const money = n => '$' + Math.round(Number(n) || 0).toLocaleString('en-US');
      const days = d => Math.floor((Date.now() - new Date(d + 'T12:00:00Z').getTime()) / 86400000);
      const atRisk = due.reduce((s, b) => s + (Number(b.total_spent) || 0), 0);
      const names = due.slice(0, 5).map(b => '@' + b.username + ' (' + money(b.total_spent) + ', ' + days(b.last_purchase_date) + 'd)').join(', ') + (due.length > 5 ? ' +' + (due.length - 5) + ' more' : '');
      const title = due.length === 1
        ? '@' + due[0].username + ' is going cold — ' + money(due[0].total_spent) + ' buyer'
        : due.length + ' big buyers are going cold — ' + money(atRisk) + ' at risk';
      const body = (due.length === 1 ? 'Last bought ' + days(due[0].last_purchase_date) + ' days ago. ' : names + '. ') + 'Open the Board → Going Cold, copy a win-back DM, and log the touch.';

      const rows = staff.map(p => ({
        organization_id: org.id, user_id: p.id, type: 'buyer_cold', title, body,
        action_url: APP_URL + (p.role === 'owner' ? '/dashboard?tab=buyers' : '/manager.html?tab=buyers')
      }));
      const ins = await sb.from('notifications').insert(rows);
      if (ins.error) { results.errors.push(org.id + ': notify ' + ins.error.message); continue; }
      results.fired += due.length;

      if (haveStamp) {
        const ids = due.map(b => b.id);
        for (let i = 0; i < ids.length; i += 100) {
          await sb.from('buyers').update({ cold_notified_at: new Date().toISOString() }).in('id', ids.slice(i, i + 100));
        }
      } else {
        // Without the dedicated stamp we'd re-fire daily; mark contacted instead (pre-010 behaviour).
        const ids = due.map(b => b.id);
        for (let i = 0; i < ids.length; i += 100) {
          await sb.from('buyers').update({ last_cold_alert_at: new Date().toISOString() }).in('id', ids.slice(i, i + 100));
        }
      }
    } catch (e) { console.error('buyer alert org error:', org.id, e); results.errors.push(org.id + ': ' + e.message); }
  }
}

// Slip nags. A closed stream with no packing slips imported is a hole in the
// buyer CRM — whales, cold alerts and win-back stats are blind to it. ~20h after
// closeout, if nothing's been imported or marked "no slips", the breaker gets
// one nag per stream (slips_nag_sent_at). The owner sees the same gap on Home.
async function runSlipNags(sb, results) {
  const cutoff = new Date(Date.now() - 20 * 3600 * 1000).toISOString();
  const { data: streams, error } = await sb.from('streams')
    .select('id, org_id, breaker_id, stream_key, break_date, final_sales')
    .eq('status', 'closed')
    .is('slips_imported_at', null).is('slips_skipped_at', null).is('slips_nag_sent_at', null)
    .lte('closed_at', cutoff).gte('break_date', isoDaysAgo(45))
    .order('closed_at', { ascending: false }).limit(500);
  if (error) { if (isMissingColumn(error)) return; results.errors.push(error.message); return; }
  if (!streams || !streams.length) return;

  const byBreaker = {};
  for (const s of streams) { if (!s.breaker_id) continue; (byBreaker[s.breaker_id] = byBreaker[s.breaker_id] || []).push(s); }
  const exempt = await exemptOrgSet(sb);
  for (const [breakerId, list] of Object.entries(byBreaker)) {
    try {
      const orgId = list[0].org_id;
      if (exempt.has(orgId)) continue;
      const fmtDate = d => new Date(d + 'T12:00:00Z').toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
      const sales = list.reduce((s, x) => s + (Number(x.final_sales) || 0), 0);
      const keys = list.slice(0, 3).map(s => s.stream_key + ' (' + fmtDate(s.break_date) + ')').join(', ') + (list.length > 3 ? ' +' + (list.length - 3) + ' more' : '');
      const ins = await sb.from('notifications').insert({
        organization_id: orgId, user_id: breakerId, type: 'slips_missing',
        title: list.length === 1 ? 'Packing slips still needed for ' + list[0].stream_key : list.length + ' streams still need packing slips',
        body: keys + ' — $' + Math.round(sales).toLocaleString('en-US') + ' in sales isn\'t counting toward your buyers, whales or win-backs yet. Export the slips PDF from Whatnot and import it (10 seconds).',
        action_url: APP_URL + '/break?tab=buyers'
      });
      if (ins.error) { results.errors.push(breakerId + ': ' + ins.error.message); continue; }
      const ids = list.map(s => s.id);
      await sb.from('streams').update({ slips_nag_sent_at: new Date().toISOString() }).in('id', ids);
      results.fired++; results.streams += ids.length;
    } catch (e) { results.errors.push(breakerId + ': ' + e.message); }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// ANNUAL RENEWAL REMINDERS  (30-day and 7-day)
// ─────────────────────────────────────────────────────────────────────────────
const ANNUAL_PRICES = { standard: 990.00, starter: 1299.90, pro: 3999.90, empire: 9999.90 };

async function runAnnualRenewalReminders(sb, res) {
  const results = { sent: [], skipped: [], errors: [] };

  const today = new Date(); today.setHours(0, 0, 0, 0);
  const in30 = new Date(today); in30.setDate(in30.getDate() + 30);
  const in7  = new Date(today); in7.setDate(in7.getDate() + 7);
  const in30Str = in30.toISOString().split('T')[0];
  const in7Str  = in7.toISOString().split('T')[0];

  const { data: subs, error: subErr } = await sb.from('subscriptions')
    .select('org_id, user_id, tier, billing_cycle, annual_renewal_date, annual_reminder_30_sent, annual_reminder_7_sent')
    .eq('billing_cycle', 'annual').eq('status', 'active').neq('tier', 'exempt')
    .or('annual_renewal_date.eq.' + in30Str + ',annual_renewal_date.eq.' + in7Str);

  if (subErr) throw new Error('Subscriptions query failed: ' + subErr.message);
  if (!subs || subs.length === 0) return res.status(200).json({ message: 'No upcoming annual renewals today', results });

  for (const sub of subs) {
    try {
      const renewalDate = sub.annual_renewal_date;
      const daysUntil   = renewalDate === in30Str ? 30 : 7;
      const flagField   = daysUntil === 30 ? 'annual_reminder_30_sent' : 'annual_reminder_7_sent';
      if (sub[flagField]) { results.skipped.push({ org_id: sub.org_id, reason: 'already-sent-' + daysUntil }); continue; }

      const { data: owner } = await sb.from('profiles').select('id, display_name').eq('org_id', sub.org_id).eq('role', 'owner').maybeSingle();
      const { data: authUser } = await sb.auth.admin.getUserById(sub.user_id || owner?.id);
      const ownerEmail = authUser?.user?.email;
      if (!ownerEmail) { results.skipped.push({ org_id: sub.org_id, reason: 'no-email' }); continue; }

      const firstName  = (owner?.display_name || '').split(' ')[0] || 'there';
      const tierName   = tierDisplayName(sub.tier || 'standard');
      const amount     = ANNUAL_PRICES[sub.tier] || ANNUAL_PRICES.standard;
      const renewalFmt = new Date(renewalDate + 'T12:00:00Z').toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });
      const { subject, html, text } = buildAnnualReminderEmail(daysUntil, firstName, tierName, amount, renewalFmt, APP_URL + '/billing');
      await sendEmail({ to: ownerEmail, subject, html, text });
      await sb.from('subscriptions').update({ [flagField]: true }).eq('org_id', sub.org_id);
      results.sent.push({ org_id: sub.org_id, days_until: daysUntil, to: ownerEmail });
    } catch (innerErr) {
      results.errors.push({ org_id: sub.org_id, error: innerErr.message });
    }
  }
  return res.status(200).json({ message: 'Done', results });
}

// ─────────────────────────────────────────────────────────────────────────────
// SORTER SPLIT EXPIRY  (runs hourly)
// ─────────────────────────────────────────────────────────────────────────────
// (split-expiry job removed 2026-09 — sorter splits retired; sorters are hourly.)

// ─────────────────────────────────────────────────────────────────────────────
// MONTHLY GOAL PROMPT  (runs 25th of month at 9am Eastern)
// ─────────────────────────────────────────────────────────────────────────────
async function runGoalPrompt(sb, res) {
  const results = { notified: [], skipped: [], errors: [] };

  // Next month's year/month
  const now = new Date();
  const nextMonth = now.getUTCMonth() + 2; // getUTCMonth is 0-indexed; +2 = next month 1-indexed
  const nextYear  = nextMonth > 12 ? now.getUTCFullYear() + 1 : now.getUTCFullYear();
  const normalizedNextMonth = nextMonth > 12 ? 1 : nextMonth;

  // All active owners across all organizations (exempt orgs excluded)
  const { data: owners, error: ownersErr } = await sb
    .from('profiles')
    .select('id, org_id, display_name')
    .eq('role', 'owner');

  if (ownersErr) throw new Error('Profiles query failed: ' + ownersErr.message);
  if (!owners || owners.length === 0) return res.status(200).json({ message: 'No owners found', results });

  // Filter out exempt orgs
  const orgIds = [...new Set(owners.map(o => o.org_id).filter(Boolean))];
  const { data: subs } = await sb.from('subscriptions').select('org_id, tier').in('org_id', orgIds);
  const exemptOrgs = new Set((subs || []).filter(s => s.tier === 'exempt').map(s => s.org_id));

  for (const owner of owners) {
    if (!owner.org_id || exemptOrgs.has(owner.org_id)) {
      results.skipped.push((owner.id) + ':exempt-or-no-org');
      continue;
    }
    try {
      // Check if any goals already set for next month
      const { count } = await sb.from('monthly_goals')
        .select('id', { count: 'exact', head: true })
        .eq('org_id', owner.org_id)
        .eq('goal_year', nextYear)
        .eq('goal_month', normalizedNextMonth);

      if (count > 0) {
        results.skipped.push(owner.id + ':goals-already-set');
        continue;
      }

      const monthName = new Date(nextYear, normalizedNextMonth - 1, 1)
        .toLocaleString('en-US', { month: 'long' });

      await sb.from('notifications').insert({
        organization_id: owner.org_id,
        user_id: owner.id,
        type: 'goal_prompt',
        title: 'Set your goals for ' + monthName,
        body: 'You haven\'t set goals for ' + monthName + ' yet. Head to Goals to set revenue, break, and streak targets for your team.',
        action_url: APP_URL + '/dashboard'
      });

      results.notified.push({ user_id: owner.id, org_id: owner.org_id, next_month: normalizedNextMonth + '/' + nextYear });
    } catch (innerErr) {
      results.errors.push({ user_id: owner.id, error: innerErr.message });
    }
  }

  return res.status(200).json({ message: 'Done', results });
}

// ─────────────────────────────────────────────────────────────────────────────
// LEADERBOARD MONTH RESET  (runs 1st of month at 12:01am Eastern)
// ─────────────────────────────────────────────────────────────────────────────
async function runLeaderboardReset(sb, res) {
  // Historical data in leaderboard_snapshots is kept permanently — no delete.
  // This job logs an archive checkpoint so owners have an audit trail.
  const results = { archived: [], errors: [] };

  const now = new Date();
  // Previous month
  const prevMonth = now.getUTCMonth(); // 0-indexed, so this is last month (1-indexed)
  const prevYear  = prevMonth === 0 ? now.getUTCFullYear() - 1 : now.getUTCFullYear();
  const normalizedPrevMonth = prevMonth === 0 ? 12 : prevMonth;

  // Count snapshots that exist for the previous month across all orgs
  const { data: orgsWithData, error } = await sb
    .from('leaderboard_snapshots')
    .select('org_id')
    .eq('period_year', prevYear)
    .eq('period_month', normalizedPrevMonth);

  if (error) throw new Error('leaderboard_snapshots query failed: ' + error.message);

  const uniqueOrgs = [...new Set((orgsWithData || []).map(r => r.org_id))];

  for (const orgId of uniqueOrgs) {
    try {
      await sb.from('activity_log').insert({
        org_id: orgId,
        user_id: null,
        action: 'leaderboard_month_archived',
        details: JSON.stringify({
          period_year: prevYear,
          period_month: normalizedPrevMonth,
          archived_at: now.toISOString()
        })
      }).catch(() => {}); // non-fatal

      results.archived.push({ org_id: orgId, period: normalizedPrevMonth + '/' + prevYear });
    } catch (innerErr) {
      results.errors.push({ org_id: orgId, error: innerErr.message });
    }
  }

  return res.status(200).json({ message: 'Done', results });
}

// ─────────────────────────────────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────────────────────────────────
function fmt(n) { return '$' + (parseFloat(n) || 0).toFixed(2); }
function escHtml(str) { return String(str || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }

async function compileStats(sb, orgId, dayStart, dayEnd) {
  const { data: streams } = await sb.from('streams').select('id, final_sales, net_profit, break_count').eq('org_id', orgId).gte('closed_at', dayStart).lte('closed_at', dayEnd).eq('status', 'closed');
  const closedStreams = streams || [];
  const streamsRun   = closedStreams.length;
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
      if (topId) { const { data: bp } = await sb.from('profiles').select('display_name').eq('id', topId[0]).maybeSingle(); topBreaker = { name: bp?.display_name || 'Unknown', revenue: topId[1] }; }
    }
  }
  // (These used products.is_active and streams.sort_status — neither column exists, so
  //  every digest reported "no low stock" and "0 pending sort". AUDIT AB-2.)
  const { data: lowProducts } = await sb.from('products').select('name, current_stock').eq('org_id', orgId).lte('current_stock', 3).eq('active', true);
  const { count: pendingSort } = await sb.from('sort_tasks').select('id', { count: 'exact', head: true }).eq('org_id', orgId).neq('status', 'completed');
  return { streamsRun, totalRevenue, totalProfit, totalBreaks, topBreaker, lowProducts: lowProducts || [], pendingSort: pendingSort || 0 };
}

function buildTrialEmail(day, firstName, orgName, breaks, streams, hoursSaved, billingUrl) {
  if (day === 7) {
    const subject = 'How are the numbers looking?';
    const text = `Hey ${firstName},\n\nIt's been a week since you started running ${orgName} on Card Break Pro.\n\nHow does it feel to know your profit the second a stream closes?${breaks > 0 ? ` You logged ${breaks} break${breaks !== 1 ? 's' : ''} this week.` : ''}\n\nYou have 7 days left in your trial.\n\n${billingUrl}\n\n— Lucas\nCard Break Pro`;
    const html = `<!DOCTYPE html><html><head><meta charset="utf-8"></head><body style="margin:0;padding:0;background:#f4f4f5;font-family:'Segoe UI',system-ui,sans-serif;"><div style="max-width:580px;margin:40px auto;background:#fff;border-radius:12px;overflow:hidden;box-shadow:0 2px 12px rgba(0,0,0,0.08);"><div style="background:#0d0d14;padding:28px 32px;"><div style="font-size:1.1rem;font-weight:800;letter-spacing:2px;color:#e2e8f0;">CARD <span style="color:#4f6ef7;">BREAK</span> PRO</div></div><div style="padding:36px 32px;"><p style="margin:0 0 18px;font-size:1rem;color:#1e293b;">Hey ${firstName},</p><p style="margin:0 0 18px;font-size:0.97rem;color:#334155;line-height:1.65;">It's been a week since you started running <strong>${orgName}</strong> on Card Break Pro.${breaks > 0 ? ` You logged <strong>${breaks} break${breaks !== 1 ? 's' : ''}</strong>.` : ''}</p><div style="background:#f8fafc;border-left:4px solid #4f6ef7;border-radius:4px;padding:16px 20px;margin:24px 0;"><p style="margin:0;font-size:0.95rem;color:#1e293b;font-weight:600;">You have 7 days left in your trial.</p></div><a href="${billingUrl}" style="display:inline-block;background:#4f6ef7;color:#fff;text-decoration:none;padding:14px 28px;border-radius:8px;font-weight:700;font-size:0.95rem;margin-bottom:28px;">Keep My Access →</a><p style="margin:0 0 8px;font-size:0.97rem;color:#334155;">— Lucas</p><p style="margin:0;font-size:0.88rem;color:#64748b;">Card Break Pro</p></div></div></body></html>`;
    return { subject, html, text };
  }
  if (day === 12) {
    const subject = '2 days left — and something I want you to see';
    const text = `Hey ${firstName},\n\nYour trial ends in 2 days.\n\nBreaks logged: ${breaks}\nStreams closed: ${streams}\nEstimated time saved: ~${hoursSaved} hours\n\nKeep access: ${billingUrl}\n\n— Lucas\nCard Break Pro`;
    const html = `<!DOCTYPE html><html><head><meta charset="utf-8"></head><body style="margin:0;padding:0;background:#f4f4f5;font-family:'Segoe UI',system-ui,sans-serif;"><div style="max-width:580px;margin:40px auto;background:#fff;border-radius:12px;overflow:hidden;"><div style="background:#0d0d14;padding:28px 32px;"><div style="font-size:1.1rem;font-weight:800;letter-spacing:2px;color:#e2e8f0;">CARD <span style="color:#4f6ef7;">BREAK</span> PRO</div></div><div style="padding:36px 32px;"><p style="margin:0 0 18px;font-size:1rem;color:#1e293b;">Hey ${firstName},</p><p style="margin:0 0 18px;font-size:0.97rem;color:#334155;line-height:1.65;"><strong>Your trial ends in 2 days.</strong></p><div style="background:#f8fafc;border-radius:10px;padding:20px 24px;margin:0 0 24px;"><div style="display:flex;justify-content:space-between;padding:8px 0;border-bottom:1px solid #e2e8f0;"><span style="color:#64748b;">Breaks logged</span><strong>${breaks}</strong></div><div style="display:flex;justify-content:space-between;padding:8px 0;border-bottom:1px solid #e2e8f0;"><span style="color:#64748b;">Streams closed</span><strong>${streams}</strong></div><div style="display:flex;justify-content:space-between;padding:8px 0;"><span style="color:#64748b;">Time saved</span><strong style="color:#22c55e;">~${hoursSaved} hrs</strong></div></div><a href="${billingUrl}" style="display:inline-block;background:#4f6ef7;color:#fff;text-decoration:none;padding:14px 28px;border-radius:8px;font-weight:700;font-size:0.95rem;margin-bottom:28px;">Keep My Access →</a><p style="margin:0 0 8px;font-size:0.97rem;color:#334155;">— Lucas</p><p style="margin:0;font-size:0.88rem;color:#64748b;">Card Break Pro</p></div></div></body></html>`;
    return { subject, html, text };
  }
  // day 14
  const subject = 'Your trial ends today';
  const text = `Hey ${firstName},\n\nYour trial ends today. ${orgName} logged ${breaks} break${breaks !== 1 ? 's' : ''} and closed ${streams} stream${streams !== 1 ? 's' : ''}.\n\nIf you want to keep going: ${billingUrl}\n\n— Lucas\nCard Break Pro`;
  const html = `<!DOCTYPE html><html><head><meta charset="utf-8"></head><body style="margin:0;padding:0;background:#f4f4f5;font-family:'Segoe UI',system-ui,sans-serif;"><div style="max-width:580px;margin:40px auto;background:#fff;border-radius:12px;overflow:hidden;"><div style="background:#0d0d14;padding:28px 32px;"><div style="font-size:1.1rem;font-weight:800;letter-spacing:2px;color:#e2e8f0;">CARD <span style="color:#4f6ef7;">BREAK</span> PRO</div></div><div style="padding:36px 32px;"><p style="margin:0 0 18px;font-size:1rem;color:#1e293b;">Hey ${firstName},</p><p style="margin:0 0 18px;font-size:0.97rem;color:#334155;line-height:1.65;">Your trial ends today. <strong>${orgName}</strong> logged <strong>${breaks} break${breaks !== 1 ? 's' : ''}</strong> and closed <strong>${streams} stream${streams !== 1 ? 's' : ''}</strong>.</p><a href="${billingUrl}" style="display:inline-block;background:#4f6ef7;color:#fff;text-decoration:none;padding:14px 28px;border-radius:8px;font-weight:700;font-size:0.95rem;margin-bottom:28px;">Keep My Access →</a><p style="margin:0 0 8px;font-size:0.97rem;color:#334155;">— Lucas</p><p style="margin:0;font-size:0.88rem;color:#64748b;">Card Break Pro</p></div></div></body></html>`;
  return { subject, html, text };
}

function buildShiftReminderHtml(name, streamName, channelName, timeStr) {
  return `<!DOCTYPE html><html><head><meta charset="utf-8"></head><body style="margin:0;padding:0;background:#f4f4f5;font-family:'Segoe UI',system-ui,sans-serif;"><div style="max-width:560px;margin:40px auto;background:#fff;border-radius:12px;overflow:hidden;"><div style="background:#0d0d14;padding:24px 28px;"><div style="font-size:1rem;font-weight:800;letter-spacing:2px;color:#e2e8f0;">CARD <span style="color:#4f6ef7;">BREAK</span> PRO</div></div><div style="padding:32px 28px;"><p style="margin:0 0 16px;font-size:1rem;color:#1e293b;">Hey ${escHtml(name)},</p><div style="background:#eff6ff;border:1px solid #93c5fd;border-radius:10px;padding:16px 20px;margin-bottom:20px;"><div style="font-size:0.75rem;font-weight:700;color:#1d4ed8;text-transform:uppercase;margin-bottom:6px;">⏰ Shift Starting Soon</div><div style="font-size:1.05rem;font-weight:800;color:#1e293b;">${escHtml(streamName)}</div><div style="font-size:0.9rem;color:#334155;margin-top:4px;">${escHtml(channelName)} · Starts at ${escHtml(timeStr)}</div></div><p style="margin:0 0 24px;font-size:0.9rem;color:#334155;line-height:1.65;">Make sure you are clocked in before you go live.</p><p style="margin:0;font-size:0.85rem;color:#94a3b8;">— Card Break Pro</p></div></div></body></html>`;
}

function buildAnnualReminderEmail(days, firstName, tierName, amount, renewalDate, billingUrl) {
  const urgencyColor = days === 30 ? '#4f6ef7' : '#f59e0b';
  const subject = days === 30 ? 'Your CardBreakPro annual plan renews in 30 days' : 'CardBreakPro renewal in 7 days — $' + amount.toFixed(2) + ' on ' + renewalDate;
  const text = `Hey ${firstName},\n\nYour ${tierName} annual plan renews in ${days} days.\n\nRenewal date: ${renewalDate}\nAmount: $${amount.toFixed(2)}\n\nManage billing: ${billingUrl}\n\n— Lucas\nCard Break Pro`;
  const html = `<!DOCTYPE html><html><head><meta charset="utf-8"></head><body style="margin:0;padding:0;background:#f4f4f5;font-family:'Segoe UI',system-ui,sans-serif;"><div style="max-width:560px;margin:40px auto;background:#fff;border-radius:12px;overflow:hidden;"><div style="background:#0d0d14;padding:24px 28px;"><div style="font-size:1rem;font-weight:800;letter-spacing:2px;color:#e2e8f0;">CARD <span style="color:#4f6ef7;">BREAK</span> PRO</div></div><div style="padding:32px 28px;"><p style="margin:0 0 16px;font-size:1rem;color:#1e293b;">Hey ${escHtml(firstName)},</p><div style="background:${urgencyColor}1a;border:1px solid ${urgencyColor}44;border-radius:10px;padding:16px 20px;margin-bottom:20px;"><div style="font-size:0.75rem;font-weight:700;color:${urgencyColor};text-transform:uppercase;margin-bottom:6px;">${days} Days Until Renewal</div><div style="font-size:0.95rem;font-weight:700;color:#1e293b;">${escHtml(tierName)} Annual — $${amount.toFixed(2)}</div><div style="font-size:0.85rem;color:#64748b;margin-top:4px;">Renews ${escHtml(renewalDate)}</div></div><a href="${billingUrl}" style="display:inline-block;background:#4f6ef7;color:#fff;text-decoration:none;padding:12px 24px;border-radius:8px;font-weight:700;font-size:0.9rem;">Manage Billing →</a><p style="margin:28px 0 0;font-size:0.88rem;color:#334155;">— Lucas</p><p style="margin:0;font-size:0.82rem;color:#94a3b8;">Card Break Pro</p></div></div></body></html>`;
  return { subject, html, text };
}

function buildDigestText(firstName, orgName, dateLabel, stats, dashUrl) {
  const noStreams = stats.streamsRun === 0;
  const lines = [`Hey ${firstName},`, '', `Here is what your operation did yesterday${noStreams ? ' — no streams ran.' : '.'}`, ''];
  if (!noStreams) { lines.push('Yesterday — ' + dateLabel, `  Revenue: ${fmt(stats.totalRevenue)}`, `  Profit: ${fmt(stats.totalProfit)}`, `  Streams: ${stats.streamsRun}`, `  Breaks: ${stats.totalBreaks}`); if (stats.topBreaker) lines.push(`  Top Breaker: ${stats.topBreaker.name} (${fmt(stats.topBreaker.revenue)})`); lines.push(''); }
  if (stats.lowProducts.length > 0) { lines.push('Low Inventory:'); for (const p of stats.lowProducts) lines.push(`  • ${p.name} — ${p.current_stock} left`); lines.push(''); }
  if (stats.pendingSort > 0) { lines.push(`Sort Queue: ${stats.pendingSort} stream${stats.pendingSort !== 1 ? 's' : ''} pending.`, ''); }
  lines.push(dashUrl, '', '— Lucas', 'Card Break Pro');
  return lines.join('\n');
}

function buildDigestHtml(firstName, orgName, dateLabel, stats, dashUrl) {
  const noStreams = stats.streamsRun === 0;
  const profitColor = stats.totalProfit >= 0 ? '#22c55e' : '#ef4444';
  let statsRows = '';
  if (!noStreams) { statsRows = `<div style="background:#f8fafc;border-radius:10px;padding:16px 20px;margin:0 0 20px;"><div style="font-size:0.7rem;font-weight:700;color:#64748b;text-transform:uppercase;margin-bottom:12px;">${escHtml(dateLabel)}</div><div style="display:flex;justify-content:space-between;padding:7px 0;border-bottom:1px solid #e2e8f0;"><span style="color:#64748b;font-size:0.88rem;">Revenue</span><strong>${fmt(stats.totalRevenue)}</strong></div><div style="display:flex;justify-content:space-between;padding:7px 0;border-bottom:1px solid #e2e8f0;"><span style="color:#64748b;font-size:0.88rem;">Profit</span><strong style="color:${profitColor};">${fmt(stats.totalProfit)}</strong></div><div style="display:flex;justify-content:space-between;padding:7px 0;border-bottom:1px solid #e2e8f0;"><span style="color:#64748b;font-size:0.88rem;">Streams</span><strong>${stats.streamsRun}</strong></div><div style="display:flex;justify-content:space-between;padding:7px 0;"><span style="color:#64748b;font-size:0.88rem;">Breaks</span><strong>${stats.totalBreaks}</strong></div>${stats.topBreaker ? `<div style="display:flex;justify-content:space-between;padding:7px 0;"><span style="color:#64748b;font-size:0.88rem;">Top breaker</span><strong style="color:#4f6ef7;">${escHtml(stats.topBreaker.name)} · ${fmt(stats.topBreaker.revenue)}</strong></div>` : ''}</div>`; }
  let alertRows = stats.lowProducts.length > 0 ? `<div style="background:#fffbeb;border:1px solid #fbbf24;border-radius:10px;padding:14px 18px;margin:0 0 16px;"><div style="font-size:0.72rem;font-weight:700;color:#b45309;text-transform:uppercase;margin-bottom:8px;">Low Inventory</div>${stats.lowProducts.map(p => `<div style="font-size:0.88rem;color:#1e293b;padding:3px 0;">⚠ ${escHtml(p.name)} — <strong>${p.current_stock}</strong> left</div>`).join('')}</div>` : '';
  let sortRow = stats.pendingSort > 0 ? `<div style="background:#eff6ff;border:1px solid #93c5fd;border-radius:10px;padding:14px 18px;margin:0 0 20px;"><div style="font-size:0.72rem;font-weight:700;color:#1d4ed8;text-transform:uppercase;margin-bottom:4px;">Sort Queue</div><div style="font-size:0.88rem;color:#1e293b;">${stats.pendingSort} stream${stats.pendingSort !== 1 ? 's' : ''} pending sort.</div></div>` : '';
  return `<!DOCTYPE html><html><head><meta charset="utf-8"></head><body style="margin:0;padding:0;background:#f4f4f5;font-family:'Segoe UI',system-ui,sans-serif;"><div style="max-width:560px;margin:40px auto;background:#fff;border-radius:12px;overflow:hidden;"><div style="background:#0d0d14;padding:24px 28px;"><div style="font-size:1rem;font-weight:800;letter-spacing:2px;color:#e2e8f0;">CARD <span style="color:#4f6ef7;">BREAK</span> PRO</div></div><div style="padding:32px 28px;"><p style="margin:0 0 6px;font-size:1rem;color:#1e293b;">Hey ${escHtml(firstName)},</p><p style="margin:0 0 20px;font-size:0.9rem;color:#64748b;">${noStreams ? 'No streams ran yesterday for ' + escHtml(orgName) + '.' : 'Here is what ' + escHtml(orgName) + ' did yesterday.'}</p>${statsRows}${alertRows}${sortRow}<a href="${dashUrl}" style="display:inline-block;background:#4f6ef7;color:#fff;text-decoration:none;padding:12px 24px;border-radius:8px;font-weight:700;font-size:0.9rem;margin-bottom:24px;">Open Dashboard →</a><p style="margin:0 0 4px;font-size:0.88rem;color:#334155;">— Lucas</p><p style="margin:0;font-size:0.82rem;color:#94a3b8;">Card Break Pro</p></div></div></body></html>`;
}

function buildRenewalHtml(name, days, tierName, renewalDate, price, billingUrl) {
  const urgencyColor = days <= 3 ? '#ef4444' : '#f59e0b';
  const urgencyBg    = days <= 3 ? '#fef2f2' : '#fffbeb';
  const urgencyBorder = days <= 3 ? '#fca5a5' : '#fbbf24';
  return `<!DOCTYPE html><html><head><meta charset="utf-8"></head><body style="margin:0;padding:0;background:#f4f4f5;font-family:'Segoe UI',system-ui,sans-serif;"><div style="max-width:560px;margin:40px auto;background:#fff;border-radius:12px;overflow:hidden;"><div style="background:#0d0d14;padding:24px 28px;"><div style="font-size:1rem;font-weight:800;letter-spacing:2px;color:#e2e8f0;">CARD <span style="color:#4f6ef7;">BREAK</span> PRO</div></div><div style="padding:32px 28px;"><p style="margin:0 0 16px;font-size:1rem;color:#1e293b;">Hey ${escHtml(name)},</p><div style="background:${urgencyBg};border:1px solid ${urgencyBorder};border-radius:10px;padding:16px 20px;margin-bottom:20px;"><div style="font-size:0.75rem;font-weight:700;color:${urgencyColor};text-transform:uppercase;margin-bottom:6px;">Renewal in ${days} day${days !== 1 ? 's' : ''}</div><div style="font-size:1.05rem;font-weight:800;color:#1e293b;">${escHtml(tierName)} Plan</div><div style="font-size:0.9rem;color:#334155;margin-top:4px;">${escHtml(renewalDate)} · ${escHtml(price)}</div></div><a href="${billingUrl}" style="display:inline-block;background:#4f6ef7;color:#fff;text-decoration:none;padding:12px 24px;border-radius:8px;font-weight:700;font-size:0.9rem;">Manage Billing →</a><p style="margin:28px 0 0;font-size:0.88rem;color:#334155;">— Lucas</p><p style="margin:0;font-size:0.82rem;color:#94a3b8;">Card Break Pro</p></div></div></body></html>`;
}
