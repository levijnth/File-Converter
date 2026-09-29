// All conversion logic. Everything runs in the browser; files never leave the PC.
import * as pdfjsLib from './vendor/pdfjs/build/pdf.min.mjs';

// Resolve against this module so the app also works when hosted in a sub-folder
// (e.g. GitHub Pages) and inside the PDF worker, which has a different base URL.
const vendorUrl = (p) => new URL(`./vendor/pdfjs/${p}`, import.meta.url).href;

pdfjsLib.GlobalWorkerOptions.workerSrc = vendorUrl('build/pdf.worker.min.mjs');
const PDF_OPTS = {
  cMapUrl: vendorUrl('cmaps/'),
  cMapPacked: true,
  standardFontDataUrl: vendorUrl('standard_fonts/'),
  wasmUrl: vendorUrl('wasm/'),
  iccUrl: vendorUrl('iccs/'),
};

const { jsPDF } = window.jspdf;
const { XLSX, JSZip, mammoth, marked } = window;

// ---------------------------------------------------------------------------
// Format registry
// ---------------------------------------------------------------------------

export const CATEGORIES = {
  image: {
    label: 'Image',
    exts: ['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp', 'svg', 'avif', 'ico'],
    targets: ['png', 'jpg', 'webp', 'bmp', 'pdf'],
  },
  pdf: { label: 'PDF', exts: ['pdf'], targets: ['png', 'jpg', 'webp', 'txt'] },
  sheet: {
    label: 'Spreadsheet',
    exts: ['xlsx', 'xls', 'xlsm', 'ods', 'csv', 'tsv'],
    targets: ['csv', 'xlsx', 'json', 'html', 'ods', 'tsv'],
  },
  json: { label: 'JSON', exts: ['json'], targets: ['csv', 'xlsx', 'html'] },
  docx: { label: 'Word', exts: ['docx'], targets: ['pdf', 'html', 'txt', 'md'] },
  text: { label: 'Text', exts: ['txt', 'md', 'markdown'], targets: ['pdf', 'html'] },
  html: { label: 'HTML', exts: ['html', 'htm'], targets: ['txt', 'pdf'] },
};

const ALIASES = { jpeg: 'jpg', markdown: 'md', htm: 'html' };

export function extOf(name) {
  const i = name.lastIndexOf('.');
  return i < 0 ? '' : name.slice(i + 1).toLowerCase();
}

export function baseName(name) {
  const i = name.lastIndexOf('.');
  return i <= 0 ? name : name.slice(0, i);
}

export function detectCategory(file) {
  const ext = extOf(file.name);
  for (const [key, cat] of Object.entries(CATEGORIES)) {
    if (cat.exts.includes(ext)) return key;
  }
  if (file.type.startsWith('image/')) return 'image';
  if (file.type === 'application/pdf') return 'pdf';
  return null;
}

export function targetsFor(file, category) {
  const ext = ALIASES[extOf(file.name)] || extOf(file.name);
  return CATEGORIES[category].targets.filter((t) => t !== ext);
}

// ---------------------------------------------------------------------------
// Entry point: returns an array of { name, blob }
// ---------------------------------------------------------------------------

export async function convert(file, category, target, opts, onProgress = () => {}) {
  const base = baseName(file.name);
  switch (category) {
    case 'image': return [await convertImage(file, base, target, opts)];
    case 'pdf': return convertPdf(file, base, target, opts, onProgress);
    case 'sheet': return convertWorkbook(await readWorkbook(file), base, target);
    case 'json': return convertWorkbook(jsonToWorkbook(await file.text()), base, target);
    case 'docx': return [await convertDocx(file, base, target)];
    case 'text': return [await convertText(file, base, target)];
    case 'html': return [await convertHtml(file, base, target)];
    default: throw new Error('Unsupported file type');
  }
}

// ---------------------------------------------------------------------------
// Images
// ---------------------------------------------------------------------------

const IMAGE_MIME = { png: 'image/png', jpg: 'image/jpeg', webp: 'image/webp' };

function loadImage(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('Could not decode this image')); };
    img.src = url;
  });
}

function imageToCanvas(img, background) {
  // SVGs without intrinsic size report 0; fall back to a sensible default.
  const w = img.naturalWidth || 1024;
  const h = img.naturalHeight || 1024;
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  if (background) {
    ctx.fillStyle = background;
    ctx.fillRect(0, 0, w, h);
  }
  ctx.drawImage(img, 0, 0, w, h);
  return canvas;
}

function canvasToBlob(canvas, format, quality) {
  if (format === 'bmp') return Promise.resolve(encodeBmp(canvas));
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => (blob ? resolve(blob) : reject(new Error(`Your browser cannot encode ${format.toUpperCase()}`))),
      IMAGE_MIME[format],
      quality,
    );
  });
}

// 24-bit uncompressed BMP encoder (browsers can't export BMP natively).
function encodeBmp(canvas) {
  const { width: w, height: h } = canvas;
  const data = canvas.getContext('2d').getImageData(0, 0, w, h).data;
  const rowSize = Math.ceil((w * 3) / 4) * 4;
  const buf = new ArrayBuffer(54 + rowSize * h);
  const view = new DataView(buf);
  const bytes = new Uint8Array(buf);
  view.setUint16(0, 0x4d42, true);
  view.setUint32(2, buf.byteLength, true);
  view.setUint32(10, 54, true);
  view.setUint32(14, 40, true);
  view.setInt32(18, w, true);
  view.setInt32(22, h, true);
  view.setUint16(26, 1, true);
  view.setUint16(28, 24, true);
  view.setUint32(34, rowSize * h, true);
  view.setInt32(38, 2835, true);
  view.setInt32(42, 2835, true);
  for (let y = 0; y < h; y++) {
    const row = 54 + (h - 1 - y) * rowSize;
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      const o = row + x * 3;
      bytes[o] = data[i + 2];
      bytes[o + 1] = data[i + 1];
      bytes[o + 2] = data[i];
    }
  }
  return new Blob([buf], { type: 'image/bmp' });
}

async function convertImage(file, base, target, opts) {
  const img = await loadImage(file);
  if (target === 'pdf') {
    return { name: `${base}.pdf`, blob: await imagesToPdf([img], opts) };
  }
  const needsBg = target === 'jpg' || target === 'bmp';
  const canvas = imageToCanvas(img, needsBg ? opts.background : null);
  return { name: `${base}.${target}`, blob: await canvasToBlob(canvas, target, opts.quality) };
}

// Each image becomes one page sized to the image (px -> pt at 96 DPI).
async function imagesToPdf(images, opts) {
  let doc;
  for (const img of images) {
    const canvas = imageToCanvas(img, opts.background);
    const w = canvas.width * 0.75;
    const h = canvas.height * 0.75;
    const orientation = w > h ? 'l' : 'p';
    if (!doc) doc = new jsPDF({ unit: 'pt', format: [w, h], orientation });
    else doc.addPage([w, h], orientation);
    doc.addImage(canvas.toDataURL('image/jpeg', opts.quality), 'JPEG', 0, 0, w, h);
  }
  return doc.output('blob');
}

export async function mergeImagesToPdf(files, opts) {
  const images = [];
  for (const f of files) images.push(await loadImage(f));
  return imagesToPdf(images, opts);
}

// ---------------------------------------------------------------------------
// PDF
// ---------------------------------------------------------------------------

// Returns the document plus a close() that frees the worker-side resources.
async function openPdf(file) {
  const data = new Uint8Array(await file.arrayBuffer());
  const task = pdfjsLib.getDocument({ data, ...PDF_OPTS });
  try {
    const pdf = await task.promise;
    return { pdf, close: () => task.destroy() };
  } catch (err) {
    task.destroy();
    throw err;
  }
}

async function renderPage(pdf, pageNum, scale) {
  const page = await pdf.getPage(pageNum);
  const viewport = page.getViewport({ scale });
  const canvas = document.createElement('canvas');
  canvas.width = Math.floor(viewport.width);
  canvas.height = Math.floor(viewport.height);
  await page.render({ canvas, viewport, background: 'white' }).promise;
  page.cleanup();
  return canvas;
}

export async function renderPdfThumbnail(file, maxSize = 160) {
  const { pdf, close } = await openPdf(file);
  try {
    const page = await pdf.getPage(1);
    const vp = page.getViewport({ scale: 1 });
    const canvas = await renderPage(pdf, 1, maxSize / Math.max(vp.width, vp.height));
    return canvas.toDataURL('image/png');
  } finally {
    close();
  }
}

async function convertPdf(file, base, target, opts, onProgress) {
  const { pdf, close } = await openPdf(file);
  try {
    const n = pdf.numPages;
    if (target === 'txt') {
      const parts = [];
      for (let p = 1; p <= n; p++) {
        const page = await pdf.getPage(p);
        const content = await page.getTextContent();
        let text = '';
        for (const item of content.items) {
          text += item.str ?? '';
          if (item.hasEOL) text += '\n';
        }
        parts.push(text.trim());
        onProgress(p / n);
      }
      const body = parts.map((t, i) => (n > 1 ? `--- Page ${i + 1} ---\n${t}` : t)).join('\n\n');
      return [{ name: `${base}.txt`, blob: new Blob([body], { type: 'text/plain;charset=utf-8' }) }];
    }

    const pad = String(n).length;
    const out = [];
    for (let p = 1; p <= n; p++) {
      const canvas = await renderPage(pdf, p, opts.pdfScale);
      const blob = await canvasToBlob(canvas, target, opts.quality);
      const name = n === 1 ? `${base}.${target}` : `${base}_page-${String(p).padStart(pad, '0')}.${target}`;
      out.push({ name, blob });
      onProgress(p / n);
    }
    return out;
  } finally {
    close();
  }
}

// ---------------------------------------------------------------------------
// Spreadsheets / JSON
// ---------------------------------------------------------------------------

async function readWorkbook(file) {
  const ext = extOf(file.name);
  // Read text formats as strings so UTF-8 characters survive intact.
  if (ext === 'csv' || ext === 'tsv') {
    return XLSX.read(await file.text(), { type: 'string', FS: ext === 'tsv' ? '\t' : undefined });
  }
  return XLSX.read(await file.arrayBuffer(), { type: 'array', cellDates: true });
}

function jsonToWorkbook(text) {
  let data;
  try {
    data = JSON.parse(text);
  } catch (e) {
    throw new Error('Invalid JSON: ' + e.message);
  }
  const wb = XLSX.utils.book_new();
  const toSheet = (value) => {
    if (Array.isArray(value)) {
      if (value.every(Array.isArray)) return XLSX.utils.aoa_to_sheet(value);
      return XLSX.utils.json_to_sheet(value.map((v) => (v !== null && typeof v === 'object' ? flatten(v) : { value: v })));
    }
    if (value !== null && typeof value === 'object') return XLSX.utils.json_to_sheet([flatten(value)]);
    return XLSX.utils.aoa_to_sheet([[value]]);
  };
  // An object whose values are all arrays becomes one sheet per key.
  if (data && !Array.isArray(data) && typeof data === 'object' && Object.values(data).length && Object.values(data).every(Array.isArray)) {
    for (const [key, value] of Object.entries(data)) {
      XLSX.utils.book_append_sheet(wb, toSheet(value), safeSheetName(key));
    }
  } else {
    XLSX.utils.book_append_sheet(wb, toSheet(data), 'Sheet1');
  }
  return wb;
}

// { a: { b: 1 } } -> { "a.b": 1 } so nested JSON fits into columns.
function flatten(obj, prefix = '', out = {}) {
  for (const [k, v] of Object.entries(obj)) {
    const key = prefix ? `${prefix}.${k}` : k;
    if (v !== null && typeof v === 'object' && !Array.isArray(v) && !(v instanceof Date)) flatten(v, key, out);
    else out[key] = Array.isArray(v) ? JSON.stringify(v) : v;
  }
  return out;
}

function safeSheetName(name) {
  return String(name).replace(/[\\/?*[\]:]/g, '_').slice(0, 31) || 'Sheet';
}

function convertWorkbook(wb, base, target) {
  const sheets = wb.SheetNames.map((name) => ({ name, ws: wb.Sheets[name] }));
  const multi = sheets.length > 1;
  const fileFor = (sheetName, ext) => (multi ? `${base}_${sheetName.replace(/[^\w.-]+/g, '_')}.${ext}` : `${base}.${ext}`);

  switch (target) {
    case 'csv':
    case 'tsv':
      return sheets.map(({ name, ws }) => ({
        name: fileFor(name, target),
        blob: new Blob([XLSX.utils.sheet_to_csv(ws, { FS: target === 'tsv' ? '\t' : ',' })], { type: 'text/csv;charset=utf-8' }),
      }));
    case 'json': {
      const toJson = (ws) => XLSX.utils.sheet_to_json(ws, { defval: null });
      const data = multi ? Object.fromEntries(sheets.map(({ name, ws }) => [name, toJson(ws)])) : toJson(sheets[0].ws);
      return [{ name: `${base}.json`, blob: new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }) }];
    }
    case 'html': {
      const body = sheets
        .map(({ name, ws }) => `${multi ? `<h2>${escapeHtml(name)}</h2>` : ''}${XLSX.utils.sheet_to_html(ws, { header: '', footer: '' })}`)
        .join('\n');
      const html = htmlDocument(base, body, TABLE_CSS);
      return [{ name: `${base}.html`, blob: new Blob([html], { type: 'text/html;charset=utf-8' }) }];
    }
    case 'xlsx':
    case 'ods': {
      const out = XLSX.write(wb, { bookType: target, type: 'array' });
      const type = target === 'xlsx'
        ? 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
        : 'application/vnd.oasis.opendocument.spreadsheet';
      return [{ name: `${base}.${target}`, blob: new Blob([out], { type }) }];
    }
    default:
      throw new Error(`Cannot convert spreadsheet to ${target}`);
  }
}

// ---------------------------------------------------------------------------
// Word / text / HTML
// ---------------------------------------------------------------------------

async function convertDocx(file, base, target) {
  const arrayBuffer = await file.arrayBuffer();
  switch (target) {
    case 'html': {
      const { value } = await mammoth.convertToHtml({ arrayBuffer });
      return { name: `${base}.html`, blob: new Blob([htmlDocument(base, value, DOC_CSS)], { type: 'text/html;charset=utf-8' }) };
    }
    case 'txt': {
      const { value } = await mammoth.extractRawText({ arrayBuffer });
      return { name: `${base}.txt`, blob: new Blob([value], { type: 'text/plain;charset=utf-8' }) };
    }
    case 'md': {
      const { value } = await mammoth.convertToMarkdown({ arrayBuffer });
      return { name: `${base}.md`, blob: new Blob([value], { type: 'text/markdown;charset=utf-8' }) };
    }
    case 'pdf': {
      const { value } = await mammoth.convertToMarkdown({ arrayBuffer });
      return { name: `${base}.pdf`, blob: markdownToPdf(value) };
    }
  }
  throw new Error(`Cannot convert Word document to ${target}`);
}

async function convertText(file, base, target) {
  const text = await file.text();
  const isMd = ['md', 'markdown'].includes(extOf(file.name));
  if (target === 'pdf') {
    return { name: `${base}.pdf`, blob: isMd ? markdownToPdf(text) : plainTextToPdf(text) };
  }
  if (target === 'html') {
    const body = isMd ? marked.parse(text) : `<pre>${escapeHtml(text)}</pre>`;
    return { name: `${base}.html`, blob: new Blob([htmlDocument(base, body, DOC_CSS)], { type: 'text/html;charset=utf-8' }) };
  }
  throw new Error(`Cannot convert text to ${target}`);
}

async function convertHtml(file, base, target) {
  const doc = new DOMParser().parseFromString(await file.text(), 'text/html');
  doc.querySelectorAll('script, style, noscript').forEach((el) => el.remove());
  // Keep block structure as line breaks.
  doc.querySelectorAll('br').forEach((el) => el.replaceWith('\n'));
  doc.querySelectorAll('p, div, li, h1, h2, h3, h4, h5, h6, tr, section, article').forEach((el) => el.append('\n'));
  const text = (doc.body?.textContent || '').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  if (target === 'txt') return { name: `${base}.txt`, blob: new Blob([text], { type: 'text/plain;charset=utf-8' }) };
  if (target === 'pdf') return { name: `${base}.pdf`, blob: plainTextToPdf(text) };
  throw new Error(`Cannot convert HTML to ${target}`);
}

// ---------------------------------------------------------------------------
// Text -> PDF layout (jsPDF)
// ---------------------------------------------------------------------------

function createPdfWriter() {
  const doc = new jsPDF({ unit: 'pt', format: 'a4' });
  const W = doc.internal.pageSize.getWidth();
  const H = doc.internal.pageSize.getHeight();
  const M = 56;
  let y = M;

  const ensure = (h) => {
    if (y + h > H - M) { doc.addPage(); y = M; }
  };

  return {
    doc,
    write(text, { size = 11, style = 'normal', font = 'helvetica', indent = 0, after = 6, prefix = '' } = {}) {
      doc.setFont(font, style);
      doc.setFontSize(size);
      const lh = size * 1.45;
      const lines = doc.splitTextToSize(String(text), W - 2 * M - indent);
      lines.forEach((line, i) => {
        ensure(lh);
        if (i === 0 && prefix) doc.text(prefix, M + indent - 14, y + size);
        doc.text(line, M + indent, y + size);
        y += lh;
      });
      y += after;
    },
    gap(h) { y += h; },
    rule() {
      ensure(12);
      doc.setDrawColor(200);
      doc.line(M, y + 4, W - M, y + 4);
      y += 14;
    },
    blob() { return doc.output('blob'); },
  };
}

function plainTextToPdf(text) {
  const w = createPdfWriter();
  for (const line of text.replace(/\r\n?/g, '\n').split('\n')) {
    if (line.trim() === '') w.gap(8);
    else w.write(line, { after: 0 });
  }
  return w.blob();
}

// Lays out markdown tokens with basic typography (headings, lists, code...).
function markdownToPdf(md) {
  const w = createPdfWriter();
  const inline = (s) => new DOMParser().parseFromString(marked.parseInline(s || ''), 'text/html').body.textContent;
  const HEADING_SIZES = [22, 18, 15, 13, 12, 11];

  const renderTokens = (tokens, indent = 0) => {
    for (const t of tokens) {
      switch (t.type) {
        case 'heading':
          w.gap(6);
          w.write(inline(t.text), { size: HEADING_SIZES[t.depth - 1], style: 'bold', indent, after: 8 });
          break;
        case 'paragraph':
        case 'text':
          w.write(inline(t.text), { indent, after: 8 });
          break;
        case 'list':
          t.items.forEach((item, i) => {
            const prefix = t.ordered ? `${(Number(t.start) || 1) + i}.` : '-';
            const [first, ...rest] = item.tokens;
            const firstText = first && (first.type === 'text' || first.type === 'paragraph') ? inline(first.text) : '';
            w.write(firstText, { indent: indent + 18, prefix, after: 3 });
            renderTokens(firstText ? rest : item.tokens, indent + 18);
          });
          w.gap(5);
          break;
        case 'code':
          w.write(t.text, { font: 'courier', size: 9.5, indent: indent + 8, after: 8 });
          break;
        case 'blockquote':
          w.write(inline(t.text), { style: 'italic', indent: indent + 18, after: 8 });
          break;
        case 'table': {
          const row = (cells) => cells.map((c) => inline(c.text)).join('   |   ');
          w.write(row(t.header), { style: 'bold', indent, after: 2 });
          t.rows.forEach((r) => w.write(row(r), { indent, after: 2 }));
          w.gap(8);
          break;
        }
        case 'hr':
          w.rule();
          break;
        case 'html': {
          const txt = new DOMParser().parseFromString(t.text, 'text/html').body.textContent.trim();
          if (txt) w.write(txt, { indent, after: 8 });
          break;
        }
        default:
          break;
      }
    }
  };

  renderTokens(marked.lexer(md));
  return w.blob();
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const TABLE_CSS = `body{font-family:system-ui,sans-serif;margin:2rem;color:#1f2330}
table{border-collapse:collapse;margin-bottom:2rem}td,th{border:1px solid #d5d8e0;padding:6px 10px}
tr:nth-child(even){background:#f5f6fa}h2{margin-top:2rem}`;

const DOC_CSS = `body{font-family:system-ui,sans-serif;max-width:780px;margin:2rem auto;padding:0 1rem;line-height:1.6;color:#1f2330}
img{max-width:100%}pre,code{background:#f3f4f7;border-radius:4px}pre{padding:1rem;overflow:auto;white-space:pre-wrap}
table{border-collapse:collapse}td,th{border:1px solid #d5d8e0;padding:6px 10px}`;

function htmlDocument(title, body, css) {
  return `<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(title)}</title><style>${css}</style></head>
<body>
${body}
</body></html>`;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

export async function zipFiles(files) {
  const zip = new JSZip();
  const used = new Set();
  for (const { name, blob } of files) {
    let n = name;
    for (let i = 2; used.has(n); i++) n = `${baseName(name)} (${i}).${extOf(name)}`;
    used.add(n);
    zip.file(n, blob);
  }
  return zip.generateAsync({ type: 'blob' });
}
