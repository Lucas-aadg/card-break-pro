const busboy = require('busboy');
const pdfParse = require('pdf-parse');
// Same parser the browser uses (slip-parser.js) — one set of rules, two text sources.
const { SlipParser } = require('../slip-parser.js');
const parseWhatnotSlips = SlipParser.parseWhatnotSlips;

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

