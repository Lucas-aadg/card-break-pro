// CardBreakPro — Consolidated Features API (Prompt 12A)
// Handles all routes for: Chat, Leaderboard, Milestones, Templates, Sorter Splits, Goals
// Also absorbs: notify-stream-closed, notify-inventory-low (keeping function count at 11, under Vercel Hobby 12-limit)
//
// Routing via ?feature= and ?action= query params.
// vercel.json rewrites map pretty REST paths to these params.

const { createClient } = require('@supabase/supabase-js');
const { sendEmail }    = require('./send-email');
const APP_URL          = process.env.APP_URL || 'https://cardbreakpro.com';

// ─── Supabase service-role client ────────────────────────────────────────────
function makeSb() {
  return createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY
  );
}

// ─── Auth helper — returns { user, profile } or { err: { status, msg } } ─────
async function authenticate(req, sb) {
  const token = (req.headers.authorization || '').replace('Bearer ', '').trim();
  if (!token) return { err: { status: 401, msg: 'Missing auth token' } };
  const { data: { user }, error } = await sb.auth.getUser(token);
  if (error || !user) return { err: { status: 401, msg: 'Invalid token' } };
  const { data: profile } = await sb.from('profiles')
    .select('id, org_id, role, display_name')
    .eq('id', user.id)
    .maybeSingle();
  if (!profile || !profile.org_id) return { err: { status: 401, msg: 'Profile not found' } };
  return { user, profile };
}

function fail(res, status, msg) { return res.status(status).json({ error: msg }); }

// ─── Main dispatcher ──────────────────────────────────────────────────────────
module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PATCH,DELETE,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const { feature, action } = req.query;
  const sb = makeSb();

  try {
    switch (feature) {
      case 'chat':          return await chatHandler(req, res, sb, action);
      case 'leaderboard':   return await leaderboardHandler(req, res, sb, action);
      case 'milestones':    return await milestonesHandler(req, res, sb, action);
      case 'sorter-splits': return await sorterSplitsHandler(req, res, sb, action);
      case 'goals':         return await goalsHandler(req, res, sb, action);
      case 'notify':        return await notifyHandler(req, res, sb, action);
      default:              return fail(res, 400, 'Unknown feature: ' + feature);
    }
  } catch (err) {
    console.error('features.js [' + feature + '/' + action + ']:', err);
    return fail(res, 500, err.message);
  }
};

// ═════════════════════════════════════════════════════════════════════════════
// CHAT
// ═════════════════════════════════════════════════════════════════════════════

// Role → which channel slugs are visible (owner intentionally excluded from role-specific chats)
const CHANNEL_VISIBILITY = {
  owner:   ['all_team','announcements'],
  manager: ['all_team','announcements'],
  breaker: ['all_team','breakers_only','announcements'],
  sorter:  ['all_team','sorters_only','announcements'],
};

// Default channels created for every new org
const DEFAULT_CHANNELS = [
  { slug: 'announcements',  name: '📢 Announcements', description: 'Important updates from ownership. Read-only for staff.', can_post_roles: ['owner','manager'], sort_order: 1 },
  { slug: 'all_team',       name: '💬 Team Chat',     description: 'Everyone on the team.',                                  can_post_roles: ['owner','manager','breaker','sorter'], sort_order: 2 },
  { slug: 'breakers_only',  name: '🃏 Breaker Chat',  description: 'Breakers only.',                                         can_post_roles: ['breaker'], sort_order: 3 },
  { slug: 'sorters_only',   name: '📦 Sorter Chat',   description: 'Sorters only.',                                          can_post_roles: ['sorter'], sort_order: 4 },
];

async function chatHandler(req, res, sb, action) {
  const { err, profile } = await authenticate(req, sb);
  if (err) return fail(res, err.status, err.msg);

  // ── GET /api/chat/channels ─────────────────────────────────────────────────
  if (action === 'channels' && req.method === 'GET') {
    const allowedSlugs = CHANNEL_VISIBILITY[profile.role] || ['all_team','announcements'];

    // Check if org has any channels yet
    const { data: existing } = await sb.from('chat_channels')
      .select('id').eq('org_id', profile.org_id).limit(1);

    if (!existing || existing.length === 0) {
      // First time: seed all 4 default channels for this org
      await sb.from('chat_channels').insert(
        DEFAULT_CHANNELS.map(function(c) {
          return { org_id: profile.org_id, slug: c.slug, name: c.name, description: c.description, can_post_roles: c.can_post_roles, is_active: true };
        })
      );
    }

    const { data, error } = await sb.from('chat_channels')
      .select('*')
      .eq('org_id', profile.org_id)
      .eq('is_active', true)
      .in('slug', allowedSlugs)
      .order('created_at', { ascending: true });
    if (error) return fail(res, 500, error.message);
    return res.status(200).json({ channels: data || [] });
  }

  // ── GET/POST /api/chat/channels/:channelId/messages ────────────────────────
  if (action === 'messages') {
    const channelId = req.query.channelId;
    if (!channelId) return fail(res, 400, 'channelId required');

    // Verify channel belongs to this org and user can see it
    const { data: channel } = await sb.from('chat_channels')
      .select('id, slug, can_post_roles, org_id')
      .eq('id', channelId)
      .eq('org_id', profile.org_id)
      .eq('is_active', true)
      .maybeSingle();
    if (!channel) return fail(res, 404, 'Channel not found');

    const allowedSlugs = CHANNEL_VISIBILITY[profile.role] || [];
    if (!allowedSlugs.includes(channel.slug)) return fail(res, 403, 'Access denied to this channel');

    if (req.method === 'GET') {
      const limit  = Math.min(parseInt(req.query.limit || '50', 10), 100);
      const before = req.query.before; // message id cursor

      let query = sb.from('chat_messages')
        .select(`
          id, created_at, channel_id, sender_id, content, is_deleted, deleted_at,
          sender:profiles!sender_id(id, display_name, role)
        `)
        .eq('channel_id', channelId)
        .order('created_at', { ascending: false })
        .limit(limit);

      if (before) {
        // Get created_at of the cursor message for keyset pagination
        const { data: cursorMsg } = await sb.from('chat_messages').select('created_at').eq('id', before).single();
        if (cursorMsg) query = query.lt('created_at', cursorMsg.created_at);
      }

      const { data: messages, error } = await query;
      if (error) return fail(res, 500, error.message);

      // Fetch reactions grouped by message
      const msgIds = (messages || []).map(m => m.id);
      let reactionMap = {};
      if (msgIds.length > 0) {
        const { data: reactions } = await sb.from('chat_reactions')
          .select('message_id, emoji, staff_id')
          .in('message_id', msgIds);
        for (const r of (reactions || [])) {
          if (!reactionMap[r.message_id]) reactionMap[r.message_id] = {};
          if (!reactionMap[r.message_id][r.emoji]) reactionMap[r.message_id][r.emoji] = { count: 0, reacted: false };
          reactionMap[r.message_id][r.emoji].count++;
          if (r.staff_id === profile.id) reactionMap[r.message_id][r.emoji].reacted = true;
        }
      }

      const enriched = (messages || []).map(m => ({
        ...m,
        content: m.is_deleted ? '[deleted]' : m.content,
        reactions: reactionMap[m.id] || {}
      }));

      // Update read status
      await sb.from('chat_read_status')
        .upsert({ channel_id: channelId, staff_id: profile.id, last_read_at: new Date().toISOString() }, { onConflict: 'channel_id,staff_id' });

      return res.status(200).json({ messages: enriched });
    }

    if (req.method === 'POST') {
      const { content } = req.body || {};
      if (!content || typeof content !== 'string' || content.trim().length === 0) return fail(res, 400, 'content required');
      if (content.length > 2000) return fail(res, 400, 'content exceeds 2000 character limit');

      // Announcements: only owner/manager can post
      if (channel.slug === 'announcements' && !['owner','manager'].includes(profile.role)) {
        return fail(res, 403, 'Only owners and managers can post in Announcements');
      }
      // Verify role is in can_post_roles
      if (!channel.can_post_roles.includes(profile.role)) {
        return fail(res, 403, 'Your role cannot post in this channel');
      }

      const { data: msg, error } = await sb.from('chat_messages')
        .insert({ channel_id: channelId, sender_id: profile.id, content: content.trim() })
        .select(`id, created_at, channel_id, sender_id, content, is_deleted,
                 sender:profiles!sender_id(id, display_name, role)`)
        .single();
      if (error) return fail(res, 500, error.message);
      return res.status(201).json({ message: msg });
    }

    return fail(res, 405, 'Method not allowed');
  }

  // ── POST /api/chat/messages/:messageId/reactions ───────────────────────────
  if (action === 'reactions' && req.method === 'POST') {
    const { emoji, message_id: bodyMessageId } = req.body || {};
    const messageId = req.query.messageId || bodyMessageId;
    if (!messageId) return fail(res, 400, 'messageId required');
    const ALLOWED_EMOJI = ['👍','🔥','💰','✅'];
    if (!ALLOWED_EMOJI.includes(emoji)) return fail(res, 400, 'emoji must be one of: 👍 🔥 💰 ✅');

    // Verify message is in this org
    const { data: msg } = await sb.from('chat_messages')
      .select('id, channel:chat_channels!channel_id(org_id)')
      .eq('id', messageId)
      .maybeSingle();
    if (!msg || msg.channel?.org_id !== profile.org_id) return fail(res, 404, 'Message not found');

    // Toggle: remove if exists, add if not
    const { data: existing } = await sb.from('chat_reactions')
      .select('id')
      .eq('message_id', messageId)
      .eq('staff_id', profile.id)
      .eq('emoji', emoji)
      .maybeSingle();

    if (existing) {
      await sb.from('chat_reactions').delete().eq('id', existing.id);
    } else {
      await sb.from('chat_reactions').insert({ message_id: messageId, staff_id: profile.id, emoji });
    }

    // Return updated reaction counts for this message
    const { data: reactions } = await sb.from('chat_reactions')
      .select('emoji, staff_id')
      .eq('message_id', messageId);
    const counts = {};
    for (const r of (reactions || [])) {
      if (!counts[r.emoji]) counts[r.emoji] = { count: 0, reacted: false };
      counts[r.emoji].count++;
      if (r.staff_id === profile.id) counts[r.emoji].reacted = true;
    }
    return res.status(200).json({ reactions: counts, added: !existing });
  }

  // ── GET /api/chat/unread-counts ────────────────────────────────────────────
  if (action === 'unread' && req.method === 'GET') {
    const allowedSlugs = CHANNEL_VISIBILITY[profile.role] || [];

    const { data: channels } = await sb.from('chat_channels')
      .select('id, slug')
      .eq('org_id', profile.org_id)
      .eq('is_active', true)
      .in('slug', allowedSlugs);

    const { data: readStatuses } = await sb.from('chat_read_status')
      .select('channel_id, last_read_at')
      .eq('staff_id', profile.id);

    const readMap = {};
    for (const rs of (readStatuses || [])) readMap[rs.channel_id] = rs.last_read_at;

    const counts = {};
    for (const ch of (channels || [])) {
      const lastRead = readMap[ch.id] || null;
      let query = sb.from('chat_messages').select('id', { count: 'exact', head: true })
        .eq('channel_id', ch.id).eq('is_deleted', false);
      if (lastRead) query = query.gt('created_at', lastRead);
      const { count } = await query;
      counts[ch.id] = count || 0;
    }
    return res.status(200).json({ unread: counts });
  }

  return fail(res, 400, 'Unknown chat action: ' + action);
}

// ═════════════════════════════════════════════════════════════════════════════
// LEADERBOARD
// ═════════════════════════════════════════════════════════════════════════════

async function leaderboardHandler(req, res, sb, action) {
  const { err, profile } = await authenticate(req, sb);
  if (err) return fail(res, err.status, err.msg);

  // ── GET /api/leaderboard ───────────────────────────────────────────────────
  if (action === 'get' && req.method === 'GET') {
    const { data: settings } = await sb.from('leaderboard_settings')
      .select('*').eq('org_id', profile.org_id).maybeSingle();

    if (profile.role === 'breaker' && settings && !settings.visible_to_breakers)
      return fail(res, 403, 'Leaderboard not visible to breakers');
    if (profile.role === 'sorter' && (!settings || !settings.visible_to_sorters))
      return fail(res, 403, 'Leaderboard not visible to sorters');

    const now = new Date();
    // Accept both year/month (frontend) and period_year/period_month (legacy)
    const year  = parseInt(req.query.year  || req.query.period_year  || now.getFullYear(), 10);
    const month = parseInt(req.query.month || req.query.period_month || (now.getMonth() + 1), 10);
    const category = req.query.category || 'breaks_completed';

    const VALID_CATS = ['breaks_completed', 'revenue_generated'];
    const rawCats = settings?.visible_categories || VALID_CATS;
    const visibleCategories = rawCats.filter(function(c) { return VALID_CATS.includes(c); });
    if (!visibleCategories.length) visibleCategories.push(...VALID_CATS);
    if (!visibleCategories.includes(category)) return fail(res, 400, 'Category not available');

    let { data: rows, error } = await sb.from('leaderboard_snapshots')
      .select('staff_id, value, rank, staff:profiles!staff_id(id, display_name, role)')
      .eq('org_id', profile.org_id)
      .eq('period_year', year)
      .eq('period_month', month)
      .eq('category', category)
      .order('value', { ascending: false })
      .limit(20);

    if (error) return fail(res, 500, error.message);

    // ── Live fallback: if no snapshots, compute from breaks table ─────────────
    if (!rows || rows.length === 0) {
      const monthStart = new Date(year, month - 1, 1).toISOString();
      const monthEnd   = new Date(year, month,     0, 23, 59, 59).toISOString();

      const { data: breakers } = await sb.from('profiles')
        .select('id, display_name, role')
        .eq('org_id', profile.org_id)
        .in('role', ['breaker', 'breaker/manager']);

      const computed = [];
      for (const breaker of (breakers || [])) {
        let value = 0;
        if (category === 'breaks_completed') {
          const { count } = await sb.from('breaks').select('id', { count: 'exact', head: true })
            .eq('breaker_id', breaker.id).eq('org_id', profile.org_id)
            .gte('created_at', monthStart).lte('created_at', monthEnd);
          value = count || 0;
        } else if (category === 'revenue_generated') {
          const { data: revData } = await sb.from('breaks').select('revenue')
            .eq('breaker_id', breaker.id).eq('org_id', profile.org_id)
            .gte('created_at', monthStart).lte('created_at', monthEnd);
          value = (revData || []).reduce((s, b) => s + (parseFloat(b.revenue) || 0), 0);
        } else if (category === 'commission_earned') {
          const { data: commData } = await sb.from('breaks').select('commission_amount')
            .eq('breaker_id', breaker.id).eq('org_id', profile.org_id)
            .gte('created_at', monthStart).lte('created_at', monthEnd);
          value = (commData || []).reduce((s, b) => s + (parseFloat(b.commission_amount) || 0), 0);
        } else if (category === 'consistency_score') {
          const { data: daysData } = await sb.from('breaks').select('created_at')
            .eq('breaker_id', breaker.id).eq('org_id', profile.org_id)
            .gte('created_at', monthStart).lte('created_at', monthEnd);
          const uniqueDays = new Set((daysData || []).map(b => b.created_at.slice(0, 10)));
          const daysInMonth = new Date(year, month, 0).getDate();
          value = Math.round((uniqueDays.size / daysInMonth) * 100 * 10) / 10;
        } else if (category === 'longest_streak') {
          const { data: allBreakDays } = await sb.from('breaks').select('created_at')
            .eq('breaker_id', breaker.id).eq('org_id', profile.org_id)
            .order('created_at', { ascending: true });
          const allDays = [...new Set((allBreakDays || []).map(b => b.created_at.slice(0, 10)))].sort();
          let longest = 0, current = 0, prev = null;
          for (const day of allDays) {
            if (prev && (new Date(day) - new Date(prev)) / 86400000 === 1) current++;
            else current = 1;
            longest = Math.max(longest, current);
            prev = day;
          }
          value = longest;
        }
        if (value > 0) computed.push({ staff_id: breaker.id, display_name: breaker.display_name, role: breaker.role, value });
      }

      computed.sort((a, b) => b.value - a.value);
      const entries = computed.slice(0, 20).map((e, i) => ({ ...e, rank: i + 1 }));
      const myEntry = entries.find(e => e.staff_id === profile.id);
      return res.status(200).json({
        entries,
        visible_categories: visibleCategories,
        period: { year, month },
        category,
        my_rank: myEntry || null
      });
    }

    // Flatten staff join and assign rank
    const entries = (rows || []).map((r, i) => ({
      staff_id: r.staff_id,
      display_name: r.staff?.display_name || '?',
      role: r.staff?.role || '',
      value: r.value,
      rank: r.rank || (i + 1)
    }));

    const myEntry = entries.find(e => e.staff_id === profile.id);
    return res.status(200).json({
      entries,
      visible_categories: visibleCategories,
      period: { year, month },
      category,
      my_rank: myEntry || null
    });
  }

  // ── GET/PATCH /api/leaderboard/settings ───────────────────────────────────
  if (action === 'settings') {
    if (!['owner'].includes(profile.role)) return fail(res, 403, 'Owner only');

    if (req.method === 'GET') {
      const { data, error } = await sb.from('leaderboard_settings')
        .select('*').eq('org_id', profile.org_id).maybeSingle();
      if (error) return fail(res, 500, error.message);
      return res.status(200).json({ settings: data });
    }

    if (req.method === 'PATCH') {
      const { visible_to_breakers, visible_to_sorters, visible_categories } = req.body || {};
      const updates = { updated_at: new Date().toISOString() };
      if (typeof visible_to_breakers === 'boolean') updates.visible_to_breakers = visible_to_breakers;
      if (typeof visible_to_sorters  === 'boolean') updates.visible_to_sorters  = visible_to_sorters;
      if (Array.isArray(visible_categories)) updates.visible_categories = visible_categories;

      const { data, error } = await sb.from('leaderboard_settings')
        .update(updates).eq('org_id', profile.org_id).select('*').single();
      if (error) return fail(res, 500, error.message);
      return res.status(200).json({ settings: data });
    }

    return fail(res, 405, 'Method not allowed');
  }

  return fail(res, 400, 'Unknown leaderboard action: ' + action);
}

// ═════════════════════════════════════════════════════════════════════════════
// MILESTONES
// ═════════════════════════════════════════════════════════════════════════════

async function milestonesHandler(req, res, sb, action) {
  const { err, profile } = await authenticate(req, sb);
  if (err) return fail(res, err.status, err.msg);

  // ── GET/POST /api/milestones ───────────────────────────────────────────────
  if (action === 'milestones') {
    if (req.method === 'GET') {
      // All system milestones + this org's custom milestones
      const { data: defs, error } = await sb.from('milestone_definitions')
        .select('*')
        .or(`org_id.is.null,org_id.eq.${profile.org_id}`)
        .eq('is_active', true)
        .order('display_order', { ascending: true });
      if (error) return fail(res, 500, error.message);

      // Which ones has the requesting user earned?
      const { data: earned } = await sb.from('staff_milestones')
        .select('milestone_id, awarded_at')
        .eq('staff_id', profile.id);

      const earnedSet = new Set((earned || []).map(e => e.milestone_id));
      const earnedMap = {};
      for (const e of (earned || [])) earnedMap[e.milestone_id] = e.awarded_at;

      // Auto-check automatic milestones against existing performance data
      const automaticUnawarded = (defs || []).filter(function(d) {
        return d.trigger_type === 'automatic' && !earnedSet.has(d.id) && d.trigger_metric && d.trigger_value != null;
      });

      if (automaticUnawarded.length > 0) {
        const neededMetrics = new Set(automaticUnawarded.map(function(d) { return d.trigger_metric; }));
        const metricValues = {};

        if (neededMetrics.has('breaks_completed')) {
          const { count } = await sb.from('breaks')
            .select('id', { count: 'exact', head: true })
            .eq('breaker_id', profile.id)
            .eq('org_id', profile.org_id);
          metricValues.breaks_completed = count || 0;
        }
        if (neededMetrics.has('revenue_generated')) {
          const { data: revRows } = await sb.from('breaks')
            .select('revenue')
            .eq('breaker_id', profile.id)
            .eq('org_id', profile.org_id);
          metricValues.revenue_generated = (revRows || []).reduce(function(s, b) { return s + (parseFloat(b.revenue) || 0); }, 0);
        }

        const toAward = automaticUnawarded.filter(function(d) {
          return metricValues[d.trigger_metric] !== undefined && metricValues[d.trigger_metric] >= d.trigger_value;
        });

        if (toAward.length > 0) {
          const now = new Date().toISOString();
          const { data: newAwards } = await sb.from('staff_milestones')
            .upsert(
              toAward.map(function(d) {
                return { staff_id: profile.id, milestone_id: d.id, org_id: profile.org_id, awarded_at: now };
              }),
              { onConflict: 'staff_id,milestone_id', ignoreDuplicates: true }
            )
            .select('milestone_id, awarded_at');
          for (const a of (newAwards || [])) {
            earnedSet.add(a.milestone_id);
            earnedMap[a.milestone_id] = a.awarded_at;
          }
        }
      }

      return res.status(200).json({
        milestones: (defs || []).map(d => ({
          ...d,
          earned: earnedSet.has(d.id),
          earned_at: earnedMap[d.id] || null
        }))
      });
    }

    if (req.method === 'POST') {
      if (profile.role !== 'owner') return fail(res, 403, 'Owner only');
      const { name, description, badge_icon, badge_color, trigger_type, trigger_metric, trigger_value, display_order } = req.body || {};
      if (!name || !description || !badge_icon || !badge_color || !trigger_type) {
        return fail(res, 400, 'name, description, badge_icon, badge_color, trigger_type required');
      }
      if (!['manual','automatic'].includes(trigger_type)) return fail(res, 400, 'trigger_type must be manual or automatic');
      if (trigger_type === 'automatic' && !trigger_metric) return fail(res, 400, 'trigger_metric required for automatic milestones');

      const { data, error } = await sb.from('milestone_definitions')
        .insert({
          org_id: profile.org_id, name, description, badge_icon, badge_color,
          trigger_type, trigger_metric: trigger_metric || null,
          trigger_value: trigger_value != null ? trigger_value : null,
          display_order: display_order || 0
        })
        .select('*').single();
      if (error) return fail(res, 500, error.message);
      return res.status(201).json({ milestone: data });
    }

    return fail(res, 405, 'Method not allowed');
  }

  // ── GET /api/milestones/staff/:staffId ────────────────────────────────────
  if (action === 'staff' && req.method === 'GET') {
    const staffId = req.query.staffId;
    if (!staffId) return fail(res, 400, 'staffId required');

    // Accessible by owner, manager, or the staff member themselves
    if (!['owner','manager'].includes(profile.role) && profile.id !== staffId) {
      return fail(res, 403, 'Access denied');
    }
    // Verify target staff is in same org
    const { data: targetProfile } = await sb.from('profiles')
      .select('id, display_name, role').eq('id', staffId).eq('org_id', profile.org_id).maybeSingle();
    if (!targetProfile) return fail(res, 404, 'Staff member not found in your organization');

    const { data, error } = await sb.from('staff_milestones')
      .select(`id, awarded_at, awarded_by,
               milestone:milestone_definitions!milestone_id(id, name, description, badge_icon, badge_color, trigger_type)`)
      .eq('staff_id', staffId)
      .eq('org_id', profile.org_id)
      .order('awarded_at', { ascending: false });
    if (error) return fail(res, 500, error.message);
    return res.status(200).json({ staff: targetProfile, milestones: data || [] });
  }

  // ── POST /api/milestones/award ─────────────────────────────────────────────
  if (action === 'award' && req.method === 'POST') {
    if (profile.role !== 'owner') return fail(res, 403, 'Owner only');
    const { milestone_id, staff_id } = req.body || {};
    if (!milestone_id || !staff_id) return fail(res, 400, 'milestone_id and staff_id required');

    // Verify staff is in same org
    const { data: targetProfile } = await sb.from('profiles')
      .select('id').eq('id', staff_id).eq('org_id', profile.org_id).maybeSingle();
    if (!targetProfile) return fail(res, 404, 'Staff member not found in your organization');

    // Check if already earned
    const { data: existing } = await sb.from('staff_milestones')
      .select('id').eq('staff_id', staff_id).eq('milestone_id', milestone_id).maybeSingle();
    if (existing) return res.status(409).json({ error: 'Milestone already awarded to this staff member' });

    const { data, error } = await sb.from('staff_milestones')
      .insert({ staff_id, milestone_id, awarded_by: profile.id, org_id: profile.org_id })
      .select('*').single();
    if (error) return fail(res, 500, error.message);

    // Fetch milestone details for notification
    const { data: milestoneDef } = await sb.from('milestone_definitions')
      .select('name, badge_icon').eq('id', milestone_id).maybeSingle();

    // In-app notification to the recipient
    await sb.from('notifications').insert({
      organization_id: profile.org_id,
      user_id: staff_id,
      type: 'milestone_awarded',
      title: milestoneDef?.badge_icon + ' Milestone Unlocked: ' + (milestoneDef?.name || 'Achievement'),
      body: 'Your owner awarded you a milestone. Check your profile to see your badge.',
      action_url: APP_URL + '/break'
    }).catch(() => {});

    return res.status(201).json({ awarded: data });
  }

  return fail(res, 400, 'Unknown milestones action: ' + action);
}

// ═════════════════════════════════════════════════════════════════════════════
// SORTER SPLITS
// ═════════════════════════════════════════════════════════════════════════════

async function sorterSplitsHandler(req, res, sb, action) {
  const { err, profile } = await authenticate(req, sb);
  if (err) return fail(res, err.status, err.msg);

  // ── GET /api/sorter-splits/pending ─────────────────────────────────────────
  if (action === 'pending' && req.method === 'GET') {
    const { data, error } = await sb.from('sorter_splits')
      .select(`
        id, created_at, stream_id, split_type,
        initiating_sorter_percentage, receiving_sorter_percentage,
        status, expires_at, initiating_sorter_id,
        initiating_sorter:profiles!initiating_sorter_id(id, display_name),
        stream:streams!stream_id(id, stream_key)
      `)
      .eq('receiving_sorter_id', profile.id)
      .eq('status', 'pending')
      .gt('expires_at', new Date().toISOString())
      .order('created_at', { ascending: false });
    if (error) return fail(res, 500, error.message);
    return res.status(200).json({ pending_splits: data || [] });
  }

  // ── POST /api/sorter-splits ────────────────────────────────────────────────
  if (action === 'splits' && req.method === 'POST') {
    if (profile.role !== 'sorter') return fail(res, 403, 'Sorter role only');
    const { stream_id, receiving_sorter_id, split_type, initiating_sorter_percentage, receiving_sorter_percentage } = req.body || {};
    if (!stream_id || !receiving_sorter_id || !split_type) {
      return fail(res, 400, 'stream_id, receiving_sorter_id, split_type required');
    }
    if (!['equal','custom'].includes(split_type)) return fail(res, 400, 'split_type must be equal or custom');

    const initPct = parseFloat(initiating_sorter_percentage);
    const recvPct = parseFloat(receiving_sorter_percentage);
    if (isNaN(initPct) || isNaN(recvPct)) return fail(res, 400, 'percentages required');
    if (Math.abs(initPct + recvPct - 100) > 0.001) return fail(res, 400, 'Percentages must sum to 100');

    // Verify stream exists in this org
    const { data: stream } = await sb.from('streams')
      .select('id, org_id').eq('id', stream_id).eq('org_id', profile.org_id).maybeSingle();
    if (!stream) return fail(res, 404, 'Stream not found');

    // No existing active split for this stream
    const { data: existingSplit } = await sb.from('sorter_splits')
      .select('id, status').eq('stream_id', stream_id).maybeSingle();
    if (existingSplit && ['pending','confirmed'].includes(existingSplit.status)) {
      return fail(res, 409, 'An active split already exists for this stream');
    }

    // Verify receiving sorter is in same org and is a sorter
    const { data: receivingSorter } = await sb.from('profiles')
      .select('id, role').eq('id', receiving_sorter_id).eq('org_id', profile.org_id).maybeSingle();
    if (!receivingSorter) return fail(res, 404, 'Receiving sorter not found in your organization');
    if (receivingSorter.role !== 'sorter') return fail(res, 400, 'Receiving user must have sorter role');
    if (receiving_sorter_id === profile.id) return fail(res, 400, 'Cannot create split with yourself');

    const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
    const { data, error } = await sb.from('sorter_splits')
      .insert({
        stream_id, initiating_sorter_id: profile.id, receiving_sorter_id,
        split_type, initiating_sorter_percentage: initPct, receiving_sorter_percentage: recvPct,
        expires_at: expiresAt
      })
      .select('*').single();
    if (error) return fail(res, 500, error.message);

    // Notify receiving sorter
    await sb.from('notifications').insert({
      organization_id: profile.org_id, user_id: receiving_sorter_id,
      type: 'split_request',
      title: 'New split request from ' + (profile.display_name || 'a sorter'),
      body: profile.display_name + ' wants to split sorter earnings ' + initPct + '/' + recvPct + '. You have 24 hours to respond.',
      action_url: APP_URL + '/sorter'
    }).catch(() => {});

    return res.status(201).json({ split: data });
  }

  // ── PATCH /api/sorter-splits/:id/confirm ──────────────────────────────────
  if (action === 'confirm' && req.method === 'PATCH') {
    const id = req.query.id;
    if (!id) return fail(res, 400, 'id required');

    const { data: split } = await sb.from('sorter_splits')
      .select('*').eq('id', id).maybeSingle();
    if (!split) return fail(res, 404, 'Split not found');
    if (split.receiving_sorter_id !== profile.id) return fail(res, 403, 'Only the receiving sorter can confirm');
    if (split.status !== 'pending') return fail(res, 409, 'Split is no longer pending');
    if (new Date(split.expires_at) < new Date()) return fail(res, 409, 'Split request has expired');

    const { data, error } = await sb.from('sorter_splits')
      .update({ status: 'confirmed', confirmed_at: new Date().toISOString(), updated_at: new Date().toISOString() })
      .eq('id', id).select('*').single();
    if (error) return fail(res, 500, error.message);

    // Notify initiating sorter
    await sb.from('notifications').insert({
      organization_id: (await sb.from('streams').select('org_id').eq('id', split.stream_id).single()).data?.org_id,
      user_id: split.initiating_sorter_id,
      type: 'split_confirmed',
      title: 'Split request confirmed',
      body: (profile.display_name || 'Your sorter partner') + ' accepted the split agreement.',
      action_url: APP_URL + '/sorter'
    }).catch(() => {});

    return res.status(200).json({ split: data });
  }

  // ── PATCH /api/sorter-splits/:id/decline ──────────────────────────────────
  if (action === 'decline' && req.method === 'PATCH') {
    const id = req.query.id;
    if (!id) return fail(res, 400, 'id required');

    const { data: split } = await sb.from('sorter_splits')
      .select('*').eq('id', id).maybeSingle();
    if (!split) return fail(res, 404, 'Split not found');
    if (split.receiving_sorter_id !== profile.id) return fail(res, 403, 'Only the receiving sorter can decline');
    if (split.status !== 'pending') return fail(res, 409, 'Split is no longer pending');

    const { data, error } = await sb.from('sorter_splits')
      .update({ status: 'declined', updated_at: new Date().toISOString() })
      .eq('id', id).select('*').single();
    if (error) return fail(res, 500, error.message);

    // Notify initiating sorter
    const { data: streamData } = await sb.from('streams').select('org_id').eq('id', split.stream_id).single();
    await sb.from('notifications').insert({
      organization_id: streamData?.org_id,
      user_id: split.initiating_sorter_id,
      type: 'split_declined',
      title: 'Split request declined',
      body: (profile.display_name || 'Your sorter partner') + ' declined the split. Full earnings will go to you.',
      action_url: APP_URL + '/sorter'
    }).catch(() => {});

    return res.status(200).json({ split: data });
  }

  return fail(res, 400, 'Unknown sorter-splits action: ' + action);
}

// ═════════════════════════════════════════════════════════════════════════════
// MONTHLY GOALS
// ═════════════════════════════════════════════════════════════════════════════

async function goalsHandler(req, res, sb, action) {
  const { err, profile } = await authenticate(req, sb);
  if (err) return fail(res, err.status, err.msg);

  // ── GET/POST /api/goals ────────────────────────────────────────────────────
  if (action === 'goals') {
    if (req.method === 'GET') {
      const now = new Date();
      const year  = parseInt(req.query.year  || now.getFullYear(), 10);
      const month = parseInt(req.query.month || (now.getMonth() + 1), 10);

      let query = sb.from('monthly_goals')
        .select('*')
        .eq('org_id', profile.org_id)
        .eq('goal_year', year)
        .eq('goal_month', month);

      // Non-owners/managers only see: visible goals OR their own individual goals
      if (!['owner','manager'].includes(profile.role)) {
        query = query.or(`is_visible_to_all.eq.true,staff_id.eq.${profile.id}`);
      }

      const { data, error } = await query.order('created_at', { ascending: true });
      if (error) return fail(res, 500, error.message);
      return res.status(200).json({ goals: data || [] });
    }

    if (req.method === 'POST') {
      if (profile.role !== 'owner') return fail(res, 403, 'Owner only');
      const { goal_type, target_value, staff_id, goal_year, goal_month, is_visible_to_all } = req.body || {};
      if (!goal_type || target_value == null) return fail(res, 400, 'goal_type and target_value required');

      const now = new Date();
      const year  = goal_year  || now.getFullYear();
      const month = goal_month || (now.getMonth() + 1);

      // Upsert via delete + insert to handle the nullable unique constraint cleanly
      const matchQuery = sb.from('monthly_goals')
        .select('id').eq('org_id', profile.org_id)
        .eq('goal_year', year).eq('goal_month', month).eq('goal_type', goal_type);
      const matched = staff_id
        ? await matchQuery.eq('staff_id', staff_id).maybeSingle()
        : await matchQuery.is('staff_id', null).maybeSingle();

      const payload = {
        org_id: profile.org_id, goal_type, target_value: parseFloat(target_value),
        staff_id: staff_id || null, goal_year: year, goal_month: month,
        is_visible_to_all: is_visible_to_all !== false,
        created_by: profile.id, updated_at: new Date().toISOString()
      };

      let data, error;
      if (matched.data?.id) {
        ({ data, error } = await sb.from('monthly_goals')
          .update({ target_value: payload.target_value, is_visible_to_all: payload.is_visible_to_all, updated_at: payload.updated_at })
          .eq('id', matched.data.id).select('*').single());
      } else {
        ({ data, error } = await sb.from('monthly_goals').insert(payload).select('*').single());
      }

      if (error) return fail(res, 500, error.message);
      return res.status(201).json({ goal: data });
    }

    return fail(res, 405, 'Method not allowed');
  }

  // ── DELETE /api/goals/:id ──────────────────────────────────────────────────
  if (action === 'manage') {
    if (profile.role !== 'owner') return fail(res, 403, 'Owner only');
    if (req.method !== 'DELETE') return fail(res, 405, 'Method not allowed');
    const id = req.query.id;
    if (!id) return fail(res, 400, 'id required');

    const { data: goal } = await sb.from('monthly_goals')
      .select('id').eq('id', id).eq('org_id', profile.org_id).maybeSingle();
    if (!goal) return fail(res, 404, 'Goal not found');

    const { error } = await sb.from('monthly_goals').delete().eq('id', id);
    if (error) return fail(res, 500, error.message);
    return res.status(200).json({ ok: true });
  }

  return fail(res, 400, 'Unknown goals action: ' + action);
}

// ═════════════════════════════════════════════════════════════════════════════
// NOTIFY (absorbed from notify-stream-closed.js + notify-inventory-low.js)
// These routes are called server-side without auth headers — uses org_id in body
// ═════════════════════════════════════════════════════════════════════════════

async function notifyHandler(req, res, sb, action) {
  if (req.method !== 'POST') return fail(res, 405, 'Method not allowed');

  // ── POST /api/notify-stream-closed ────────────────────────────────────────
  if (action === 'stream-closed') {
    const { stream_id, stream_key, break_count, org_id } = req.body || {};
    if (!org_id || !stream_key) return fail(res, 400, 'org_id and stream_key required');

    const { data: sorters } = await sb.from('profiles')
      .select('id, display_name').eq('org_id', org_id).eq('role', 'sorter');

    if (!sorters || sorters.length === 0) return res.status(200).json({ sent: 0, reason: 'no sorters' });

    const sortUrl  = APP_URL + '/sorter';
    const breaks   = parseInt(break_count, 10) || 0;
    const breakWord = breaks === 1 ? 'break needs' : 'breaks need';
    const title    = 'New stream ready to sort';
    const body     = `${stream_key} just closed. ${breaks} ${breakWord} sorting. Oldest stream is always first in your queue.`;
    let sent = 0;

    for (const sorter of sorters) {
      const { data: prefs } = await sb.from('notification_preferences')
        .select('*').eq('user_id', sorter.id).maybeSingle();
      const inApp  = prefs ? prefs.in_app_notifications_enabled : true;
      const email  = prefs ? prefs.email_notifications_enabled  : true;
      const closed = prefs ? prefs.notify_stream_closed         : true;
      if (!closed) continue;

      if (inApp) {
        await sb.from('notifications').insert({ organization_id: org_id, user_id: sorter.id, type: 'stream_closed', title, body, action_url: sortUrl });
      }
      if (email) {
        const { data: authUser } = await sb.auth.admin.getUserById(sorter.id);
        const toEmail = authUser?.user?.email;
        if (toEmail) {
          const firstName = (sorter.display_name || '').split(' ')[0] || 'there';
          try {
            await sendEmail({ to: toEmail, subject: `New stream ready to sort — ${stream_key}`, html: buildStreamClosedHtml(firstName, stream_key, breaks, sortUrl), text: buildStreamClosedText(firstName, stream_key, breaks, sortUrl) });
          } catch (e) { console.error('Email error (stream closed):', e.message); }
        }
      }
      sent++;
    }

    // After notifying, run the three automated DB processes
    if (stream_id) {
      await updateGoalProgress(sb, org_id).catch(e => console.error('updateGoalProgress error:', e.message));
      const newlEarned = await updateLeaderboardOnStreamClose(sb, stream_id, org_id).catch(e => { console.error('updateLeaderboard error:', e.message); return []; });
      if (newlEarned && newlEarned.length > 0) {
        await checkMilestoneTriggers(sb, newlEarned, org_id).catch(e => console.error('checkMilestones error:', e.message));
      }
    }

    return res.status(200).json({ sent });
  }

  // ── POST /api/notify-inventory-low ────────────────────────────────────────
  if (action === 'inventory-low') {
    const { org_id, products } = req.body || {};
    if (!org_id || !Array.isArray(products) || products.length === 0) {
      return fail(res, 400, 'org_id and products[] required');
    }
    const LOW_THRESHOLD = 3;
    const lowProducts = products.filter(p => p.current_stock <= LOW_THRESHOLD);
    if (lowProducts.length === 0) return res.status(200).json({ sent: 0 });

    const { data: recipients } = await sb.from('profiles')
      .select('id, display_name, role').eq('org_id', org_id).in('role', ['owner','manager']);
    if (!recipients || recipients.length === 0) return res.status(200).json({ sent: 0, reason: 'no recipients' });

    const inventoryUrl = APP_URL + '/dashboard#inventory';
    let totalSent = 0;

    for (const product of lowProducts) {
      const { data: existing } = await sb.from('notifications').select('id')
        .eq('organization_id', org_id).eq('type', 'inventory_low').eq('is_read', false)
        .ilike('body', `%${product.name}%`).limit(1).maybeSingle();
      if (existing) continue;

      const title = 'Inventory running low';
      const body  = `${product.name} is down to ${product.current_stock} ${product.current_stock === 1 ? 'box' : 'boxes'}. You may want to restock before your next stream.`;

      for (const recipient of recipients) {
        const { data: prefs } = await sb.from('notification_preferences').select('*').eq('user_id', recipient.id).maybeSingle();
        const inApp = prefs ? prefs.in_app_notifications_enabled : true;
        const email = prefs ? prefs.email_notifications_enabled  : true;
        const inv   = prefs ? prefs.notify_inventory_low         : true;
        if (!inv) continue;
        if (inApp) await sb.from('notifications').insert({ organization_id: org_id, user_id: recipient.id, type: 'inventory_low', title, body, action_url: inventoryUrl });
        if (email) {
          const { data: authUser } = await sb.auth.admin.getUserById(recipient.id);
          const toEmail = authUser?.user?.email;
          if (toEmail) {
            const firstName = (recipient.display_name || '').split(' ')[0] || 'there';
            try {
              await sendEmail({ to: toEmail, subject: `Low inventory: ${product.name}`, html: buildInventoryLowHtml(firstName, product.name, product.current_stock, inventoryUrl), text: buildInventoryLowText(firstName, product.name, product.current_stock, inventoryUrl) });
            } catch (e) { console.error('Email error (inventory low):', e.message); }
          }
        }
        totalSent++;
      }
    }
    return res.status(200).json({ sent: totalSent });
  }

  return fail(res, 400, 'Unknown notify action: ' + action);
}

// ═════════════════════════════════════════════════════════════════════════════
// AUTOMATED DB PROCESSES (Task 8)
// Called explicitly from route handlers — no triggers, logic stays visible
// ═════════════════════════════════════════════════════════════════════════════

// Called after stream closes — updates leaderboard_snapshots for all involved breakers
// Returns array of staff_ids that had updates (for milestone check)
async function updateLeaderboardOnStreamClose(sb, streamId, orgId) {
  const now   = new Date();
  const year  = now.getFullYear();
  const month = now.getMonth() + 1;

  // Get all breaks for this stream
  const { data: streamBreaks } = await sb.from('breaks')
    .select('breaker_id, revenue').eq('stream_id', streamId);
  if (!streamBreaks || streamBreaks.length === 0) return [];

  const staffIds = [...new Set(streamBreaks.map(b => b.breaker_id).filter(Boolean))];
  if (staffIds.length === 0) return [];

  const monthStart = new Date(year, month - 1, 1).toISOString();
  const monthEnd   = new Date(year, month, 0, 23, 59, 59).toISOString();

  for (const staffId of staffIds) {
    // breaks_completed: count of breaks this month for this staff
    const { count: breaksCompleted } = await sb.from('breaks')
      .select('id', { count: 'exact', head: true })
      .eq('breaker_id', staffId).eq('org_id', orgId)
      .gte('created_at', monthStart).lte('created_at', monthEnd);

    // revenue_generated: sum of revenue this month
    const { data: revData } = await sb.from('breaks')
      .select('revenue').eq('breaker_id', staffId).eq('org_id', orgId)
      .gte('created_at', monthStart).lte('created_at', monthEnd);
    const revenueGenerated = (revData || []).reduce((s, b) => s + (parseFloat(b.revenue) || 0), 0);

    // Upsert 2 categories
    const categories = [
      { category: 'breaks_completed',  value: breaksCompleted  || 0 },
      { category: 'revenue_generated', value: revenueGenerated },
    ];

    for (const cat of categories) {
      await sb.from('leaderboard_snapshots').upsert({
        org_id: orgId, staff_id: staffId, period_year: year, period_month: month,
        category: cat.category, value: cat.value
      }, { onConflict: 'org_id,staff_id,period_year,period_month,category' });
    }

    // Recalculate ranks for this period/category
    for (const cat of categories) {
      const { data: ranked } = await sb.from('leaderboard_snapshots')
        .select('id, value').eq('org_id', orgId).eq('period_year', year)
        .eq('period_month', month).eq('category', cat.category)
        .order('value', { ascending: false });
      for (let i = 0; i < (ranked || []).length; i++) {
        await sb.from('leaderboard_snapshots').update({ rank: i + 1 }).eq('id', ranked[i].id);
      }
    }
  }

  return staffIds;
}

// Called after leaderboard update — checks automatic milestone thresholds for each staff member
// Returns array of newly-awarded milestone ids
async function checkMilestoneTriggers(sb, staffIds, orgId) {
  const newlyAwarded = [];

  // Get all automatic milestone definitions for this org + system milestones
  const { data: milestones } = await sb.from('milestone_definitions')
    .select('*')
    .or(`org_id.is.null,org_id.eq.${orgId}`)
    .eq('trigger_type', 'automatic')
    .eq('is_active', true);
  if (!milestones || milestones.length === 0) return newlyAwarded;

  for (const staffId of staffIds) {
    // Get all-time stats for this staff member in this org
    const { data: allBreaks } = await sb.from('breaks')
      .select('revenue, commission_amount, created_at')
      .eq('breaker_id', staffId).eq('org_id', orgId);
    const breaks       = (allBreaks || []).length;
    const revenue      = (allBreaks || []).reduce((s, b) => s + (parseFloat(b.revenue) || 0), 0);
    const commission   = (allBreaks || []).reduce((s, b) => s + (parseFloat(b.commission_amount) || 0), 0);

    // Streak (all-time longest)
    const allDays = [...new Set((allBreaks || []).map(b => b.created_at.slice(0, 10)))].sort();
    let streak = 0, cur = 0, prev = null;
    for (const day of allDays) {
      cur = prev && (new Date(day) - new Date(prev)) / 86400000 === 1 ? cur + 1 : 1;
      streak = Math.max(streak, cur);
      prev = day;
    }

    const statsMap = {
      breaks_completed:  breaks,
      revenue_generated: revenue,
      commission_earned: commission,
      streak_days:       streak,
    };

    // Already earned milestones for this staff member
    const { data: earned } = await sb.from('staff_milestones')
      .select('milestone_id').eq('staff_id', staffId);
    const earnedSet = new Set((earned || []).map(e => e.milestone_id));

    for (const m of milestones) {
      if (earnedSet.has(m.id)) continue;
      if (!m.trigger_metric || m.trigger_value == null) continue;
      const stat = statsMap[m.trigger_metric];
      if (stat == null) continue;
      if (stat >= parseFloat(m.trigger_value)) {
        // Award it
        const { error: awardErr } = await sb.from('staff_milestones').insert({
          staff_id: staffId, milestone_id: m.id, org_id: orgId, awarded_by: null
        });
        if (!awardErr) {
          newlyAwarded.push({ staff_id: staffId, milestone_id: m.id, name: m.name, badge_icon: m.badge_icon });
          // In-app notification
          await sb.from('notifications').insert({
            organization_id: orgId, user_id: staffId,
            type: 'milestone_awarded',
            title: m.badge_icon + ' Milestone Unlocked: ' + m.name,
            body: 'You just unlocked a new milestone. Check your profile to see your badge.',
            action_url: APP_URL + '/break'
          }).catch(() => {});
        }
      }
    }
  }

  return newlyAwarded;
}

// Called after stream closes — updates current_value on all active monthly goals for this org
async function updateGoalProgress(sb, orgId) {
  const now = new Date();
  const year  = now.getFullYear();
  const month = now.getMonth() + 1;
  const monthStart = new Date(year, month - 1, 1).toISOString();
  const monthEnd   = new Date(year, month, 0, 23, 59, 59).toISOString();

  const { data: goals } = await sb.from('monthly_goals')
    .select('*').eq('org_id', orgId).eq('goal_year', year).eq('goal_month', month);
  if (!goals || goals.length === 0) return;

  for (const goal of goals) {
    let currentValue = 0;

    if (goal.goal_type === 'organization_revenue') {
      const { data: streams } = await sb.from('streams')
        .select('final_sales').eq('org_id', orgId).eq('status', 'closed')
        .gte('closed_at', monthStart).lte('closed_at', monthEnd);
      currentValue = (streams || []).reduce((s, st) => s + (parseFloat(st.final_sales) || 0), 0);
    }

    if (goal.goal_type === 'individual_breaks' && goal.staff_id) {
      const { count } = await sb.from('breaks')
        .select('id', { count: 'exact', head: true })
        .eq('breaker_id', goal.staff_id).eq('org_id', orgId)
        .gte('created_at', monthStart).lte('created_at', monthEnd);
      currentValue = count || 0;
    }

    if (goal.goal_type === 'individual_revenue' && goal.staff_id) {
      const { data: breakData } = await sb.from('breaks')
        .select('revenue').eq('breaker_id', goal.staff_id).eq('org_id', orgId)
        .gte('created_at', monthStart).lte('created_at', monthEnd);
      currentValue = (breakData || []).reduce((s, b) => s + (parseFloat(b.revenue) || 0), 0);
    }

    await sb.from('monthly_goals')
      .update({ current_value: currentValue, updated_at: new Date().toISOString() })
      .eq('id', goal.id);
  }
}

// ═════════════════════════════════════════════════════════════════════════════
// EMAIL TEMPLATES (absorbed from notify files)
// ═════════════════════════════════════════════════════════════════════════════

function escHtml(str) {
  return String(str || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function buildStreamClosedText(name, streamKey, breaks, sortUrl) {
  return `Hey ${name},\n\n${streamKey} just closed. ${breaks} ${breaks === 1 ? 'break needs' : 'breaks need'} sorting.\n\nOldest stream is always first in your queue:\n${sortUrl}\n\n— Card Break Pro`;
}

function buildStreamClosedHtml(name, streamKey, breaks, sortUrl) {
  return `<!DOCTYPE html><html><head><meta charset="utf-8"></head><body style="margin:0;padding:0;background:#f4f4f5;font-family:'Segoe UI',system-ui,sans-serif;"><div style="max-width:560px;margin:40px auto;background:#fff;border-radius:12px;overflow:hidden;box-shadow:0 2px 12px rgba(0,0,0,0.08);"><div style="background:#0d0d14;padding:24px 28px;"><div style="font-size:1rem;font-weight:800;letter-spacing:2px;color:#e2e8f0;">CARD <span style="color:#4f6ef7;">BREAK</span> PRO</div></div><div style="padding:32px 28px;"><p style="margin:0 0 16px;font-size:1rem;color:#1e293b;">Hey ${escHtml(name)},</p><p style="margin:0 0 16px;font-size:0.97rem;color:#334155;line-height:1.65;"><strong>${escHtml(streamKey)}</strong> just closed. <strong>${breaks} ${breaks === 1 ? 'break needs' : 'breaks need'} sorting.</strong></p><p style="margin:0 0 24px;font-size:0.9rem;color:#64748b;">Oldest stream is always first in your queue.</p><a href="${sortUrl}" style="display:inline-block;background:#4f6ef7;color:#fff;text-decoration:none;padding:12px 24px;border-radius:8px;font-weight:700;font-size:0.9rem;">Go to Sort Queue →</a><p style="margin:28px 0 0;font-size:0.85rem;color:#94a3b8;">— Card Break Pro</p></div></div></body></html>`;
}

function buildInventoryLowText(name, productName, stock, inventoryUrl) {
  return `Hey ${name},\n\n${productName} is down to ${stock} ${stock === 1 ? 'box' : 'boxes'}.\n\nYou may want to restock before your next stream.\n\nView inventory: ${inventoryUrl}\n\n— Card Break Pro`;
}

function buildInventoryLowHtml(name, productName, stock, inventoryUrl) {
  const stockColor = stock === 0 ? '#ef4444' : '#f59e0b';
  return `<!DOCTYPE html><html><head><meta charset="utf-8"></head><body style="margin:0;padding:0;background:#f4f4f5;font-family:'Segoe UI',system-ui,sans-serif;"><div style="max-width:560px;margin:40px auto;background:#fff;border-radius:12px;overflow:hidden;box-shadow:0 2px 12px rgba(0,0,0,0.08);"><div style="background:#0d0d14;padding:24px 28px;"><div style="font-size:1rem;font-weight:800;letter-spacing:2px;color:#e2e8f0;">CARD <span style="color:#4f6ef7;">BREAK</span> PRO</div></div><div style="padding:32px 28px;"><p style="margin:0 0 16px;font-size:1rem;color:#1e293b;">Hey ${escHtml(name)},</p><div style="background:#fffbeb;border:1px solid #fbbf24;border-radius:10px;padding:16px 20px;margin-bottom:20px;"><div style="font-size:0.75rem;font-weight:700;color:#b45309;text-transform:uppercase;margin-bottom:6px;">Low Stock Alert</div><div style="font-size:1.1rem;font-weight:800;color:#1e293b;">${escHtml(productName)}</div><div style="margin-top:4px;font-size:0.95rem;color:${stockColor};font-weight:700;">${stock} ${stock === 1 ? 'box' : 'boxes'} remaining</div></div><p style="margin:0 0 24px;font-size:0.9rem;color:#334155;line-height:1.65;">You may want to restock before your next stream.</p><a href="${inventoryUrl}" style="display:inline-block;background:#4f6ef7;color:#fff;text-decoration:none;padding:12px 24px;border-radius:8px;font-weight:700;font-size:0.9rem;">View Inventory →</a><p style="margin:28px 0 0;font-size:0.85rem;color:#94a3b8;">— Card Break Pro</p></div></div></body></html>`;
}
