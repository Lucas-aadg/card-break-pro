const { createClient } = require('@supabase/supabase-js');

// Idempotent, batched slip importer.
// buyer_purchases is the source of truth; buyers.total_* is a cache RECOMPUTED
// from it. Two modes:
//   merge   (default) — rows for the SAME order numbers are replaced, everything
//                       else already on the stream is kept. Uploading a slip
//                       export in two parts, or re-uploading after adding a
//                       page, adds up instead of the last file wiping the first.
//   replace           — the old behaviour: drop every purchase on the stream,
//                       then insert this file. Owner-only "start over".
// Every attempt is recorded in stream_slip_imports (status complete/failed) so
// a failed import can never again disappear without a trace.

const MAX_BUYERS = 2000;   // slips can be big; batched writes keep us well under the serverless time limit
const CHUNK = 400;         // rows per bulk insert
const IN_CHUNK = 100;      // ids per .in() filter
const APP_URL = process.env.APP_URL || 'https://cardbreakpro.com';

module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  try { return await handleImport(req, res); }
  catch (e) { console.error('process-import fatal:', e); return res.status(500).json({ error: e && e.message ? e.message : 'Import failed' }); }
};

function chunk(arr, n) { const out = []; for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n)); return out; }
function round2(n) { return Math.round(((Number(n) || 0) + Number.EPSILON) * 100) / 100; }
function isMissingColumn(err) { return /column .* does not exist|schema cache|could not find the/i.test(String(err && err.message || '')); }

// Insert an import record; if migration 014's extra columns aren't there yet,
// retry with the original columns only. Never throws.
async function recordImport(sb, row) {
  const extras = ['mode', 'purchases_count', 'orders_replaced', 'parse_source', 'file_size', 'error_message'];
  let r = await sb.from('stream_slip_imports').insert(row).select('id').single();
  if (r.error && isMissingColumn(r.error)) {
    const slim = Object.assign({}, row);
    extras.forEach(k => { if (k !== 'error_message') delete slim[k]; });
    r = await sb.from('stream_slip_imports').insert(slim).select('id').single();
    if (r.error && isMissingColumn(r.error)) { delete slim.error_message; r = await sb.from('stream_slip_imports').insert(slim).select('id').single(); }
  }
  if (r.error) console.error('stream_slip_imports insert failed:', r.error.message);
  return r.data ? r.data.id : null;
}

async function handleImport(req, res) {
  let body;
  try { body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body; }
  catch (e) { return res.status(400).json({ error: 'Invalid JSON' }); }

  const { orgId, streamId, buyers, streamDate, importedBy, rawFilename, parseSource, fileSize } = body;
  const mode = body.mode === 'replace' ? 'replace' : 'merge';
  if (!orgId || !Array.isArray(buyers) || buyers.length === 0) return res.status(400).json({ error: 'Missing required fields: orgId, buyers' });
  if (!/^[0-9a-f-]{36}$/.test(orgId)) return res.status(400).json({ error: 'Invalid orgId' });
  // streamId is REQUIRED — imports are keyed to a stream so a re-import stays idempotent.
  if (!streamId || !/^[0-9a-f-]{36}$/.test(streamId)) return res.status(400).json({ error: 'A valid streamId is required for import.' });
  if (buyers.length > MAX_BUYERS) return res.status(400).json({ error: 'Too many buyers in a single import (max ' + MAX_BUYERS + ').' });

  const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY);

  // Verify caller is authenticated and belongs to the claimed org
  const token = (req.headers.authorization || '').replace('Bearer ', '').trim();
  if (!token) return res.status(401).json({ error: 'Missing auth token' });
  const { data: { user }, error: authErr } = await sb.auth.getUser(token);
  if (authErr || !user) return res.status(401).json({ error: 'Invalid token' });
  const { data: callerProfile } = await sb.from('profiles').select('org_id').eq('id', user.id).maybeSingle();
  if (!callerProfile || callerProfile.org_id !== orgId) return res.status(403).json({ error: 'Forbidden' });

  const purchaseDate = parseDate(streamDate);

  // ── Normalize + de-dupe incoming buyers by username; merge their items ──
  const byUname = {};
  for (const b of buyers) {
    if (!b || !b.username) continue;
    const uname = String(b.username).toLowerCase().trim();
    if (!uname) continue;
    const items = Array.isArray(b.items) ? b.items : [];
    const spent = Number(b.totalSpent) || 0;
    if (spent === 0 && items.length === 0) continue; // truly empty row
    if (!byUname[uname]) byUname[uname] = { realName: b.realName || null, isNew: !!b.isNew, items: [] };
    for (const it of items) byUname[uname].items.push({ breakName: (it.breakName || '').slice(0, 120), orderNumber: it.orderNumber ? String(it.orderNumber) : null, amount: Number(it.amount) || 0 });
    if (b.realName && !byUname[uname].realName) byUname[uname].realName = b.realName;
  }
  const unames = Object.keys(byUname);
  if (!unames.length) return res.status(400).json({ error: 'No valid buyers to import.' });

  const importMeta = {
    organization_id: orgId, stream_id: streamId, imported_by: importedBy || null,
    raw_filename: rawFilename || null, mode, parse_source: parseSource || null,
    file_size: Number.isFinite(Number(fileSize)) ? Number(fileSize) : null
  };

  try {
    // ── 1. Buyers previously tied to this stream (so removed ones also recompute) ──
    const oldBuyerIds = new Set();
    let f = 0;
    while (true) {
      const { data, error } = await sb.from('buyer_purchases').select('buyer_id').eq('organization_id', orgId).eq('stream_id', streamId).range(f, f + 999);
      if (error) throw new Error('read old purchases failed: ' + error.message);
      (data || []).forEach(r => oldBuyerIds.add(r.buyer_id));
      if (!data || data.length < 1000) break;
      f += 1000;
    }

    // ── 2. replace mode: drop everything on the stream first ──
    if (mode === 'replace') {
      const { error: delErr } = await sb.from('buyer_purchases').delete().eq('organization_id', orgId).eq('stream_id', streamId);
      if (delErr) throw new Error('clear old purchases failed: ' + delErr.message);
    }

    // ── 3. Resolve buyer ids (fetch existing, bulk-create the new ones) ──
    const unameToId = {};
    for (const grp of chunk(unames, 200)) {
      const { data, error } = await sb.from('buyers').select('id, username').eq('organization_id', orgId).eq('platform', 'whatnot').in('username', grp);
      if (error) throw new Error('lookup buyers failed: ' + error.message);
      (data || []).forEach(r => { unameToId[r.username] = r.id; });
    }
    const newUnames = unames.filter(u => !unameToId[u]);
    if (newUnames.length) {
      const rows = newUnames.map(u => ({
        organization_id: orgId, platform: 'whatnot', username: u,
        real_name: byUname[u].realName || null,
        first_seen_date: purchaseDate,
        total_spent: 0, total_breaks_purchased: 0, total_streams_participated: 0,
        last_purchase_date: purchaseDate, temperature: computeTemp(purchaseDate), is_new_buyer: !!byUname[u].isNew
      }));
      for (const grp of chunk(rows, CHUNK)) {
        const { error } = await sb.from('buyers').insert(grp);
        // A concurrent import may have created the same username — ignore and re-fetch below
        if (error && !/duplicate key|unique/i.test(error.message)) throw new Error('create buyers failed: ' + error.message);
      }
      for (const grp of chunk(newUnames, 200)) {
        const { data, error } = await sb.from('buyers').select('id, username').eq('organization_id', orgId).eq('platform', 'whatnot').in('username', grp);
        if (error) throw new Error('lookup new buyers failed: ' + error.message);
        (data || []).forEach(r => { unameToId[r.username] = r.id; });
      }
    }

    // ── 4. Build this file's purchase rows ──
    const purchRows = [];
    for (const u of unames) {
      const id = unameToId[u]; if (!id) continue;
      for (const it of byUname[u].items) {
        purchRows.push({ organization_id: orgId, buyer_id: id, stream_id: streamId, break_name: it.breakName, order_number: it.orderNumber, amount: it.amount, purchase_date: purchaseDate, platform: 'whatnot' });
      }
    }

    // ── 4b. merge mode: replace only what this file re-imports ──
    // Same order number on the same stream → the new row wins (a re-upload
    // never double-counts). Rows without an order number can't be matched, so
    // for the buyers in THIS file their order-less rows are replaced too.
    let ordersReplaced = 0;
    if (mode === 'merge') {
      const orderNums = Array.from(new Set(purchRows.map(r => r.order_number).filter(Boolean)));
      for (const grp of chunk(orderNums, IN_CHUNK)) {
        const { data, error } = await sb.from('buyer_purchases').delete().eq('organization_id', orgId).eq('stream_id', streamId).in('order_number', grp).select('id');
        if (error) throw new Error('replace matching orders failed: ' + error.message);
        ordersReplaced += (data || []).length;
      }
      const orderlessBuyers = Array.from(new Set(purchRows.filter(r => !r.order_number).map(r => r.buyer_id)));
      for (const grp of chunk(orderlessBuyers, IN_CHUNK)) {
        const { error } = await sb.from('buyer_purchases').delete().eq('organization_id', orgId).eq('stream_id', streamId).is('order_number', null).in('buyer_id', grp);
        if (error) throw new Error('replace order-less rows failed: ' + error.message);
      }
    }

    // ── 5. Bulk-insert ──
    for (const grp of chunk(purchRows, CHUNK)) {
      const { error } = await sb.from('buyer_purchases').insert(grp);
      if (error) throw new Error('insert purchases failed: ' + error.message);
    }

    // ── 6. Recompute totals from buyer_purchases (idempotent, concurrency-safe) ──
    const affected = new Set();
    unames.forEach(u => { if (unameToId[u]) affected.add(unameToId[u]); });
    oldBuyerIds.forEach(id => affected.add(id));
    const affectedIds = Array.from(affected);

    const idToRealName = {};
    unames.forEach(u => { if (byUname[u].realName && unameToId[u]) idToRealName[unameToId[u]] = byUname[u].realName; });
    const nowIso = new Date().toISOString();

    // One SQL statement for all affected buyers (migration 013). A 2,000-buyer
    // slip used to be 2,000 round-trips against a 60s limit (AUDIT SC-7).
    let recomputed = false;
    for (let i = 0; i < affectedIds.length; i += 500) {
      const r = await sb.rpc('recompute_buyer_totals', { p_org: orgId, p_ids: affectedIds.slice(i, i + 500) });
      if (r.error) { if (!/does not exist|could not find|schema cache/i.test(r.error.message || '')) throw new Error('recompute failed: ' + r.error.message); recomputed = false; break; }
      recomputed = true;
    }
    if (recomputed) {
      // Real names come from the slip, not the purchases — a small separate write
      for (const id of Object.keys(idToRealName)) {
        await sb.from('buyers').update({ real_name: idToRealName[id], updated_at: nowIso }).eq('id', id).eq('organization_id', orgId);
      }
    }

    const agg = {};
    if (!recomputed) {
    affectedIds.forEach(id => { agg[id] = { spent: 0, breaks: 0, streams: new Set(), last: null }; });
    for (const grp of chunk(affectedIds, IN_CHUNK)) {
      let pf = 0;
      while (true) {
        const { data, error } = await sb.from('buyer_purchases').select('buyer_id, amount, purchase_date, stream_id').in('buyer_id', grp).range(pf, pf + 999);
        if (error) throw new Error('recompute read failed: ' + error.message);
        (data || []).forEach(p => {
          const a = agg[p.buyer_id]; if (!a) return;
          a.spent += Number(p.amount) || 0;
          a.breaks += 1;
          if (p.stream_id) a.streams.add(p.stream_id);
          if (p.purchase_date && (!a.last || p.purchase_date > a.last)) a.last = p.purchase_date;
        });
        if (!data || data.length < 1000) break;
        pf += 1000;
      }
    }

    const updateOne = async (id) => {
      const a = agg[id];
      const patch = {
        total_spent: round2(a.spent),
        total_breaks_purchased: a.breaks,
        total_streams_participated: a.streams.size,
        last_purchase_date: a.last,
        temperature: computeTemp(a.last),
        updated_at: nowIso
      };
      if (a.breaks > 0) patch.is_new_buyer = false;
      if (idToRealName[id]) patch.real_name = idToRealName[id];
      const { error } = await sb.from('buyers').update(patch).eq('id', id).eq('organization_id', orgId);
      if (error) throw new Error('recompute update failed: ' + error.message);
    };
    // Parallel in small batches — many single-row updates, but wall-clock stays low.
    for (const grp of chunk(affectedIds, 25)) await Promise.all(grp.map(updateOne));
    } // end fallback (migration 013 not run)

    // ── 7. Record the attempt (appended — history is kept) ──
    const importId = await recordImport(sb, Object.assign({}, importMeta, {
      buyers_found: unames.length,
      new_buyers_found: newUnames.length,
      total_revenue_parsed: round2(purchRows.reduce((s, r) => s + (r.amount || 0), 0)),
      purchases_count: purchRows.length,
      orders_replaced: ordersReplaced,
      status: 'complete'
    }));

    // ── 8. Stamp the stream (data freshness) + recap the breaker ──
    // Both are best-effort: the import is already committed and idempotent.
    await sb.from('streams').update({ slips_imported_at: nowIso }).eq('id', streamId).eq('org_id', orgId).then(null, () => {});
    try {
      const { data: stream } = await sb.from('streams').select('breaker_id, stream_key').eq('id', streamId).maybeSingle();
      if (stream && stream.breaker_id) {
        const totals = {};
        purchRows.forEach(r => { totals[r.buyer_id] = (totals[r.buyer_id] || 0) + (r.amount || 0); });
        const idToUname = {};
        unames.forEach(u => { if (unameToId[u]) idToUname[unameToId[u]] = u; });
        const ranked = Object.entries(totals).sort((a, b) => b[1] - a[1]);
        const rev = purchRows.reduce((s, r) => s + (r.amount || 0), 0);
        const { data: org } = await sb.from('organizations').select('whale_threshold').eq('id', orgId).maybeSingle();
        const whaleMin = Number(org && org.whale_threshold) || 1000;
        const bigSpenders = ranked.filter(([, v]) => v >= whaleMin).length;
        const top = ranked.slice(0, 3).map(([id, v]) => '@' + (idToUname[id] || '?') + ' $' + Math.round(v)).join(', ');
        const body = unames.length + ' buyers · ' + newUnames.length + ' first-timer' + (newUnames.length === 1 ? '' : 's') + ' · $' + Math.round(rev).toLocaleString('en-US') + ' in orders' +
          (top ? ' · Top: ' + top : '') +
          (bigSpenders ? ' · ' + bigSpenders + ' whale-sized spend' + (bigSpenders > 1 ? 's' : '') + ' tonight' : '') +
          (newUnames.length ? '. Shout out the first-timers next stream — that\'s how they become regulars.' : '.');
        await sb.from('notifications').insert({
          organization_id: orgId, user_id: stream.breaker_id, type: 'stream_recap',
          title: 'Recap: ' + (stream.stream_key || 'stream') + ' — ' + unames.length + ' buyers',
          body, action_url: APP_URL + '/break?tab=buyers'
        }).then(null, () => {});
      }
    } catch (e) { console.error('recap notification failed:', e && e.message); }

    return res.status(200).json({
      success: true,
      mode,
      processed: unames.length,
      newBuyers: newUnames.length,
      purchases: purchRows.length,
      ordersReplaced,
      importId
    });
  } catch (e) {
    console.error('process-import error:', e);
    // The failure itself is recorded — a silent "didn't register" is no longer possible.
    await recordImport(sb, Object.assign({}, importMeta, {
      buyers_found: unames.length, new_buyers_found: 0, total_revenue_parsed: 0,
      status: 'failed', error_message: String(e && e.message || e).slice(0, 1000)
    }));
    // Idempotent by design: the client can safely retry the same import.
    return res.status(500).json({ error: (e && e.message ? e.message : 'Import failed') + ' — safe to try the import again.' });
  }
}

function computeTemp(dateStr) {
  if (!dateStr) return 'cold';
  const days = Math.floor((Date.now() - new Date(dateStr).getTime()) / 86400000);
  if (days <= 7) return 'hot';
  if (days <= 20) return 'warm';
  return 'cold';
}

function parseDate(str) {
  if (!str) return new Date().toISOString().split('T')[0];
  try {
    const d = new Date(str);
    if (!isNaN(d.getTime())) return d.toISOString().split('T')[0];
  } catch (e) {}
  return new Date().toISOString().split('T')[0];
}
