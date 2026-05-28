const { createClient } = require('@supabase/supabase-js');

module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  let body;
  try { body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body; }
  catch (e) { return res.status(400).json({ error: 'Invalid JSON' }); }

  const { orgId, streamId, buyers, streamDate, importedBy, rawFilename } = body;
  if (!orgId || !Array.isArray(buyers) || buyers.length === 0) {
    return res.status(400).json({ error: 'Missing required fields: orgId, buyers' });
  }

  const sb = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY
  );

  const purchaseDate = parseDate(streamDate);
  let importId = null;

  // Create import record
  try {
    const { data: imp } = await sb.from('stream_slip_imports').insert({
      organization_id: orgId,
      stream_id: streamId || null,
      imported_by: importedBy || null,
      buyers_found: buyers.length,
      new_buyers_found: buyers.filter(b => b.isNew).length,
      total_revenue_parsed: buyers.reduce((s, b) => s + (Number(b.totalSpent) || 0), 0),
      raw_filename: rawFilename || null,
      status: 'processing'
    }).select('id').single();
    if (imp) importId = imp.id;
  } catch (e) { console.warn('Import record failed:', e.message); }

  const errors = [];
  let processed = 0;

  for (const buyer of buyers) {
    if (!buyer.username) continue;
    try {
      await processBuyer(sb, orgId, streamId, buyer, purchaseDate);
      processed++;
    } catch (e) {
      errors.push({ username: buyer.username, error: e.message });
      console.error('Buyer process error for', buyer.username, e);
    }
  }

  if (importId) {
    await sb.from('stream_slip_imports').update({
      status: 'complete',
      error_message: errors.length > 0 ? JSON.stringify(errors.slice(0, 5)) : null
    }).eq('id', importId).catch(() => {});
  }

  return res.status(200).json({ success: true, processed, errors: errors.length, importId });
};

async function processBuyer(sb, orgId, streamId, buyerData, purchaseDate) {
  const { username, isNew, realName, items } = buyerData;
  const uname = username.toLowerCase();
  const totalSpent = Number(buyerData.totalSpent) || 0;

  // Look up existing buyer
  const { data: existing } = await sb.from('buyers')
    .select('id, total_spent, total_breaks_purchased, total_streams_participated')
    .eq('organization_id', orgId)
    .eq('platform', 'whatnot')
    .eq('username', uname)
    .maybeSingle();

  let buyerId;

  if (existing) {
    buyerId = existing.id;

    // Check if this stream was already counted
    let streamIncrement = 0;
    if (streamId) {
      const { count } = await sb.from('buyer_purchases')
        .select('id', { count: 'exact', head: true })
        .eq('buyer_id', existing.id)
        .eq('stream_id', streamId);
      if ((count || 0) === 0) streamIncrement = 1;
    }

    await sb.from('buyers').update({
      total_spent: (Number(existing.total_spent) || 0) + totalSpent,
      total_breaks_purchased: (existing.total_breaks_purchased || 0) + (items?.length || 0),
      total_streams_participated: (existing.total_streams_participated || 0) + streamIncrement,
      last_purchase_date: purchaseDate,
      temperature: computeTemp(purchaseDate),
      ...(realName ? { real_name: realName } : {}),
      updated_at: new Date().toISOString()
    }).eq('id', existing.id);
  } else {
    const { data: newBuyer, error } = await sb.from('buyers').insert({
      organization_id: orgId,
      platform: 'whatnot',
      username: uname,
      real_name: realName || null,
      first_seen_date: purchaseDate,
      total_spent: totalSpent,
      total_breaks_purchased: items?.length || 0,
      total_streams_participated: 1,
      last_purchase_date: purchaseDate,
      temperature: computeTemp(purchaseDate),
      is_new_buyer: isNew || false
    }).select('id').single();
    if (error) throw error;
    buyerId = newBuyer.id;
  }

  // Insert purchase records
  for (const item of (items || [])) {
    await sb.from('buyer_purchases').insert({
      organization_id: orgId,
      buyer_id: buyerId,
      stream_id: streamId || null,
      break_name: item.breakName || '',
      order_number: item.orderNumber || null,
      amount: Number(item.amount) || 0,
      purchase_date: purchaseDate,
      platform: 'whatnot'
    }).catch(e => console.warn('Purchase insert error:', e.message));
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
