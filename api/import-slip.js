const busboy = require('busboy');
const pdfParse = require('pdf-parse');

module.exports.config = { api: { bodyParser: false } };

module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const buffer = await extractFileBuffer(req);
    const pdfData = await pdfParse(buffer);

    // Debug mode — returns raw extracted text so the parser can be updated
    if (req.query.debug === '1') {
      return res.status(200).json({ raw: pdfData.text, pages: pdfData.numpages });
    }

    const result = parseWhatnotSlips(pdfData.text);
    return res.status(200).json(result);
  } catch (err) {
    console.error('import-slip error:', err);
    // If it's a parse failure, include a snippet of extracted text to help diagnose
    return res.status(500).json({ error: err.message || 'Failed to parse PDF' });
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
  const lines = rawText.split('\n').map(l => l.trim()).filter(l => l.length > 0);

  // Find all PACKING SLIP boundaries
  const slipStarts = [];
  for (let i = 0; i < lines.length; i++) {
    if (/PACKING\s*SLIP/i.test(lines[i])) slipStarts.push(i);
  }

  // Split into blocks
  let slipBlocks = [];
  if (slipStarts.length === 0) {
    slipBlocks = [lines]; // treat entire text as one slip
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
        // Combine: multi-page continuation or second shipment
        const existing = slipMap.get(key);
        const existingOrders = new Set(existing.items.map(x => x.orderNumber).filter(Boolean));
        for (const item of slip.items) {
          if (item.orderNumber && existingOrders.has(item.orderNumber)) continue;
          existing.items.push(item);
          if (item.orderNumber) existingOrders.add(item.orderNumber);
        }
        existing.totalSpent = parseFloat(existing.items.reduce((s, x) => s + x.amount, 0).toFixed(2));
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
    totalNewBuyers: buyers.filter(b => b.isNew).length,
    totalRevenueParsed: parseFloat(buyers.reduce((s, b) => s + (b.totalSpent || 0), 0).toFixed(2))
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

  // 1. Username — first @handle in the text
  const usernameMatch = fullText.match(/@([\w._-]{2,50})/);
  if (usernameMatch) username = usernameMatch[1];

  // 2. NEW badge — look for "NEW" near the username
  if (username) {
    const userLineIdx = lines.findIndex(l => l.includes('@' + username));
    if (userLineIdx >= 0) {
      const window = lines.slice(Math.max(0, userLineIdx - 1), Math.min(lines.length, userLineIdx + 3));
      isNew = window.some(l => /\bNEW\b/.test(l));
    }
  }

  // 3. Real name — line after "To" / username block
  const toIdx = lines.findIndex(l => /^To\s*$/i.test(l) || /^To\s+@/i.test(l));
  if (toIdx >= 0) {
    for (let i = toIdx + 1; i < Math.min(toIdx + 7, lines.length); i++) {
      const l = lines[i];
      if (!l || l.startsWith('@') || /\bNEW\b/i.test(l) || /^(To|From)\b/i.test(l)) continue;
      if (/^\d/.test(l) || l.includes('$') || l.includes('#')) continue;
      if (/^[A-Za-z][A-Za-z .'-]{1,59}$/.test(l)) { realName = l; break; }
    }
  }

  // 4. Stream name and date from "From" section
  const fromIdx = lines.findIndex(l => /^From\s*$/i.test(l) || /^From\s+[A-Za-z0-9]/i.test(l));
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

  // 5. Line items — lines ending with a dollar amount > $0.00
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    const moneyMatch = l.match(/\$(\d+\.?\d*)\s*$/);
    if (!moneyMatch) continue;
    const amount = parseFloat(moneyMatch[1]);
    if (amount === 0) continue;
    if (/items?\s+total|subtotal|shipping|tax|discount/i.test(l)) continue;
    if (/shipped?\s+(via|by)|tracking/i.test(l)) continue;

    // Extract order number and break name
    let breakName = '';
    let orderNumber = '';
    const orderMatch = l.match(/#(\w{5,20})/);
    if (orderMatch) {
      orderNumber = orderMatch[1];
      breakName = l.substring(0, l.indexOf('#' + orderNumber)).trim();
    } else {
      breakName = l.substring(0, l.lastIndexOf('$')).trim();
      // Check adjacent line for order number
      for (const adj of [lines[i - 1], lines[i + 1]]) {
        if (!adj) continue;
        const adjOrder = adj.match(/#(\w{5,20})/);
        if (adjOrder) { orderNumber = adjOrder[1]; break; }
      }
    }

    // Fallback: if break name empty, use previous non-special line
    if (!breakName && i > 0) {
      for (let j = i - 1; j >= Math.max(0, i - 3); j--) {
        const prev = lines[j];
        if (prev && !/\$/.test(prev) && !/^(To|From|PACKING|Shipped?)/i.test(prev) && prev.length > 3) {
          breakName = prev; break;
        }
      }
    }

    if (!breakName || /^(packing|from|to|shipped|tracking|order)/i.test(breakName)) continue;

    items.push({
      breakName: breakName.slice(0, 120),
      orderNumber: orderNumber || '',
      amount
    });
  }

  const totalSpent = parseFloat(items.reduce((s, x) => s + x.amount, 0).toFixed(2));

  return { username, isNew, realName, streamName, streamDate, items, totalSpent };
}
