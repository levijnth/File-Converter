// Produces a fully static site in dist/ that any static host can serve
// (GitHub Pages, Netlify, Vercel, Cloudflare Pages...). No server code needed:
// every conversion runs in the visitor's browser.
const fs = require('fs');
const path = require('path');
const VENDOR = require('../vendor.config');

const ROOT = path.join(__dirname, '..');
const DIST = path.join(ROOT, 'dist');

fs.rmSync(DIST, { recursive: true, force: true });
fs.cpSync(path.join(ROOT, 'public'), DIST, { recursive: true });

for (const [dest, src] of VENDOR) {
  const from = path.join(ROOT, 'node_modules', src);
  if (!fs.existsSync(from)) {
    console.error(`Missing ${from}. Run "npm install" first.`);
    process.exit(1);
  }
  fs.cpSync(from, path.join(DIST, 'vendor', dest), {
    recursive: true,
    filter: (p) => !p.endsWith('.map'),
  });
}

// Stops GitHub Pages from running the output through Jekyll.
fs.writeFileSync(path.join(DIST, '.nojekyll'), '');

const size = (dir) => fs.readdirSync(dir, { withFileTypes: true })
  .reduce((n, e) => n + (e.isDirectory() ? size(path.join(dir, e.name)) : fs.statSync(path.join(dir, e.name)).size), 0);
console.log(`Built dist/ (${(size(DIST) / 1024 / 1024).toFixed(1)} MB)`);
