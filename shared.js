// CardBreakPro — shared helpers (loaded by owner, manager, breaker, sorter;
// also require()'d by the API/cron so server and client use the same math)
//
// One place for the things that used to be copied per page and drifted:
// the org timezone, "today", pay-period edges, clocked-hours math, paging
// past PostgREST's 1,000-row cap, and error capture. See AUDIT.md CQ-1.
(function (global) {
  'use strict';

  const DEFAULT_TZ = 'America/New_York';
  let _tz = DEFAULT_TZ;

  // ── timezone ────────────────────────────────────────────────────────────
  function pad(n) { return String(n).padStart(2, '0'); }

  function partsIn(date, tz) {
    const dtf = new Intl.DateTimeFormat('en-US', { timeZone: tz || _tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' });
    const out = {};
    dtf.formatToParts(date).forEach(p => { if (p.type !== 'literal') out[p.type] = parseInt(p.value, 10); });
    if (out.hour === 24) out.hour = 0;
    return out;
  }

  // Minutes to ADD to a UTC instant to get local wall time (EDT = -240).
  function tzOffsetMinutes(date, tz) {
    const p = partsIn(date, tz);
    return (Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - date.getTime()) / 60000;
  }

  // 'YYYY-MM-DD' of an instant in the org zone.
  function dateInTz(date, tz) { const p = partsIn(date || new Date(), tz); return p.year + '-' + pad(p.month) + '-' + pad(p.day); }
  function todayIn(tz) { return dateInTz(new Date(), tz); }

  // ISO instant of local midnight at the start of dateStr (two passes for DST edges).
  function localMidnightISO(dateStr, tz) {
    const guess = new Date(dateStr + 'T00:00:00Z');
    let off = tzOffsetMinutes(guess, tz);
    let inst = new Date(guess.getTime() - off * 60000);
    const off2 = tzOffsetMinutes(inst, tz);
    if (off2 !== off) inst = new Date(guess.getTime() - off2 * 60000);
    return inst.toISOString();
  }
  // ISO instant of a local wall-clock time ('HH:MM[:SS]') on dateStr.
  function localTimeISO(dateStr, timeStr, tz) {
    const m = /^(\d{1,2}):(\d{2})/.exec(timeStr || '');
    const mins = m ? parseInt(m[1], 10) * 60 + parseInt(m[2], 10) : 0;
    return new Date(new Date(localMidnightISO(dateStr, tz)).getTime() + mins * 60000).toISOString();
  }
  // Exclusive end: midnight at the start of the day AFTER dateStr.
  function dayEndISO(dateStr, tz) {
    const d = new Date(dateStr + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + 1);
    return localMidnightISO(d.toISOString().slice(0, 10), tz);
  }
  function addDays(dateStr, n) { const d = new Date(dateStr + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); }

  // ── pay periods ─────────────────────────────────────────────────────────
  // Returns { from, to } as 'YYYY-MM-DD' (inclusive, org-local days) plus
  // fromISO / toISO instants (toISO is EXCLUSIVE) for timestamptz filters.
  function periodBounds(preset, opts) {
    opts = opts || {};
    const tz = opts.tz || _tz;
    const today = todayIn(tz);
    const t = new Date(today + 'T12:00:00Z');
    let from, to = today, label;
    if (preset === 'daily' || preset === 'today') { from = today; label = 'Today (' + today + ')'; }
    else if (preset === 'this_week' || preset === 'weekly') { from = addDays(today, -t.getUTCDay()); label = 'This Week (' + from + ' – ' + to + ')'; }
    else if (preset === 'last_two_weeks') { from = addDays(today, -13); label = 'Last 2 Weeks (' + from + ' – ' + to + ')'; }
    else if (preset === 'this_month' || preset === 'monthly') { from = today.slice(0, 8) + '01'; label = 'This Month (' + from + ' – ' + to + ')'; }
    else if (preset === 'last_month') {
      const y = t.getUTCFullYear(), m = t.getUTCMonth();
      const lm = new Date(Date.UTC(y, m - 1, 1)), lme = new Date(Date.UTC(y, m, 0));
      from = lm.toISOString().slice(0, 10); to = lme.toISOString().slice(0, 10);
      label = 'Last Month (' + from + ' – ' + to + ')';
    }
    else if (preset === 'all') { from = '2000-01-01'; label = 'All Time'; }
    else { from = opts.from || today; to = opts.to || today; label = 'Custom (' + from + ' – ' + to + ')'; }
    return { from, to, label, fromISO: localMidnightISO(from, tz), toISO: dayEndISO(to, tz) };
  }

  // ── clocked hours ───────────────────────────────────────────────────────
  // Hours of a shift that fall inside [fromISO, toISO). A shift that straddles
  // a period edge is prorated instead of dropped or double-counted.
  function hoursOverlap(shift, fromISO, toISO) {
    if (!shift || !shift.clocked_in_at || !shift.clocked_out_at) return 0;
    const a = Math.max(new Date(shift.clocked_in_at).getTime(), new Date(fromISO).getTime());
    const b = Math.min(new Date(shift.clocked_out_at).getTime(), new Date(toISO).getTime());
    return Math.max(0, (b - a) / 3600000);
  }
  function sumHours(shifts, fromISO, toISO) { return (shifts || []).reduce((s, x) => s + hoursOverlap(x, fromISO, toISO), 0); }
  function shiftHours(shift) { return (shift && shift.clocked_in_at && shift.clocked_out_at) ? Math.max(0, (new Date(shift.clocked_out_at) - new Date(shift.clocked_in_at)) / 3600000) : 0; }

  // Supabase filter for "shift overlaps the window": in < to AND out > from.
  function applyShiftWindow(q, fromISO, toISO) { return q.lt('clocked_in_at', toISO).gt('clocked_out_at', fromISO); }

  // ── money / misc ────────────────────────────────────────────────────────
  // Salary for a run: prorate the configured amount by how much of its period
  // the run covers (weekly salary × 4.3 for a month run, not × 1).
  function salaryForRange(amount, salaryPeriod, from, to) {
    amount = Number(amount) || 0;
    const days = Math.max(1, Math.round((new Date(to + 'T12:00:00Z') - new Date(from + 'T12:00:00Z')) / 86400000) + 1);
    const perDay = salaryPeriod === 'weekly' ? amount / 7
                 : salaryPeriod === 'biweekly' ? amount / 14
                 : salaryPeriod === 'monthly' ? amount / 30.4375
                 : amount / 7;
    return { total: perDay * days, days };
  }

  // ── inventory log ───────────────────────────────────────────────────────
  // inventory_log.quantity is always stored positive; the action carries the
  // sign. One rule for the owner/manager logs, the exports and the stock audit.
  const LOG_OUT_ACTIONS = { used: true, adjust_out: true };
  function logDelta(row) {
    const q = Math.abs(Number(row && row.quantity) || 0);
    return LOG_OUT_ACTIONS[row && row.action] ? -q : q;
  }
  const LOG_ACTION_LABELS = { initial: 'Initial', restock: 'Restock', used: 'Used', restored: 'Restored', adjust_in: 'Correction +', adjust_out: 'Correction −' };
  function logActionLabel(action) { return LOG_ACTION_LABELS[action] || (action || '—'); }

  // Atomic stock change through the adjust_stock RPC (migrations 013/014):
  // UPDATE … current_stock = current_stock + delta plus the log line, in one
  // statement. Tries the 5-arg signature (batch unit cost), then the 4-arg one,
  // and only if the function doesn't exist at all falls back to a
  // read-modify-write — still writing the log row, so nothing is ever unlogged.
  // Returns { stock, via } or { error }.
  async function adjustStock(sb, o) {
    const delta = Math.trunc(Number(o.delta) || 0);
    if (!delta) return { stock: null, skipped: true };
    const base = { p_product_id: o.productId, p_delta: delta, p_action: o.action || 'used', p_notes: o.notes || null };
    let r = await sb.rpc('adjust_stock', o.unitCost != null ? Object.assign({ p_unit_cost: o.unitCost }, base) : base);
    if (r.error && o.unitCost != null && isMissingSchema(r.error)) r = await sb.rpc('adjust_stock', base);
    if (!r.error) return { stock: r.data, via: 'rpc' };
    if (!isMissingSchema(r.error)) return { error: r.error };
    const { data: prod, error: readErr } = await sb.from('products').select('org_id,name,unit_cost,current_stock').eq('id', o.productId).maybeSingle();
    if (readErr || !prod) return { error: readErr || new Error('product not found') };
    const newStock = (Number(prod.current_stock) || 0) + delta;
    const { error: upErr } = await sb.from('products').update({ current_stock: newStock }).eq('id', o.productId);
    if (upErr) return { error: upErr };
    const { error: logErr } = await sb.from('inventory_log').insert({
      org_id: prod.org_id, product_id: o.productId, product_name: prod.name, action: o.action || 'used',
      quantity: Math.abs(delta), unit_cost: o.unitCost != null ? o.unitCost : prod.unit_cost, notes: o.notes || null
    });
    if (logErr) captureError(logErr, 'inventory_log insert (adjustStock fallback)');
    return { stock: newStock, via: 'fallback' };
  }

  async function pageAll(makeQuery, pageSize) {
    const PAGE = pageSize || 1000;
    let all = [], from = 0;
    while (true) {
      const { data, error } = await makeQuery().range(from, from + PAGE - 1);
      if (error) throw error;
      all = all.concat(data || []);
      if (!data || data.length < PAGE) break;
      from += PAGE;
    }
    return all;
  }

  function isMissingSchema(err) {
    if (!err) return false;
    return /^(42P01|42883|42703|PGRST202|PGRST204|PGRST205)$/.test(err.code || '') || /does not exist|could not find|schema cache/i.test(String(err.message || ''));
  }

  // Error sink: PostHog exception capture when analytics is loaded, console otherwise.
  function captureError(err, ctx) {
    try { console.error('[cbp]', ctx || '', err); } catch (e) {}
    try {
      if (global.posthog && typeof global.posthog.captureException === 'function') global.posthog.captureException(err, Object.assign({ where: ctx || '' }, {}));
      else if (typeof global.cbpTrack === 'function') global.cbpTrack('$exception', { $exception_message: String(err && err.message || err), $exception_type: err && err.name, where: ctx || '' });
    } catch (e) {}
  }

  // Load the org's timezone once per page. Tolerates the column not existing yet.
  async function loadOrgTz(sb, orgId) {
    try {
      const { data, error } = await sb.from('organizations').select('timezone').eq('id', orgId).maybeSingle();
      if (!error && data && data.timezone) { try { new Intl.DateTimeFormat('en-US', { timeZone: data.timezone }); _tz = data.timezone; } catch (e) {} }
    } catch (e) {}
    return _tz;
  }

  const US_TIMEZONES = [
    ['America/New_York', 'Eastern'], ['America/Chicago', 'Central'], ['America/Denver', 'Mountain'], ['America/Phoenix', 'Arizona (no DST)'],
    ['America/Los_Angeles', 'Pacific'], ['America/Anchorage', 'Alaska'], ['Pacific/Honolulu', 'Hawaii'],
    ['America/Toronto', 'Toronto'], ['America/Vancouver', 'Vancouver'], ['Europe/London', 'London'], ['Australia/Sydney', 'Sydney']
  ];

  global.CBP = {
    DEFAULT_TZ, US_TIMEZONES,
    get tz() { return _tz; }, setTz(tz) { if (tz) _tz = tz; },
    loadOrgTz, partsIn, tzOffsetMinutes, dateInTz, todayIn, localMidnightISO, localTimeISO, dayEndISO, addDays,
    periodBounds, hoursOverlap, sumHours, shiftHours, applyShiftWindow, salaryForRange,
    logDelta, logActionLabel, adjustStock,
    pageAll, isMissingSchema, captureError
  };
})(typeof window !== 'undefined' ? window : module.exports);
