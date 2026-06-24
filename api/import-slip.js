const busboy = require('busboy');
const pdfParse = require('pdf-parse');

module.exports.config = { api: { bodyParser: false } };

module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  let rawText = '';
  try {
    const buffer = await extractFileBuffer(req);
    const pdfData = await pdfParse(buffer);
    rawText = pdfData.text || '';

    if (req.query.debug === '1') {
      return res.status(200).json({ raw: rawText, pages: pdfData.numpages });
    }

    if (!rawText || rawText.trim().length < 20) {
      return res.status(500).json({ error: 'PDF has no extractable text. Make sure this is a Whatnot packing slip PDF.' });
    }

    const result = parseWhatnotSlips(rawText);
    return res.status(200).json(result);
  } catch (err) {
    console.error('import-slip error:', err.message);
    console.error('raw sample:', rawText.slice(0, 2000));
    return res.status(500).json({ error: err.message || 'Failed to parse PDF', raw_sample: rawText.slice(0, 2000) });
  }
};

function extractFileBuffer(req) {
  return new Promise((resolve, reject) => {
    const bb = busboy({ headers: req.headers, limits: { fileSize: 50 * 1024 * 1024 } });
    let fileBuffer = null;
    bb.on('file', (_field, stream) => {
      const chunks = [];
      stream.on('data', d => chunks.push(d));
      stream.on('end', () => { fileBuffer = Buffer.concat(chunks); });
      stream.on('error', reject);
    });
    bb.on('error', reject);
    bb.on('finish', () => {
      if (fileBuffer && fileBuffer.length > 0) resolve(fileBuffer);
      else reject(new Error('No file received in upload'));
    });
    req.pipe(bb);
  });
}

function parseWhatnotSlips(rawText) {
  const lines = rawText.split('\n').map(function(l){ return l.trim(); }).filter(function(l){ return l.length > 0; });

  // Split into per-buyer blocks on "Whatnot Packing Slip" or "Packing Slip" headers
  const slipStarts = [];
  for (let i = 0; i < lines.length; i++) {
    if (/(?:Whatnot\s+)?Packing\s+Slip/i.test(lines[i])) slipStarts.push(i);
  }

  let slipBlocks = slipStarts.length > 0
    ? slipStarts.map(function(start, idx) {
        const end = idx + 1 < slipStarts.length ? slipStarts[idx + 1] : lines.length;
        return lines.slice(start, end);
      })
    : [lines];

  const slipMap = new Map();
  let streamName = '';
  let streamDate = '';

  for (const block of slipBlocks) {
    try {
      const slip = extractSlipData(block);
      if (!slip.username) continue;
      if (slip.streamName) streamName = slip.streamName;
      if (slip.streamDate) streamDate = slip.streamDate;

      const key = slip.username.toLowerCase();
      if (slipMap.has(key)) {
        // Merge multi-page / multi-package slips for same buyer
        const existing = slipMap.get(key);
        const existingOrders = new Set(existing.items.map(function(x){ return x.orderNumber; }).filter(Boolean));
        for (const item of slip.items) {
          if (item.orderNumber && existingOrders.has(item.orderNumber)) continue;
          existing.items.push(item);
          if (item.orderNumber) existingOrders.add(item.orderNumber);
        }
        existing.totalSpent = parseFloat(existing.items.reduce(function(s, x){ return s + (x.amount || 0); }, 0).toFixed(2));
        // Fall back to slip total if no line items found
        if (!existing.totalSpent && slip.totalSpent) existing.totalSpent = slip.totalSpent;
      } else {
        slipMap.set(key, slip);
      }
    } catch (e) {
      console.warn('Slip block error:', e.message);
    }
  }

  if (slipMap.size === 0) {
    throw new Error('No buyer data found. Check that this is a Whatnot packing slip PDF.');
  }

  // Exclude giveaway-only recipients — zero spend and no parsed items
  const buyers = Array.from(slipMap.values()).filter(function(b) {
    return b.items.length > 0 || b.totalSpent > 0;
  });
  return {
    buyers,
    streamName: streamName || '',
    streamDate: streamDate || '',
    totalBuyersFound: buyers.length,
    totalNewBuyers: buyers.filter(function(b){ return b.isNew; }).length,
    totalRevenueParsed: parseFloat(buyers.reduce(function(s, b){ return s + (b.totalSpent || 0); }, 0).toFixed(2))
  };
}

function extractSlipData(lines) {
  const fullText = lines.join(' ');

  // ── USERNAME ─────────────────────────────────────────────────────────────
  // New Whatnot format: "To: username [NEW] From: seller"
  let username = '';

  // Primary: "To: username" — handles format with or without @
  const toColonMatch = fullText.match(/\bTo:\s+@?([\w._-]{2,50})/i);
  if (toColonMatch) username = toColonMatch[1];

  // Fallback: any @handle in text (old format)
  if (!username) {
    const atMatch = fullText.match(/@([\w._-]{2,50})/);
    if (atMatch) username = atMatch[1];
  }

  // Fallback: line that starts with "To " and ends with username
  if (!username) {
    for (const l of lines) {
      const m = l.match(/^To:\s*@?([\w._-]{2,50})\s*(?:NEW\s*)?(?:From:|$)/i);
      if (m) { username = m[1]; break; }
    }
  }

  if (!username) {
    return { username: '', isNew: false, realName: '', streamName: '', streamDate: '', items: [], totalSpent: 0 };
  }

  // ── NEW BADGE ─────────────────────────────────────────────────────────────
  const isNew = /\bTo:\s+@?[\w._-]+\s+NEW\b/i.test(fullText) ||
    lines.some(function(l){ return /\bNEW\b/.test(l) && l.toLowerCase().includes(username.toLowerCase()); });

  // ── REAL NAME (line after "To: username" line) ────────────────────────────
  let realName = '';
  const toLineIdx = lines.findIndex(function(l){ return /\bTo:\s+/i.test(l) && l.toLowerCase().includes(username.toLowerCase()); });
  if (toLineIdx >= 0) {
    for (let i = toLineIdx + 1; i < Math.min(toLineIdx + 5, lines.length); i++) {
      const l = lines[i];
      if (!l || /^(From|To|QTY|Order|USPS|■|\d+\s)/i.test(l)) continue;
      if (l.includes('$') || l.includes('#')) continue;
      if (/^[A-Za-z][A-Za-z .']{1,59}$/.test(l)) { realName = l; break; }
    }
  }

  // ── STREAM NAME + DATE from "From:" section ───────────────────────────────
  let streamName = '';
  let streamDate = '';
  const fromMatch = fullText.match(/From:\s+([^\n$]+?)(?:\s+■|$)/i);
  if (fromMatch) streamName = fromMatch[1].trim();
  for (const l of lines) {
    if (/\b(January|February|March|April|May|June|July|August|September|October|November|December)\b/i.test(l)
        || /\b\d{1,2}[\/\-]\d{1,2}[\/\-]\d{2,4}\b/.test(l)
        || /\b\d{2}\s+(January|February|March|April|May|June|July|August|September|October|November|December)/i.test(l)) {
      streamDate = l; break;
    }
  }

  // ── ITEMS ─────────────────────────────────────────────────────────────────
  // New format: "1 ItemName Order XXXXXXXXXX" on one line, "$XX.00" on own line
  const items = [];

  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];

    // Primary pattern: "1 ItemName Order 1234567890" — item + order on same line
    const itemOrderMatch = l.match(/^\d+\s+(.+?)\s+Order\s+(\d{7,})\s*(.*)$/i);
    if (itemOrderMatch) {
      const rawName = itemOrderMatch[1].trim();
      const orderNumber = itemOrderMatch[2];
      const afterOrder = itemOrderMatch[3].trim();

      // Amount might be inline after order number, or on a later line
      let amount = 0;
      const inlineAmountMatch = afterOrder.match(/\$?(\d+\.?\d*)\s*$/);
      if (inlineAmountMatch) {
        amount = parseFloat(inlineAmountMatch[1]);
      } else {
        // Look forward up to 8 lines for standalone "$XX.XX" or "XX.XX" line
        for (let j = i + 1; j < Math.min(i + 9, lines.length); j++) {
          const amtMatch = lines[j].match(/^\$?(\d+\.?\d{0,2})$/);
          if (amtMatch) { amount = parseFloat(amtMatch[1]); break; }
          // Stop at next item or total
          if (/^\d+\s+\S/.test(lines[j]) || /^\d+\s+Items?\s/i.test(lines[j])) break;
        }
      }

      // Skip $0 giveaways only if break name says GIVEAWAY
      if (amount === 0 && /giveaway/i.test(rawName)) continue;

      const breakName = rawName.replace(/^(QTY|Name|Description|Attributes|Subtotal)\s*/i, '').trim();
      if (!breakName || breakName.length < 1) continue;
      if (/^(QTY|Name|Description|Attributes|Subtotal|From|To|USPS|■)/i.test(breakName)) continue;

      items.push({ breakName: breakName.slice(0, 120), orderNumber, amount });
      continue;
    }

    // Fallback: standalone "$XX.XX" line — try to find item name backward
    const standaloneAmount = l.match(/^\$(\d{1,6}\.?\d{0,2})$/);
    if (standaloneAmount) {
      const amount = parseFloat(standaloneAmount[1]);
      if (amount === 0) continue;

      // Look backward for the item line (starts with digit + space + name)
      let breakName = '';
      let orderNumber = '';
      for (let j = i - 1; j >= Math.max(0, i - 8); j--) {
        const prev = lines[j];
        // Item line: starts with digit followed by item name
        const prevItemMatch = prev.match(/^\d+\s+(.+?)\s+Order\s+(\d{7,})/i);
        if (prevItemMatch) {
          breakName = prevItemMatch[1].trim();
          orderNumber = prevItemMatch[2];
          break;
        }
        // Stop at table headers or new buyer blocks
        if (/^(QTY|Attributes|Subtotal|To:|From:|Whatnot|USPS|■)/i.test(prev)) break;
      }

      if (!breakName) continue;
      if (/^(QTY|Attributes|Subtotal|From|To|USPS)/i.test(breakName)) continue;

      // Avoid duplicates (this line was already captured by the primary pattern)
      const alreadyCaptured = items.some(function(it){ return it.orderNumber && it.orderNumber === orderNumber; });
      if (alreadyCaptured) continue;

      items.push({ breakName: breakName.slice(0, 120), orderNumber, amount });
    }
  }

  // ── TOTAL SPENT from "N Items $XX.00" line if no items parsed ─────────────
  let totalSpent = parseFloat(items.reduce(function(s, x){ return s + (x.amount || 0); }, 0).toFixed(2));
  if (totalSpent === 0) {
    for (const l of lines) {
      const totalMatch = l.match(/\d+\s+Items?\s+\$?(\d+\.?\d{0,2})/i);
      if (totalMatch) { totalSpent = parseFloat(totalMatch[1]); break; }
    }
  }

  return { username, isNew, realName, streamName, streamDate, items, totalSpent };
}
