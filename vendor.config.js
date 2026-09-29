// Browser libraries the app needs, as [path under /vendor, path under node_modules].
// Used by server.js (serves them live) and scripts/build.js (copies them into dist/).
module.exports = [
  ['pdfjs/build/pdf.min.mjs', 'pdfjs-dist/build/pdf.min.mjs'],
  ['pdfjs/build/pdf.worker.min.mjs', 'pdfjs-dist/build/pdf.worker.min.mjs'],
  ['pdfjs/cmaps', 'pdfjs-dist/cmaps'],
  ['pdfjs/standard_fonts', 'pdfjs-dist/standard_fonts'],
  ['pdfjs/wasm', 'pdfjs-dist/wasm'],
  ['pdfjs/iccs', 'pdfjs-dist/iccs'],
  ['xlsx/xlsx.full.min.js', 'xlsx/dist/xlsx.full.min.js'],
  ['jspdf/jspdf.umd.min.js', 'jspdf/dist/jspdf.umd.min.js'],
  ['jszip/jszip.min.js', 'jszip/dist/jszip.min.js'],
  ['mammoth/mammoth.browser.min.js', 'mammoth/mammoth.browser.min.js'],
  ['marked/marked.umd.js', 'marked/lib/marked.umd.js'],
];
