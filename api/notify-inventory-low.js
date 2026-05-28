// CardBreakPro — Inventory Low Notification (Trigger 3)
// POST /api/notify-inventory-low
// Called after a break is submitted and stock was deducted.
// Fires for any product that dropped to ≤ 3 units.
// Duplicate prevention: checks if an unread inventory_low notification
// already exists for this product before inserting a new one.

const { createClient } = require('@supabase/supabase-js');
const { sendEmail } = require('./send-email');

const APP_URL = process.env.APP_URL || 'https://cardbreakpro.com';

module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).end();

  // products: [{ id, name, current_stock }]
  const { org_id, products } = req.body || {};
  if (!org_id || !Array.isArray(products) || products.length === 0) {
    return res.status(400).json({ error: 'org_id and products[] required' });
  }

  const sb = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY
  );

  // Only products at or below threshold
  const LOW_THRESHOLD = 3;
  const lowProducts = products.filter(p => p.current_stock <= LOW_THRESHOLD);
  if (lowProducts.length === 0) return res.status(200).json({ sent: 0 });

  // Get owner and managers for this org
  const { data: recipients } = await sb
    .from('profiles')
    .select('id, display_name, role')
    .eq('org_id', org_id)
    .in('role', ['owner', 'manager']);

  if (!recipients || recipients.length === 0) {
    return res.status(200).json({ sent: 0, reason: 'no recipients' });
  }

  const inventoryUrl = APP_URL + '/dashboard#inventory';
  let totalSent = 0;

  for (const product of lowProducts) {
    // Duplicate prevention: check for an existing unread notification for this product
    const { data: existing } = await sb
      .from('notifications')
      .select('id')
      .eq('organization_id', org_id)
      .eq('type', 'inventory_low')
      .eq('is_read', false)
      .ilike('body', `%${product.name}%`)
      .limit(1)
      .maybeSingle();

    if (existing) continue; // already notified, don't spam

    const title = 'Inventory running low';
    const body = `${product.name} is down to ${product.current_stock} ${product.current_stock === 1 ? 'box' : 'boxes'}. You may want to restock before your next stream.`;
    const actionUrl = inventoryUrl;

    for (const recipient of recipients) {
      const { data: prefs } = await sb
        .from('notification_preferences')
        .select('*')
        .eq('user_id', recipient.id)
        .maybeSingle();

      const inApp = prefs ? prefs.in_app_notifications_enabled : true;
      const email = prefs ? prefs.email_notifications_enabled  : true;
      const inv   = prefs ? prefs.notify_inventory_low         : true;
      if (!inv) continue;

      if (inApp) {
        await sb.from('notifications').insert({
          organization_id: org_id,
          user_id: recipient.id,
          type: 'inventory_low',
          title,
          body,
          action_url: actionUrl
        });
      }

      if (email) {
        const { data: authUser } = await sb.auth.admin.getUserById(recipient.id);
        const toEmail = authUser?.user?.email;
        if (toEmail) {
          const firstName = (recipient.display_name || '').split(' ')[0] || 'there';
          try {
            await sendEmail({
              to: toEmail,
              subject: `Low inventory: ${product.name}`,
              html: buildInventoryLowHtml(firstName, product.name, product.current_stock, inventoryUrl),
              text: buildInventoryLowText(firstName, product.name, product.current_stock, inventoryUrl)
            });
          } catch (e) {
            console.error('Email send error (inventory low):', e.message);
          }
        }
      }
      totalSent++;
    }
  }

  return res.status(200).json({ sent: totalSent });
};

function buildInventoryLowText(name, productName, stock, inventoryUrl) {
  return `Hey ${name},

${productName} is down to ${stock} ${stock === 1 ? 'box' : 'boxes'}.

You may want to restock before your next stream.

View inventory: ${inventoryUrl}

— Card Break Pro`;
}

function buildInventoryLowHtml(name, productName, stock, inventoryUrl) {
  const stockColor = stock === 0 ? '#ef4444' : '#f59e0b';
  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#f4f4f5;font-family:'Segoe UI',system-ui,-apple-system,sans-serif;">
<div style="max-width:560px;margin:40px auto;background:#ffffff;border-radius:12px;overflow:hidden;box-shadow:0 2px 12px rgba(0,0,0,0.08);">
  <div style="background:#0d0d14;padding:24px 28px;">
    <div style="font-size:1rem;font-weight:800;letter-spacing:2px;color:#e2e8f0;">CARD <span style="color:#4f6ef7;">BREAK</span> PRO</div>
  </div>
  <div style="padding:32px 28px;">
    <p style="margin:0 0 16px;font-size:1rem;color:#1e293b;">Hey ${escHtml(name)},</p>
    <div style="background:#fffbeb;border:1px solid #fbbf24;border-radius:10px;padding:16px 20px;margin-bottom:20px;">
      <div style="font-size:0.75rem;font-weight:700;color:#b45309;text-transform:uppercase;letter-spacing:0.5px;margin-bottom:6px;">Low Stock Alert</div>
      <div style="font-size:1.1rem;font-weight:800;color:#1e293b;">${escHtml(productName)}</div>
      <div style="margin-top:4px;font-size:0.95rem;color:${stockColor};font-weight:700;">${stock} ${stock === 1 ? 'box' : 'boxes'} remaining</div>
    </div>
    <p style="margin:0 0 24px;font-size:0.9rem;color:#334155;line-height:1.65;">You may want to restock before your next stream.</p>
    <a href="${inventoryUrl}" style="display:inline-block;background:#4f6ef7;color:#fff;text-decoration:none;padding:12px 24px;border-radius:8px;font-weight:700;font-size:0.9rem;">View Inventory →</a>
    <p style="margin:28px 0 0;font-size:0.85rem;color:#94a3b8;">— Card Break Pro</p>
  </div>
</div>
</body></html>`;
}

function escHtml(str) {
  return String(str || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}
