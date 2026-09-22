// CardBreakPro — Whatnot packing-slip parser (shared by browser and server)
//
// One parser, two text sources:
//   server  api/import-slip.js → pdf-parse text
//   browser SlipParser.parseSlipFile(file) → pdf.js text, reconstructed the
//           same way pdf-parse does it (items on one baseline concatenated,
//           new baseline = new line, pages joined by a blank line)
// Parsing in the browser means the PDF never has to fit Vercel's 4.5 MB
// request cap or the 30 s function limit — a 150-slip export failed both.
(function (global) {
  'use strict';

  const PDFJS_URL = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js';
  const PDFJS_WORKER = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';
  const SERVER_MAX_BYTES = 4 * 1024 * 1024;   // Vercel rejects bodies > 4.5 MB; keep margin

  // ── text → buyers ───────────────────────────────────────────────────────
  function parseWhatnotSlips(rawText) {
    const rawLines = String(rawText || '').split('\n').map(function (l) { return l.trim(); });
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
        current = {
          username: to.username,
          isNew: to.isNew,
          realName: to.realName,
          items: [],
          slipTotal: null      // printed "N Items $Total" (grand total on final page)
        };
        buyers.push(current);
        if (to.streamName) streamName = to.streamName;
        if (to.streamDate) streamDate = to.streamDate;
      }
      if (!current) continue; // stray page before any buyer — ignore

      const items = extractItems(block);
      for (const it of items) current.items.push(it);

      const total = extractSlipTotal(block);
      if (total !== null) current.slipTotal = total;
    }

    // Finalize: compute spend, dedupe by order number, validate against printed total
    const warnings = [];
    const finalBuyers = buyers.map(function (b) {
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
        totalSpent = b.slipTotal;
      }

      return { username: b.username, isNew: b.isNew, realName: b.realName, items: uniqueItems, totalSpent: totalSpent };
    });

    // Exclude giveaway-only recipients (zero spend, no paid items). Someone who
    // wins a giveaway AND buys spots still has paid items, so they stay.
    const paying = finalBuyers.filter(function (b) {
      return b.username && (b.totalSpent > 0 || b.items.some(function (it) { return it.amount > 0; }));
    });

    return {
      buyers: paying,
      streamName: streamName || '',
      streamDate: streamDate || '',
      totalBuyersFound: paying.length,
      totalNewBuyers: paying.filter(function (b) { return b.isNew; }).length,
      totalRevenueParsed: round2(paying.reduce(function (s, b) { return s + (b.totalSpent || 0); }, 0)),
      totalPagesFound: blocks.length,
      _warnings: warnings,
      _allBuyerCount: finalBuyers.length
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
    let uname = '';
    const m = toLine.match(/To:\s*@?(.*?)(?:From:|$)/i);
    if (m) uname = m[1].trim();
    if (/\bNEW\b\s*$/.test(uname)) { result.isNew = true; }
    uname = uname.replace(/\s*\bNEW\b\s*$/i, '').trim();
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

      // Amount = the price line after the order. Prefer a definite price (has a
      // "$" or a decimal). Only if none exists in the row do we fall back to a
      // bare whole-dollar integer — Whatnot sometimes drops the "$" on whole
      // amounts (e.g. "45"), and the old code silently parsed those as $0, which
      // made real buyers look like giveaway-only and vanish from the import.
      let amount = 0;
      let bareInt = null;
      let looksGiveaway = false;
      for (let j = i + 1; j < Math.min(i + 8, region.length); j++) {
        if (/^Order\s+\d/i.test(region[j])) break; // reached next item
        if (/GIVEAWAY|GIVVY/i.test(region[j])) looksGiveaway = true;
        const am = region[j].match(/^\$?(\d+(?:\.\d{1,2})?)$/);
        if (!am) continue;
        if (/[\$.]/.test(region[j])) { amount = parseFloat(am[1]); break; } // definite price
        if (bareInt === null) bareInt = parseFloat(am[1]);                  // remember first bare integer
      }
      // Fall back to a bare whole-dollar integer only when no definite price was
      // found AND this isn't a flagged giveaway — so a qty column on a $0 giveaway
      // can't be misread as a $1 purchase (giveaway-only buyers must stay excluded).
      if (amount === 0 && bareInt !== null && !looksGiveaway) amount = bareInt;

      // Name = lines between the preceding qty marker and this Order line.
      const nameLines = [];
      for (let j = i - 1; j >= 0; j--) {
        const l = region[j];
        if (/^\d{1,3}$/.test(l)) break;             // qty marker → stop
        if (/^\$/.test(l)) break;                    // previous item's amount
        if (/^Order\s+\d/i.test(l)) break;           // previous item's order
        if (/^(GIVEAWAY|GIVVY|New)$/i.test(l)) continue; // badges, keep scanning past
        nameLines.unshift(l);
      }
      let breakName = nameLines.join(' ').replace(/\s+/g, ' ').trim();
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

  // ── browser: PDF → text (pdf.js), matching pdf-parse's line rules ───────
  let _pdfjsPromise = null;
  function loadPdfJs() {
    if (typeof window === 'undefined' || typeof document === 'undefined') return Promise.reject(new Error('browser only'));
    if (window.pdfjsLib) { ensureWorker(window.pdfjsLib); return Promise.resolve(window.pdfjsLib); }
    if (_pdfjsPromise) return _pdfjsPromise;
    _pdfjsPromise = new Promise(function (resolve, reject) {
      const s = document.createElement('script');
      s.src = PDFJS_URL; s.async = true;
      s.onload = function () {
        if (window.pdfjsLib) { ensureWorker(window.pdfjsLib); resolve(window.pdfjsLib); }
        else reject(new Error('PDF reader failed to initialise'));
      };
      s.onerror = function () { _pdfjsPromise = null; reject(new Error('Could not load the PDF reader — check your connection')); };
      document.head.appendChild(s);
    });
    return _pdfjsPromise;
  }
  function ensureWorker(lib) {
    try { if (lib.GlobalWorkerOptions && !lib.GlobalWorkerOptions.workerSrc) lib.GlobalWorkerOptions.workerSrc = PDFJS_WORKER; } catch (e) {}
  }

  async function extractPdfText(file) {
    const pdfjs = await loadPdfJs();
    const buf = await file.arrayBuffer();
    const pdf = await pdfjs.getDocument({ data: buf }).promise;
    const pages = [];
    for (let p = 1; p <= pdf.numPages; p++) {
      const page = await pdf.getPage(p);
      const content = await page.getTextContent();
      let lastY = null, text = '';
      for (const item of content.items) {
        if (!item || typeof item.str !== 'string') continue;
        const y = item.transform ? item.transform[5] : lastY;
        if (lastY === null || y === lastY) text += item.str;
        else text += '\n' + item.str;
        lastY = y;
      }
      pages.push(text);
      try { page.cleanup(); } catch (e) {}
    }
    try { pdf.destroy(); } catch (e) {}
    return { text: pages.join('\n\n'), pages: pdf.numPages };
  }

  async function parseInBrowser(file) {
    const { text, pages } = await extractPdfText(file);
    if (!text || text.trim().length < 20) throw new Error('PDF has no extractable text. Make sure this is a Whatnot packing slip PDF (not a scan).');
    const out = parseWhatnotSlips(text);
    out._parseSource = 'browser';
    out._pages = pages;
    out._rawSample = text.slice(0, 2000);
    return out;
  }

  async function parseOnServer(file, serverUrl) {
    if (file.size > SERVER_MAX_BYTES) throw new Error('File is ' + (file.size / 1048576).toFixed(1) + ' MB — too large for server parsing (4 MB limit).');
    const fd = new FormData();
    fd.append('file', file);
    const resp = await fetch(serverUrl || '/api/import-slip', { method: 'POST', body: fd });
    let json = null;
    try { json = await resp.json(); } catch (e) { throw new Error('Server parse failed (' + resp.status + ')'); }
    if (!resp.ok) throw new Error((json && json.error) || 'Server parse failed');
    json._parseSource = 'server';
    return json;
  }

  // Browser first (no size/time limits), server as a second opinion when the
  // browser finds nothing. Whichever finds more buyers wins; both failures
  // surface as one error that says what each side saw.
  async function parseSlipFile(file, opts) {
    opts = opts || {};
    let browserRes = null, browserErr = null, serverRes = null, serverErr = null;
    try { browserRes = await parseInBrowser(file); } catch (e) { browserErr = e; }
    const browserCount = browserRes ? browserRes.buyers.length : 0;
    if (browserCount === 0 && opts.server !== false) {
      try { serverRes = await parseOnServer(file, opts.serverUrl); } catch (e) { serverErr = e; }
    }
    const serverCount = serverRes ? serverRes.buyers.length : 0;
    const best = serverCount > browserCount ? serverRes : (browserRes || serverRes);
    if (!best) {
      throw new Error((browserErr ? browserErr.message : 'no buyers found') + (serverErr ? ' · server: ' + serverErr.message : ''));
    }
    best._fileSize = file.size;
    best._filename = file.name;
    if (browserRes && serverRes) best._otherSourceCount = best === browserRes ? serverCount : browserCount;
    return best;
  }

  global.SlipParser = { parseWhatnotSlips, parseSlipFile, parseInBrowser, parseOnServer, extractPdfText, SERVER_MAX_BYTES };
})(typeof window !== 'undefined' ? window : module.exports);
