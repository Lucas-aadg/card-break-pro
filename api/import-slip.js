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

    // Debug mode — returns raw text for parser diagnostics
    if (req.query.debug === '1') {
      return res.status(200).json({ raw: rawText, pages: pdfData.numpages });
    }

    if (!rawText || rawText.trim().length < 20) {
      return res.status(500).json({ error: 'This PDF has no extractable text. Make sure it\'s a Whatnot packing slip PDF (not a scanned image).' });
    }

    const result = parseWhatnotSlips(rawText);
    return res.status(200).json(result);
  } catch (err) {
    console.error('import-slip error:', err.message);
    console.error('import-slip raw sample:', rawText.slice(0, 2000));
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

  // ── Strategy 1: split on "PACKING SLIP" headers ──────────────────────────
  let slipStarts = [];
  for (let i = 0; i < lines.length; i++) {
    if (/PACKING[\s\-_]*SLIP/i.test(lines[i])) slipStarts.push(i);
  }

  // ── Strategy 2: split on repeated "Order" or "#XXXXX" blocks ─────────────
  if (slipStarts.length === 0) {
    for (let i = 0; i < lines.length; i++) {
      if (/^order\s*#?\s*[A-Z0-9]{5,}/i.test(lines[i])) slipStarts.push(i);
    }
  }

  // ── Strategy 3: treat whole doc as one slip ───────────────────────────────
  let slipBlocks = [];
  if (slipStarts.length === 0) {
    slipBlocks = [lines];
  } else {
    for (let i = 0; i < slipStarts.length; i++) {
      const start = slipStarts[i];
      const end = i + 1 < slipStarts.length ? slipStarts[i + 1] : lines.length;
      slipBlocks.push(lines.slice(start, end));
    }
  }

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
        const existing = slipMap.get(key);
        const existingOrders = new Set(existing.items.map(function(x){ return x.orderNumber; }).filter(Boolean));
        for (const item of slip.items) {
          if (item.orderNumber && existingOrders.has(item.orderNumber)) continue;
          existing.items.push(item);
          if (item.orderNumber) existingOrders.add(item.orderNumber);
        }
        existing.totalSpent = parseFloat(existing.items.reduce(function(s, x){ return s + x.amount; }, 0).toFixed(2));
        if (!existing.totalSpent && slip.totalSpent) existing.totalSpent = slip.totalSpent;
      } else {
        slipMap.set(key, slip);
      }
    } catch (e) {
      console.warn('Slip block parse error:', e.message);
    }
  }

  if (slipMap.size === 0) {
    throw new Error('No buyer data found. Check that this is a Whatnot packing slip PDF.');
  }

  const buyers = Array.from(slipMap.values());
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
  let username = '';
  let isNew = false;
  let realName = '';
  let streamName = '';
  let streamDate = '';
  const items = [];

  const fullText = lines.join(' ');

  // ── USERNAME — multiple strategies ───────────────────────────────────────

  // S1: standard @handle
  let umatch = fullText.match(/@([\w._-]{2,50})/);
  if (umatch) username = umatch[1];

  // S2: "Ship To: username" or "Buyer: username" — with or without @
  if (!username) {
    const labelMatch = fullText.match(/(?:ship\s*to|buyer|username)[:\s]+@?([\w._-]{3,50})/i);
    if (labelMatch) username = labelMatch[1];
  }

  // S3: line that IS just @username or "username" right after a "To" line
  if (!username) {
    const toIdx = lines.findIndex(function(l){ return /^to\s*[:\-]?\s*@?([\w._-]{3,50})\s*$/i.test(l); });
    if (toIdx >= 0) {
      const m = lines[toIdx].match(/^to\s*[:\-]?\s*@?([\w._-]{3,50})\s*$/i);
      if (m) username = m[1];
    }
  }

  // S4: line that is just an @handle on its own
  if (!username) {
    for (const l of lines) {
      const m = l.match(/^@([\w._-]{2,50})$/);
      if (m) { username = m[1]; break; }
    }
  }

  // S5: any @-word anywhere (widest net)
  if (!username) {
    const anyAt = fullText.match(/\s@([\w._-]{2,50})/);
    if (anyAt) username = anyAt[1];
  }

  if (!username) return { username: '', isNew: false, realName: '', streamName: '', streamDate: '', items: [], totalSpent: 0 };

  // ── NEW buyer badge ───────────────────────────────────────────────────────
  const userLineIdx = lines.findIndex(function(l){ return l.includes('@' + username) || l.toLowerCase().includes(username.toLowerCase()); });
  if (userLineIdx >= 0) {
    const win = lines.slice(Math.max(0, userLineIdx - 1), Math.min(lines.length, userLineIdx + 3));
    isNew = win.some(function(l){ return /\bNEW\b/.test(l); });
  }

  // ── REAL NAME ─────────────────────────────────────────────────────────────
  const toIdx = lines.findIndex(function(l){ return /^To\s*$/i.test(l) || /^To\s+@/i.test(l) || /^To\s*:/i.test(l); });
  if (toIdx >= 0) {
    for (let i = toIdx + 1; i < Math.min(toIdx + 7, lines.length); i++) {
      const l = lines[i];
      if (!l || l.startsWith('@') || /\bNEW\b/i.test(l) || /^(To|From)\b/i.test(l)) continue;
      if (/^\d/.test(l) || l.includes('$') || l.includes('#')) continue;
      if (/^[A-Za-z][A-Za-z .'-]{1,59}$/.test(l)) { realName = l; break; }
    }
  }

  // ── STREAM NAME + DATE ────────────────────────────────────────────────────
  const fromIdx = lines.findIndex(function(l){ return /^From\s*$/i.test(l) || /^From\s+[A-Za-z0-9]/i.test(l); });
  if (fromIdx >= 0) {
    const fromLine = lines[fromIdx];
    if (/^From\s+\S/i.test(fromLine)) {
      streamName = fromLine.replace(/^From\s+/i, '').trim();
    } else if (fromIdx + 1 < lines.length) {
      streamName = lines[fromIdx + 1];
    }
    for (let i = fromIdx + 1; i < Math.min(fromIdx + 5, lines.length); i++) {
      const l = lines[i];
      if (/\b(January|February|March|April|May|June|July|August|September|October|November|December)\b/i.test(l)
          || /\b\d{1,2}[\/\-]\d{1,2}[\/\-]\d{2,4}\b/.test(l)) {
        streamDate = l; break;
      }
    }
  }

  // ── LINE ITEMS — multiple strategies ─────────────────────────────────────

  // S1: line ending with $XX.XX (original)
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    const moneyMatch = l.match(/\$(\d{1,6}\.?\d{0,2})\s*$/);
    if (!moneyMatch) continue;
    const amount = parseFloat(moneyMatch[1]);
    if (amount === 0) continue;
    if (/items?\s+total|subtotal|order\s*total|grand\s*total|shipping|tax|discount|total\s*due/i.test(l)) continue;
    if (/shipped?\s+(via|by)|tracking/i.test(l)) continue;

    let breakName = '';
    let orderNumber = '';
    const orderMatch = l.match(/#([A-Z0-9]{5,20})/i);
    if (orderMatch) {
      orderNumber = orderMatch[1];
      breakName = l.substring(0, l.indexOf(orderMatch[0])).trim();
    } else {
      breakName = l.substring(0, l.lastIndexOf('$')).trim();
      for (const adj of [lines[i - 1], lines[i + 1]]) {
        if (!adj) continue;
        const adjOrder = adj.match(/#([A-Z0-9]{5,20})/i);
        if (adjOrder) { orderNumber = adjOrder[1]; break; }
      }
    }

    if (!breakName && i > 0) {
      for (let j = i - 1; j >= Math.max(0, i - 3); j--) {
        const prev = lines[j];
        if (prev && !/\$/.test(prev) && !/^(To|From|PACKING|Shipped?|Order|#)/i.test(prev) && prev.length > 3) {
          breakName = prev; break;
        }
      }
    }

    if (!breakName || /^(packing|from|to|shipped|tracking|order|total|subtotal)/i.test(breakName)) continue;

    items.push({ breakName: breakName.slice(0, 120), orderNumber: orderNumber || '', amount });
  }

  // S2: if no items found, look for $ amounts anywhere in lines (not just end)
  if (items.length === 0) {
    for (let i = 0; i < lines.length; i++) {
      const l = lines[i];
      const inlineMatch = l.match(/\$(\d{1,6}\.?\d{0,2})/);
      if (!inlineMatch) continue;
      const amount = parseFloat(inlineMatch[1]);
      if (amount === 0 || amount > 9999) continue;
      if (/items?\s+total|subtotal|order\s*total|grand\s*total|shipping|tax|discount|total\s*due/i.test(l)) continue;
      if (/shipped?\s+(via|by)|tracking/i.test(l)) continue;
      const breakName = l.replace(/\$[\d.]+/g, '').trim().slice(0, 120);
      if (!breakName || breakName.length < 2) continue;
      if (/^(packing|from|to|shipped|tracking|order)/i.test(breakName)) continue;
      items.push({ breakName, orderNumber: '', amount });
    }
  }

  // S3: if STILL no items, try to grab the total from an "Order Total" or "Subtotal" line
  let totalSpent = parseFloat(items.reduce(function(s, x){ return s + x.amount; }, 0).toFixed(2));
  if (totalSpent === 0) {
    const totalLine = lines.find(function(l){ return /(?:order\s*total|subtotal|grand\s*total|total\s*due)[:\s]+\$?(\d{1,6}\.?\d{0,2})/i.test(l); });
    if (totalLine) {
      const tm = totalLine.match(/\$?(\d{1,6}\.?\d{0,2})\s*$/);
      if (tm) totalSpent = parseFloat(tm[1]) || 0;
    }
  }

  return { username, isNew, realName, streamName, streamDate, items, totalSpent };
}
