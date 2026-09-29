// Tiny zero-dependency static server for local use. Binds to 127.0.0.1 by
// default, so nothing is reachable from other machines. All conversions run
// in the browser. For internet hosting, deploy the static build instead
// (npm run build -> dist/).
const http = require('http');
const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');
const VENDOR = require('./vendor.config');

const PUBLIC_DIR = path.join(__dirname, 'public');
const MODULES_DIR = path.join(__dirname, 'node_modules');
const HOST = process.env.HOST || '127.0.0.1';
const START_PORT = Number(process.env.PORT) || 5173;

// URL prefix -> file or directory on disk. Only these paths are ever served.
const MOUNTS = [
  ...VENDOR.map(([dest, src]) => [`/vendor/${dest}`, path.join(MODULES_DIR, src)]),
  ['/', PUBLIC_DIR],
];

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.wasm': 'application/wasm',
  '.bcmap': 'application/octet-stream',
  '.pfb': 'application/octet-stream',
  '.ttf': 'font/ttf',
  '.icc': 'application/octet-stream',
  '.map': 'application/json',
};

function resolvePath(urlPath) {
  for (const [prefix, dir] of MOUNTS) {
    const isDirMount = prefix.endsWith('/') || !path.extname(prefix);
    if (urlPath === prefix && !isDirMount) return dir;
    const dirPrefix = prefix.endsWith('/') ? prefix : `${prefix}/`;
    if (!isDirMount || !urlPath.startsWith(dirPrefix)) continue;
    let rel = urlPath.slice(dirPrefix.length);
    if (rel === '' && prefix === '/') rel = 'index.html';
    const full = path.resolve(dir, rel);
    // Block path traversal outside the mount.
    if (full !== dir && !full.startsWith(dir + path.sep)) return null;
    return full;
  }
  return null;
}

const server = http.createServer((req, res) => {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405).end();
    return;
  }
  let urlPath;
  try {
    urlPath = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
  } catch {
    res.writeHead(400).end();
    return;
  }
  const filePath = resolvePath(urlPath);
  if (!filePath) {
    res.writeHead(404).end('Not found');
    return;
  }
  fs.stat(filePath, (err, stat) => {
    if (err || !stat.isFile()) {
      res.writeHead(404).end('Not found');
      return;
    }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream',
      'Content-Length': stat.size,
      'Cache-Control': 'no-cache',
    });
    if (req.method === 'HEAD') return res.end();
    fs.createReadStream(filePath).pipe(res);
  });
});

function openBrowser(url) {
  const cmd =
    process.platform === 'win32' ? `start "" "${url}"` :
    process.platform === 'darwin' ? `open "${url}"` :
    `xdg-open "${url}"`;
  exec(cmd, () => {});
}

function listen(port, attemptsLeft = 20) {
  server.once('error', (err) => {
    if (err.code === 'EADDRINUSE' && attemptsLeft > 0) return listen(port + 1, attemptsLeft - 1);
    console.error(err);
    process.exit(1);
  });
  server.listen(port, HOST, () => {
    const url = `http://localhost:${port}`;
    console.log(`\n  File Converter running at ${url}`);
    console.log('  Everything is converted locally in your browser. Press Ctrl+C to stop.\n');
    if (!process.argv.includes('--no-open')) openBrowser(url);
  });
}

listen(START_PORT);
