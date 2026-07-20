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
  const rawLines = rawText.split('\n').map(function (l) { return l.trim(); });
  const lines = rawLines.filter(function (l) { return l.length > 0; });

  // Split into page-blocks on the "Whatnot Packing Slip" header line.
  const headerIdx = [];
  for (let i = 0; i < lines.length; i++) {
    if (/Whatnot\s*Packing\s*Slip/i.test(lines[i])) headerIdx.push(i);
  }
  const blocks = headerIdx.map(function (start, idx) {
    const end = idx + 1 < headerIdx.length ? headerIdx[idx + 1] : lines.length;
    return lines.slice(start, end);
  });

  const buyers = [];
  let current = null;   // buyer currently accumulating (for multi-page orders)
  let streamName = '';
  let streamDate = '';

  for (const block of blocks) {
    const to = extractBuyerHeader(block);
    if (to.username) {
      // New buyer starts
      current = {
        username: to.username,
        isNew: to.isNew,
        realName: to.realName,
        items: [],
        slipTotal: null,     // printed "N Items $Total" (grand total on final page)
      };
      buyers.push(current);
      if (to.streamName) streamName = to.streamName;
      if (to.streamDate) streamDate = to.streamDate;
    }
    if (!current) continue; // stray page before any buyer — ignore

    // Items in this block
    const items = extractItems(block);
    for (const it of items) current.items.push(it);

    // Grand-total summary on this block (last one seen wins = final page total)
    const total = extractSlipTotal(block);
    if (total !== null) current.slipTotal = total;
  }

  // Finalize: compute spend, dedupe by order number, validate against printed total
  const warnings = [];
  const finalBuyers = buyers.map(function (b) {
    // Dedupe items by order number (guards against overlap across page merges)
    const seen = new Set();
    const uniqueItems = [];
    for (const it of b.items) {
      if (it.orderNumber && seen.has(it.orderNumber)) continue;
      if (it.orderNumber) seen.add(it.orderNumber);
      uniqueItems.push(it);
    }
    const itemSum = round2(uniqueItems.reduce(function (s, it) { return s + (it.amount || 0); }, 0));
    let totalSpent = itemSum;

    // Validate against printed grand total; trust the printed total for buyer revenue.
    if (b.slipTotal !== null && Math.abs(b.slipTotal - itemSum) > 0.001) {
      warnings.push(b.username + ': parsed items $' + itemSum + ' != slip total $' + b.slipTotal);
      totalSpent = b.slipTotal; // printed total is authoritative for revenue
    }

    return {
      username: b.username,
      isNew: b.isNew,
      realName: b.realName,
      items: uniqueItems,
      totalSpent: totalSpent,
    };
  });

  // Exclude giveaway-only recipients (zero spend, no paid items)
  const paying = finalBuyers.filter(function (b) {
    return b.totalSpent > 0 || b.items.some(function (it) { return it.amount > 0; });
  });

  return {
    buyers: paying,
    streamName: streamName || '',
    streamDate: streamDate || '',
    totalBuyersFound: paying.length,
    totalNewBuyers: paying.filter(function (b) { return b.isNew; }).length,
    totalRevenueParsed: round2(paying.reduce(function (s, b) { return s + (b.totalSpent || 0); }, 0)),
    _warnings: warnings,
    _allBuyerCount: finalBuyers.length,
  };
}

function extractBuyerHeader(block) {
  const result = { username: '', isNew: false, realName: '', streamName: '', streamDate: '' };

  // Find the "To:" line and "From:" line (may be same line: "To: xFrom: y")
  let toLineIdx = -1;
  for (let i = 0; i < block.length; i++) {
    if (/To:/i.test(block[i])) { toLineIdx = i; break; }
  }
  if (toLineIdx === -1) return result; // continuation / summary page

  const toLine = block[toLineIdx];
  // Username = text between "To:" and ("From:" | end). Strip trailing "NEW".
  let uname = '';
  const m = toLine.match(/To:\s*@?(.*?)(?:From:|$)/i);
  if (m) uname = m[1].trim();
  // "NEW" badge may be inline or on its own following line
  if (/\bNEW\b\s*$/.test(uname)) { result.isNew = true; }
  uname = uname.replace(/\s*\bNEW\b\s*$/i, '').trim();
  // Username has no spaces; if any slipped in, take first token
  uname = uname.split(/\s+/)[0] || '';
  result.username = uname;

  // NEW badge on its own line (right after To: line)
  if (!result.isNew) {
    for (let i = toLineIdx; i < Math.min(toLineIdx + 3, block.length); i++) {
      if (/^NEW$/i.test(block[i])) { result.isNew = true; break; }
    }
  }

  // Real name = first "name-like" line after the From: line
  let fromLineIdx = toLineIdx;
  for (let i = toLineIdx; i < block.length; i++) {
    if (/From:/i.test(block[i])) { fromLineIdx = i; break; }
  }
  for (let i = fromLineIdx + 1; i < Math.min(fromLineIdx + 4, block.length); i++) {
    const l = block[i];
    if (!l || /^(NEW|US|USPS|QTY|Order|\d)/i.test(l)) continue;
    if (l.includes('$') || l.includes('#')) continue;
    if (/^[A-Za-z][A-Za-z0-9 .'-]{1,59}$/.test(l)) { result.realName = l; break; }
  }

  // Stream date: a line like "18 July, 2026" or with month name
  for (const l of block) {
    if (/\b\d{1,2}\s+(January|February|March|April|May|June|July|August|September|October|November|December)/i.test(l)
        || /\b(January|February|March|April|May|June|July|August|September|October|November|December)\b.*\d{4}/i.test(l)) {
      result.streamDate = l; break;
    }
  }
  // Stream name: line just before the date that isn't address/US — best effort
  return result;
}

function extractItems(block) {
  const items = [];
  // Locate item-table region: after the "Name & Description" header if present, else whole block.
  let start = 0;
  for (let i = 0; i < block.length; i++) {
    if (/Name\s*&?\s*Description/i.test(block[i])) { start = i + 1; break; }
  }
  // Stop region at the "N Items $" summary or USPS shipping line.
  let end = block.length;
  for (let i = start; i < block.length; i++) {
    if (/^\d+\s*Items?\s*\$/i.test(block[i]) || /^USPS/i.test(block[i])) { end = i; break; }
  }
  const region = block.slice(start, end);

  // Anchor on "Order <digits>" lines.
  for (let i = 0; i < region.length; i++) {
    const om = region[i].match(/^Order\s+(\d{6,})/i);
    if (!om) continue;
    const orderNumber = om[1];

    // Amount = first "$<num>" line after the order (skip attribute lines like "New", "2026 TOPPS...")
    let amount = 0;
    for (let j = i + 1; j < Math.min(i + 8, region.length); j++) {
      const am = region[j].match(/^\$?(\d+(?:\.\d{1,2})?)$/);
      if (am && /\$|\./.test(region[j])) { amount = parseFloat(am[1]); break; }
      if (/^Order\s+\d/i.test(region[j])) break; // next item, no amount found
    }

    // Name = lines between the preceding qty marker and this Order line.
    const nameLines = [];
    for (let j = i - 1; j >= 0; j--) {
      const l = region[j];
      if (/^\d{1,3}$/.test(l)) break;             // qty marker → stop (name is above qty? no—below)
      if (/^\$/.test(l)) break;                    // previous item's amount
      if (/^Order\s+\d/i.test(l)) break;           // previous item's order
      if (/^(GIVEAWAY|GIVVY|New)$/i.test(l)) continue; // badges, keep scanning past
      nameLines.unshift(l);
    }
    let breakName = nameLines.join(' ').replace(/\s+/g, ' ').trim();
    // Giveaway items carry a $0 amount and GIVEAWAY badge
    const isGiveaway = amount === 0;
    if (!breakName) breakName = isGiveaway ? 'Giveaway' : 'Item';

    items.push({ breakName: breakName.slice(0, 120), orderNumber: orderNumber, amount: amount });
  }
  return items;
}

function extractSlipTotal(block) {
  for (const l of block) {
    const m = l.match(/^(\d+)\s*Items?\s*\$?(\d+(?:\.\d{1,2})?)/i);
    if (m) return parseFloat(m[2]);
  }
  return null;
}

function round2(n) { return parseFloat((n || 0).toFixed(2)); }

