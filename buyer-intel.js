// CardBreakPro — Buyer Intelligence (shared by owner.html, manager.html, breaker.html)
//
// ONE place for: loading buyer data, the segmentation rule (whale / cold /
// fading / regular / new), cadence, win-back math, collect-affinity and the
// health metrics. The three pages used to carry their own copies of this and
// they drifted — every rule here is the rule everywhere.
//
// Data path: the rollups come from the SQL functions in migrations/010
// (buyer_rollups, buyer_stream_facts, stream_category_mix). If the migration
// hasn't been run yet, fetchRollups falls back to computing the same numbers in
// the browser from buyer_purchases so nothing breaks — it's just slower.
(function (global) {
  'use strict';

  const PAGE = 1000;
  const COLD_MAX_DAYS = 120;          // past this a cold buyer is simply gone, not "going cold"
  const CONTACTED_WINDOW_DAYS = 7;    // a touch this recent sinks a cold buyer down the list
  const FADING_MIN_PURCHASE_DAYS = 3; // need >= 2 gaps to know someone's cadence
  const FADING_MIN_OVERDUE_DAYS = 10; // never call a weekly buyer "fading" after 8 days

  // ── tiny utils ───────────────────────────────────────────────────────────
  function daysSince(d) {
    if (!d) return Infinity;
    const t = new Date(d).getTime();
    return isNaN(t) ? Infinity : Math.floor((Date.now() - t) / 86400000);
  }
  function relDate(d) {
    if (!d) return 'Never';
    const n = daysSince(d);
    if (n === Infinity) return 'Never';
    if (n <= 0) return 'Today';
    if (n === 1) return '1 day ago';
    if (n < 7) return n + ' days ago';
    if (n < 30) return Math.floor(n / 7) + 'w ago';
    if (n < 365) return Math.floor(n / 30) + 'mo ago';
    return Math.floor(n / 365) + 'y ago';
  }
  function money(n) { n = Number(n) || 0; return '$' + (n >= 1000 ? (n / 1000).toFixed(1) + 'k' : Math.round(n)); }
  function mono(u) { const s = (u || '').replace(/[^a-z0-9]/gi, ''); return (s.slice(0, 2) || '?').toUpperCase(); }
  function isoDaysAgo(n) { const d = new Date(); d.setDate(d.getDate() - n); return d.toISOString().split('T')[0]; }
  function monthKey(dateStr) { return (dateStr || '').slice(0, 7); }

  // "relation/function/column does not exist" — the migration hasn't been run.
  function isMissingSchema(err) {
    if (!err) return false;
    const code = err.code || '';
    const msg = String(err.message || '');
    return /^(42P01|42883|42703|PGRST202|PGRST204|PGRST205)$/.test(code)
      || /does not exist|could not find|schema cache/i.test(msg);
  }

  async function pageAll(makeQuery) {
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

  // ── org settings ─────────────────────────────────────────────────────────
  async function loadOrgSettings(sb, orgId) {
    const out = { whaleMin: 1000, coldAfterDays: 21 };
    let r = await sb.from('organizations').select('whale_threshold, cold_after_days').eq('id', orgId).maybeSingle();
    if (r.error && isMissingSchema(r.error)) r = await sb.from('organizations').select('whale_threshold').eq('id', orgId).maybeSingle();
    if (!r.error && r.data) {
      if (r.data.whale_threshold != null) out.whaleMin = Number(r.data.whale_threshold) || 1000;
      if (r.data.cold_after_days != null) out.coldAfterDays = Math.max(7, Number(r.data.cold_after_days) || 21);
    }
    return out;
  }

  // ── buyers / hits ────────────────────────────────────────────────────────
  const BUYER_COLS = 'id,username,real_name,total_spent,total_breaks_purchased,total_streams_participated,last_purchase_date,first_seen_date,temperature,is_new_buyer,case_hits,last_cold_alert_at,fav_team,fav_player,fav_sport';
  const BUYER_COLS_EXT = BUYER_COLS + ',cold_notified_at,assigned_to';

  async function fetchBuyers(sb, orgId) {
    const q = cols => () => sb.from('buyers').select(cols).eq('organization_id', orgId).order('total_spent', { ascending: false });
    try { return await pageAll(q(BUYER_COLS_EXT)); }
    catch (e) { if (!isMissingSchema(e)) throw e; return await pageAll(q(BUYER_COLS)); }
  }

  // { counts: {buyer_id: n}, streams: {buyer_id: [stream_id|null,...]} } — derived
  // from the buyer_hits rows so the count can never disagree with the history.
  async function fetchHitCounts(sb, orgId) {
    const counts = {}, streams = {};
    const rows = await pageAll(() => sb.from('buyer_hits').select('buyer_id,stream_id').eq('organization_id', orgId));
    rows.forEach(h => {
      counts[h.buyer_id] = (counts[h.buyer_id] || 0) + 1;
      (streams[h.buyer_id] = streams[h.buyer_id] || []).push(h.stream_id || null);
    });
    return { counts, streams };
  }

  // stream_id -> channel_id for the org. Breakers can't read other breakers'
  // streams under RLS, so they pass {viaServer, token} and we use the service-
  // role endpoint instead.
  async function fetchStreamChannels(sb, orgId, opts) {
    opts = opts || {};
    if (opts.viaServer) {
      const resp = await fetch('/api/features?feature=stream&action=channelmap', { headers: { Authorization: 'Bearer ' + opts.token } });
      if (!resp.ok) { let m = 'HTTP ' + resp.status; try { m = (await resp.json()).error || m; } catch (e) {} throw new Error(m); }
      return (await resp.json()).streamChannels || {};
    }
    const out = {};
    const rows = await pageAll(() => sb.from('streams').select('id,channel_id').eq('org_id', orgId));
    rows.forEach(s => { if (s.channel_id) out[s.id] = s.channel_id; });
    return out;
  }

  // ── rollups ──────────────────────────────────────────────────────────────
  function emptyRoll() { return { spent: 0, breaks: 0, streams: 0, first: null, last: null, recent30: 0, prior30: 0, recent90: 0, purchaseDays: 0, medianGap: null }; }

  // Returns { lifetime: {buyer_id: roll}, byChannel: {buyer_id: {channel_id: roll}}, source }
  async function fetchRollups(sb, orgId, opts) {
    opts = opts || {};
    try {
      const rows = await pageAll(() => sb.rpc('buyer_rollups'));
      const lifetime = {}, byChannel = {};
      rows.forEach(r => {
        const roll = {
          spent: Number(r.spent) || 0, breaks: Number(r.breaks) || 0, streams: Number(r.streams) || 0,
          first: r.first_date, last: r.last_date,
          recent30: Number(r.recent30) || 0, prior30: Number(r.prior30) || 0, recent90: Number(r.recent90) || 0,
          purchaseDays: Number(r.purchase_days) || 0, medianGap: r.median_gap_days != null ? Number(r.median_gap_days) : null
        };
        if (r.is_total) lifetime[r.buyer_id] = roll;
        else if (r.channel_id) (byChannel[r.buyer_id] = byChannel[r.buyer_id] || {})[r.channel_id] = roll;
      });
      return { lifetime, byChannel, source: 'rpc' };
    } catch (e) {
      if (!isMissingSchema(e)) throw e;
    }
    // Fallback: same numbers, computed here from every purchase row.
    const streamCh = opts.streamChannels || await fetchStreamChannels(sb, orgId, opts);
    const s30 = isoDaysAgo(30), s60 = isoDaysAgo(60), s90 = isoDaysAgo(90);
    const purchases = await pageAll(() => sb.from('buyer_purchases').select('buyer_id,stream_id,amount,purchase_date').eq('organization_id', orgId));
    const lifetime = {}, byChannel = {}, streamSets = {}, dateSets = {};
    function add(roll, key, p, amt) {
      roll.spent += amt; roll.breaks += 1;
      if (p.stream_id) { (streamSets[key] = streamSets[key] || new Set()).add(p.stream_id); }
      const d = p.purchase_date;
      if (d) {
        if (!roll.first || d < roll.first) roll.first = d;
        if (!roll.last || d > roll.last) roll.last = d;
        if (d >= s30) roll.recent30 += amt; else if (d >= s60) roll.prior30 += amt;
        if (d >= s90) roll.recent90 += amt;
      }
    }
    purchases.forEach(p => {
      const amt = Number(p.amount) || 0;
      const lt = lifetime[p.buyer_id] = lifetime[p.buyer_id] || emptyRoll();
      add(lt, p.buyer_id, p, amt);
      if (p.purchase_date) (dateSets[p.buyer_id] = dateSets[p.buyer_id] || new Set()).add(p.purchase_date);
      const ch = p.stream_id ? streamCh[p.stream_id] : null;
      if (ch) {
        const bc = byChannel[p.buyer_id] = byChannel[p.buyer_id] || {};
        const roll = bc[ch] = bc[ch] || emptyRoll();
        add(roll, p.buyer_id + '|' + ch, p, amt);
      }
    });
    Object.keys(lifetime).forEach(id => {
      lifetime[id].streams = streamSets[id] ? streamSets[id].size : 0;
      const dates = Array.from(dateSets[id] || []).sort();
      lifetime[id].purchaseDays = dates.length;
      if (dates.length >= 2) {
        const gaps = [];
        for (let i = 1; i < dates.length; i++) gaps.push((new Date(dates[i]) - new Date(dates[i - 1])) / 86400000);
        gaps.sort((a, b) => a - b);
        const mid = Math.floor(gaps.length / 2);
        lifetime[id].medianGap = gaps.length % 2 ? gaps[mid] : (gaps[mid - 1] + gaps[mid]) / 2;
      }
      Object.keys(byChannel[id] || {}).forEach(ch => { byChannel[id][ch].streams = (streamSets[id + '|' + ch] || new Set()).size; });
    });
    return { lifetime, byChannel, source: 'client' };
  }

  // rows of buyer_stream_facts() — null if the migration isn't in yet
  async function fetchStreamFacts(sb) {
    try { return await pageAll(() => sb.rpc('buyer_stream_facts')); }
    catch (e) { if (isMissingSchema(e)) return null; throw e; }
  }

  // { stream_id: { category: units } } — null if the migration isn't in yet
  async function fetchCategoryMix(sb) {
    try {
      const rows = await pageAll(() => sb.rpc('stream_category_mix'));
      const out = {};
      rows.forEach(r => { (out[r.stream_id] = out[r.stream_id] || {})[r.category] = Number(r.units) || 0; });
      return out;
    } catch (e) { if (isMissingSchema(e)) return null; throw e; }
  }

  async function fetchTouches(sb, orgId, sinceDays) {
    try {
      let q = () => sb.from('buyer_touches')
        .select('id,buyer_id,user_id,channel,note,outcome,segment_at_touch,created_at')
        .eq('organization_id', orgId).order('created_at', { ascending: false });
      if (sinceDays) { const since = new Date(Date.now() - sinceDays * 86400000).toISOString(); const base = q; q = () => base().gte('created_at', since); }
      return await pageAll(q);
    } catch (e) { if (isMissingSchema(e)) return []; throw e; }
  }

  async function fetchBuyerTouches(sb, buyerId) {
    try {
      const { data, error } = await sb.from('buyer_touches')
        .select('id,buyer_id,user_id,channel,note,outcome,segment_at_touch,created_at')
        .eq('buyer_id', buyerId).order('created_at', { ascending: false }).limit(100);
      if (error) throw error;
      return data || [];
    } catch (e) { if (isMissingSchema(e)) return null; throw e; }
  }

  // Log an outreach. Also stamps buyers.last_cold_alert_at so the board's
  // "reached out" state (and older code paths) keep working.
  async function logTouch(sb, params) {
    const { orgId, buyerId, userId, channel, note, outcome, segment } = params;
    const nowIso = new Date().toISOString();
    const ins = await sb.from('buyer_touches').insert({
      organization_id: orgId, buyer_id: buyerId, user_id: userId || null,
      channel: channel || 'whatnot_dm', note: note || null, outcome: outcome || null, segment_at_touch: segment || null
    }).select('id').single();
    if (ins.error && !isMissingSchema(ins.error)) throw ins.error;
    const up = await sb.from('buyers').update({ last_cold_alert_at: nowIso }).eq('id', buyerId);
    if (up.error) throw up.error;
    return { touchId: ins.data ? ins.data.id : null, logged: !ins.error };
  }

  // ── segmentation ─────────────────────────────────────────────────────────
  // Effective figures for a buyer: per-account when a channel is selected,
  // lifetime otherwise. Lifetime prefers the rollup (computed from purchases)
  // and falls back to the cached buyers.total_* columns.
  function effective(b, rollups, channelId) {
    if (channelId) {
      const r = rollups && rollups.byChannel[b.id] && rollups.byChannel[b.id][channelId];
      return r ? Object.assign({}, r) : emptyRoll();
    }
    const lt = rollups && rollups.lifetime[b.id];
    if (lt) return Object.assign({}, lt);
    const r = emptyRoll();
    r.spent = Number(b.total_spent || 0); r.breaks = b.total_breaks_purchased || 0; r.streams = b.total_streams_participated || 0;
    r.first = b.first_seen_date; r.last = b.last_purchase_date;
    return r;
  }

  function inChannel(rollups, buyerId, channelId) {
    if (!channelId) return true;
    return !!(rollups && rollups.byChannel[buyerId] && rollups.byChannel[buyerId][channelId]);
  }

  // THE rule. Whale = spent >= whaleMin in the last 30 days. Going Cold = has
  // been whale-sized (lifetime) but quiet for coldAfterDays..120. New = one
  // stream. Everyone else is a Regular; a Regular who's overdue against their
  // own cadence is Fading — the early warning before Cold.
  function enrich(buyers, rollups, opts) {
    const whaleMin = Number(opts.whaleMin) || 1000;
    const coldAfter = Number(opts.coldAfterDays) || 21;
    const channelId = opts.channelId || '';
    buyers.forEach(b => {
      const e = effective(b, rollups, channelId);
      b._eSpent = e.spent; b._eBreaks = e.breaks; b._eStreams = e.streams;
      b._eFirst = e.first; b._eLast = e.last;
      b._eRec = e.recent30; b._ePri = e.prior30; b._eRec90 = e.recent90;
      b._recent30 = e.recent30;
      b._avgStream = e.streams > 0 ? e.spent / e.streams : e.spent;
      b._since = daysSince(e.last);
      b._purchaseDays = e.purchaseDays || 0; b._medianGap = e.medianGap;
      b._fading = false; b._newBig = false;
      b._inChannel = inChannel(rollups, b.id, channelId);

      if (b._eSpent <= 0) { b._tier = 'none'; return; }
      const activeWhale = b._eRec >= whaleMin;
      b._newBig = activeWhale && (b._eStreams || 0) <= 1;
      if (b._eSpent >= whaleMin && b._since >= coldAfter && b._since <= COLD_MAX_DAYS) { b._tier = 'cold'; return; }
      if (activeWhale) { b._tier = 'whale'; return; }
      if ((b._eStreams || 0) <= 1) { b._tier = 'new'; return; }
      b._tier = 'regular';
      if (b._purchaseDays >= FADING_MIN_PURCHASE_DAYS && b._medianGap != null && b._medianGap >= 1) {
        const due = Math.max(2 * b._medianGap, FADING_MIN_OVERDUE_DAYS);
        if (b._since > due && b._since <= COLD_MAX_DAYS) b._fading = true;
      }
    });
    return buyers;
  }

  function contactedRecently(b) { return !!(b.last_cold_alert_at && daysSince(b.last_cold_alert_at) <= CONTACTED_WINDOW_DAYS); }

  // Buckets + KPIs for the board. Expects enriched buyers.
  function segment(buyers) {
    const cold = [], whales = [], regulars = [], fresh = [];
    buyers.forEach(b => {
      if (b._tier === 'none' || b._inChannel === false) return;
      if (b._tier === 'cold') cold.push(b);
      else if (b._tier === 'whale') whales.push(b);
      else if (b._tier === 'new') fresh.push(b);
      else regulars.push(b);
    });
    // Un-contacted cold buyers first (act on them); already-reached ones sink.
    cold.sort((a, b) => {
      const ac = contactedRecently(a) ? 1 : 0, bc = contactedRecently(b) ? 1 : 0;
      if (ac !== bc) return ac - bc;
      return b._eSpent - a._eSpent;
    });
    whales.sort((a, b) => b._eSpent - a._eSpent);
    // Fading regulars float to the top of Regulars so they're seen.
    regulars.sort((a, b) => {
      const af = a._fading ? 1 : 0, bf = b._fading ? 1 : 0;
      if (af !== bf) return bf - af;
      return b._eSpent - a._eSpent;
    });
    fresh.sort((a, b) => b._eSpent - a._eSpent);
    const spenders = cold.length + whales.length + regulars.length + fresh.length;
    const fading = regulars.filter(b => b._fading);
    return {
      cold, whales, regulars, fresh, fading,
      spenders,
      whaleTotal: whales.length + cold.length,
      coldAtRisk: cold.reduce((s, b) => s + (b._eSpent || 0), 0),
      fadingAtRisk: fading.reduce((s, b) => s + (b._eSpent || 0), 0),
      rev30: [].concat(cold, whales, regulars, fresh).reduce((s, b) => s + (b._eRec || 0), 0)
    };
  }

  // ── win-back ─────────────────────────────────────────────────────────────
  // Of buyers we reached out to while cold/fading, how many bought again?
  // One attempt per buyer per episode: the earliest touch since their last
  // purchase counts; a purchase after that touch = returned. Touches under
  // 7 days old with no purchase yet are "pending" and don't count against you.
  function winbackStats(touches, buyersById) {
    const byBuyer = {};
    (touches || []).forEach(t => {
      if (t.segment_at_touch && t.segment_at_touch !== 'cold' && t.segment_at_touch !== 'fading') return;
      (byBuyer[t.buyer_id] = byBuyer[t.buyer_id] || []).push(t);
    });
    let attempts = 0, returned = 0, pending = 0;
    const returnedIds = [];
    Object.keys(byBuyer).forEach(id => {
      const b = buyersById[id]; if (!b) return;
      const ts = byBuyer[id].slice().sort((a, c) => new Date(a.created_at) - new Date(c.created_at));
      const last = b.last_purchase_date ? new Date(b.last_purchase_date + 'T23:59:59') : null;
      // Group into episodes: a touch starts a new episode if the buyer bought after the previous touch.
      let episodeStart = null;
      ts.forEach(t => {
        const tAt = new Date(t.created_at);
        if (episodeStart && last && last > episodeStart && last < tAt) episodeStart = null; // they came back, new episode
        if (!episodeStart) {
          episodeStart = tAt;
          const came = !!(last && last > tAt) || t.outcome === 'returned';
          if (came) { attempts++; returned++; returnedIds.push(id); }
          else if (daysSince(tAt) < CONTACTED_WINDOW_DAYS) pending++;
          else attempts++;
        }
      });
    });
    return { attempts, returned, pending, rate: attempts ? returned / attempts : null, returnedIds };
  }

  // ── affinity ─────────────────────────────────────────────────────────────
  // What does each buyer collect? Weight every stream's category mix (from the
  // products actually opened) by how much the buyer spent in that stream.
  // Returns { buyer_id: [{category, share}] } sorted by share desc.
  function buildAffinity(facts, mix) {
    const out = {};
    if (!facts || !mix) return out;
    const totals = {}, sums = {};
    facts.forEach(f => {
      const m = f.stream_id && mix[f.stream_id]; if (!m) return;
      const units = Object.values(m).reduce((s, v) => s + v, 0); if (!units) return;
      const amt = Number(f.amount) || 0; if (amt <= 0) return;
      const t = totals[f.buyer_id] = totals[f.buyer_id] || {};
      Object.keys(m).forEach(c => { const w = (m[c] / units) * amt; t[c] = (t[c] || 0) + w; sums[f.buyer_id] = (sums[f.buyer_id] || 0) + w; });
    });
    Object.keys(totals).forEach(id => {
      const s = sums[id] || 1;
      out[id] = Object.keys(totals[id]).map(c => ({ category: c, share: totals[id][c] / s })).sort((a, b) => b.share - a.share);
    });
    return out;
  }
  function topAffinity(aff, buyerId) {
    const a = aff && aff[buyerId];
    if (!a || !a.length || a[0].category === 'Uncategorized') return null;
    return a[0];
  }

  // ── health ───────────────────────────────────────────────────────────────
  // Trends the board can't show: are you growing or rotting, and who's driving it.
  function healthMetrics(buyers, facts, opts) {
    opts = opts || {};
    const whaleMin = Number(opts.whaleMin) || 1000;
    const channelId = opts.channelId || '';
    const months = opts.months || 6;
    const rows = (facts || []).filter(f => f.purchase_date && (!channelId || f.channel_id === channelId));
    const buyersById = {}; buyers.forEach(b => { buyersById[b.id] = b; });

    // Per-buyer timeline
    const perBuyer = {};
    rows.forEach(f => {
      const pb = perBuyer[f.buyer_id] = perBuyer[f.buyer_id] || { first: null, firstBreaker: null, firstStream: null, streams: new Set(), dates: new Set(), byWindow: { cur: 0, prev: 0 }, rev90: 0 };
      const amt = Number(f.amount) || 0;
      if (!pb.first || f.purchase_date < pb.first) { pb.first = f.purchase_date; pb.firstBreaker = f.breaker_id || null; pb.firstStream = f.stream_id; }
      if (f.stream_id) pb.streams.add(f.stream_id);
      pb.dates.add(f.purchase_date);
      const ds = daysSince(f.purchase_date);
      if (ds <= 30) pb.byWindow.cur += amt; else if (ds <= 60) pb.byWindow.prev += amt;
      if (ds <= 90) pb.rev90 += amt;
    });

    // 1. New buyers per month + cohort conversion (bought a 2nd stream)
    const now = new Date();
    const monthKeys = [];
    for (let i = months - 1; i >= 0; i--) { const d = new Date(now.getFullYear(), now.getMonth() - i, 1); monthKeys.push(d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0')); }
    const cohorts = monthKeys.map(k => ({ month: k, newBuyers: 0, converted: 0, revenue: 0 }));
    const cohortIdx = {}; cohorts.forEach((c, i) => { cohortIdx[c.month] = i; });
    Object.keys(perBuyer).forEach(id => {
      const pb = perBuyer[id];
      const k = monthKey(pb.first);
      if (cohortIdx[k] == null) return;
      const c = cohorts[cohortIdx[k]];
      c.newBuyers++;
      if (pb.streams.size >= 2) c.converted++;
    });
    rows.forEach(f => { const k = monthKey(f.purchase_date); if (cohortIdx[k] != null) cohorts[cohortIdx[k]].revenue += Number(f.amount) || 0; });
    const thisMonth = monthKeys[monthKeys.length - 1];
    cohorts.forEach(c => { c.tooEarly = c.month === thisMonth; c.rate = c.newBuyers && !c.tooEarly ? c.converted / c.newBuyers : null; });

    // 2. Whale churn: whale in [60,30) vs whale in [30,0]
    const prevWhales = new Set(), curWhales = new Set();
    Object.keys(perBuyer).forEach(id => { if (perBuyer[id].byWindow.prev >= whaleMin) prevWhales.add(id); if (perBuyer[id].byWindow.cur >= whaleMin) curWhales.add(id); });
    const churned = Array.from(prevWhales).filter(id => !curWhales.has(id));
    const gained  = Array.from(curWhales).filter(id => !prevWhales.has(id));
    const retained = Array.from(prevWhales).filter(id => curWhales.has(id));

    // 3. Revenue concentration (last 90 days)
    const rev = Object.keys(perBuyer).map(id => ({ id, rev: perBuyer[id].rev90 })).filter(x => x.rev > 0).sort((a, b) => b.rev - a.rev);
    const total90 = rev.reduce((s, x) => s + x.rev, 0);
    const top10 = rev.slice(0, 10).reduce((s, x) => s + x.rev, 0);
    const top1 = rev.length ? rev[0].rev : 0;

    // 4. Breaker attribution (last 90 days for activity; lifetime for origination)
    const breakers = {};
    function bk(id) { return breakers[id] = breakers[id] || { breaker_id: id, revenue90: 0, buyers90: new Set(), whales90: new Set(), originated: 0, originatedMature: 0, originatedConverted: 0, newBuyers90: 0 }; }
    rows.forEach(f => {
      if (!f.breaker_id) return;
      if (daysSince(f.purchase_date) > 90) return;
      const s = bk(f.breaker_id);
      s.revenue90 += Number(f.amount) || 0;
      s.buyers90.add(f.buyer_id);
      const b = buyersById[f.buyer_id];
      if (b && (b._tier === 'whale' || b._tier === 'cold')) s.whales90.add(f.buyer_id);
    });
    Object.keys(perBuyer).forEach(id => {
      const pb = perBuyer[id]; if (!pb.firstBreaker) return;
      const s = bk(pb.firstBreaker);
      s.originated++;
      if (daysSince(pb.first) <= 90) s.newBuyers90++;
      if (daysSince(pb.first) >= 30) { s.originatedMature++; if (pb.streams.size >= 2) s.originatedConverted++; }
    });
    const breakerList = Object.values(breakers).map(s => ({
      breaker_id: s.breaker_id, revenue90: s.revenue90, buyers90: s.buyers90.size, whales90: s.whales90.size,
      newBuyers90: s.newBuyers90, originated: s.originated,
      conversion: s.originatedMature ? s.originatedConverted / s.originatedMature : null, originatedMature: s.originatedMature
    })).sort((a, b) => b.revenue90 - a.revenue90);

    return {
      cohorts,
      whaleChurn: { prev: prevWhales.size, cur: curWhales.size, churned, gained, retained },
      concentration: { total90, top10, top10Share: total90 ? top10 / total90 : 0, top1, top1Share: total90 ? top1 / total90 : 0, buyers: rev.length },
      breakers: breakerList
    };
  }

  // ── data freshness ───────────────────────────────────────────────────────
  // Closed streams with no slips imported and not marked "no slips". Owner and
  // manager see the whole org (RLS); a breaker only sees their own streams,
  // which is exactly the list they need to act on.
  async function fetchSlipStatus(sb, orgId, opts) {
    opts = opts || {};
    const days = opts.days || 45;
    const since = isoDaysAgo(days);
    let q = sb.from('streams')
      .select('id,stream_key,break_date,breaker_id,closed_at,final_sales,slips_imported_at,slips_skipped_at')
      .eq('org_id', orgId).eq('status', 'closed').gte('break_date', since)
      .order('break_date', { ascending: false });
    if (opts.breakerId) q = q.eq('breaker_id', opts.breakerId);
    const { data, error } = await q;
    if (error) {
      if (isMissingSchema(error)) return { available: false, missing: [], currentThrough: null, total: 0 };
      throw error;
    }
    const rows = data || [];
    const missing = rows.filter(s => !s.slips_imported_at && !s.slips_skipped_at);
    const imported = rows.filter(s => s.slips_imported_at).map(s => s.break_date).sort();
    return { available: true, missing, total: rows.length, currentThrough: imported.length ? imported[imported.length - 1] : null };
  }

  global.BuyerIntel = {
    COLD_MAX_DAYS, CONTACTED_WINDOW_DAYS,
    daysSince, relDate, money, mono, isoDaysAgo, isMissingSchema, pageAll,
    loadOrgSettings, fetchBuyers, fetchHitCounts, fetchStreamChannels, fetchRollups,
    fetchStreamFacts, fetchCategoryMix, fetchTouches, fetchBuyerTouches, logTouch,
    effective, inChannel, enrich, segment, contactedRecently,
    winbackStats, buildAffinity, topAffinity, healthMetrics, fetchSlipStatus
  };
})(window);
