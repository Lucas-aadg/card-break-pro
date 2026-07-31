const { createClient } = require('@supabase/supabase-js');

// Idempotent, batched slip importer.
// buyer_purchases is the source of truth; buyers.total_* is a cache RECOMPUTED
// from it. Re-importing the same stream deletes that stream's purchases, inserts
// the new set, then recomputes each affected buyer's totals from ALL their
// remaining purchases. Running it twice yields the same result (no double-count),
// a partial failure is fixed by simply retrying, and there's no read-modify-write
// on totals so concurrent imports can't lose each other's revenue.

const MAX_BUYERS = 2000;   // slips can be big; batched writes keep us well under the serverless time limit
const CHUNK = 400;         // rows per bulk insert
const IN_CHUNK = 100;      // ids per .in() filter

module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  try { return await handleImport(req, res); }
  catch (e) { console.error('process-import fatal:', e); return res.status(500).json({ error: e && e.message ? e.message : 'Import failed' }); }
};

function chunk(arr, n) { const out = []; for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n)); return out; }
function round2(n) { return Math.round(((Number(n) || 0) + Number.EPSILON) * 100) / 100; }

async function handleImport(req, res) {
  let body;
  try { body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body; }
  catch (e) { return res.status(400).json({ error: 'Invalid JSON' }); }

  const { orgId, streamId, buyers, streamDate, importedBy, rawFilename } = body;
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
    for (const it of items) byUname[uname].items.push({ breakName: (it.breakName || '').slice(0, 120), orderNumber: it.orderNumber || null, amount: Number(it.amount) || 0 });
    if (b.realName && !byUname[uname].realName) byUname[uname].realName = b.realName;
  }
  const unames = Object.keys(byUname);
  if (!unames.length) return res.status(400).json({ error: 'No valid buyers to import.' });

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

    // ── 2. Idempotent reset: drop this stream's purchases + old import record ──
    const { error: delErr } = await sb.from('buyer_purchases').delete().eq('organization_id', orgId).eq('stream_id', streamId);
    if (delErr) throw new Error('clear old purchases failed: ' + delErr.message);
    await sb.from('stream_slip_imports').delete().eq('organization_id', orgId).eq('stream_id', streamId).then(null, () => {});

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

    // ── 4. Bulk-insert this stream's purchases ──
    const purchRows = [];
    for (const u of unames) {
      const id = unameToId[u]; if (!id) continue;
      for (const it of byUname[u].items) {
        purchRows.push({ organization_id: orgId, buyer_id: id, stream_id: streamId, break_name: it.breakName, order_number: it.orderNumber, amount: it.amount, purchase_date: purchaseDate, platform: 'whatnot' });
      }
    }
    for (const grp of chunk(purchRows, CHUNK)) {
      const { error } = await sb.from('buyer_purchases').insert(grp);
      if (error) throw new Error('insert purchases failed: ' + error.message);
    }

    // ── 5. Recompute totals from buyer_purchases (idempotent, concurrency-safe) ──
    const affected = new Set();
    unames.forEach(u => { if (unameToId[u]) affected.add(unameToId[u]); });
    oldBuyerIds.forEach(id => affected.add(id));
    const affectedIds = Array.from(affected);

    const agg = {};
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

    const idToRealName = {};
    unames.forEach(u => { if (byUname[u].realName && unameToId[u]) idToRealName[unameToId[u]] = byUname[u].realName; });

    const nowIso = new Date().toISOString();
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

    // ── 6. Record the import ──
    let importId = null;
    const impRes = await sb.from('stream_slip_imports').insert({
      organization_id: orgId, stream_id: streamId, imported_by: importedBy || null,
      buyers_found: unames.length,
      new_buyers_found: newUnames.length,
      total_revenue_parsed: round2(purchRows.reduce((s, r) => s + (r.amount || 0), 0)),
      raw_filename: rawFilename || null, status: 'complete'
    }).select('id').single();
    if (!impRes.error && impRes.data) importId = impRes.data.id;

    return res.status(200).json({
      success: true,
      processed: unames.length,
      newBuyers: newUnames.length,
      purchases: purchRows.length,
      importId
    });
  } catch (e) {
    console.error('process-import error:', e);
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
