#!/usr/bin/env node
// 依存ゼロの静的サーバ。ローカル確認にも CI にもこれ1本で足りる。
//   node scripts/serve.mjs [--port 8000] [--host 0.0.0.0] [--root .]

import { createServer } from 'node:http';
import { createReadStream, statSync } from 'node:fs';
import { extname, join, normalize, resolve, sep } from 'node:path';

const argv = process.argv.slice(2);
const arg = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
};

const PORT = Number(arg('port', process.env.PORT ?? 8000));
const HOST = arg('host', process.env.HOST ?? '127.0.0.1');
const ROOT = resolve(arg('root', '.'));

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
};

const server = createServer((req, res) => {
  let pathname;
  try {
    pathname = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  } catch {
    res.writeHead(400).end('bad request');
    return;
  }
  if (pathname.endsWith('/')) pathname += 'index.html';

  // ルート外へは出さない
  const target = resolve(join(ROOT, normalize(pathname)));
  if (target !== ROOT && !target.startsWith(ROOT + sep)) {
    res.writeHead(403).end('forbidden');
    return;
  }

  let st;
  try {
    st = statSync(target);
    if (st.isDirectory()) throw new Error('dir');
  } catch {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }).end('404');
    return;
  }

  res.writeHead(200, {
    'content-type': TYPES[extname(target).toLowerCase()] ?? 'application/octet-stream',
    'content-length': st.size,
    'cache-control': 'no-cache',
    // 単一オリジンの静的配信なので、外に出すときの最低限だけ付ける
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
  });
  createReadStream(target).pipe(res);
});

server.listen(PORT, HOST, () => {
  console.log(`serving ${ROOT} on http://${HOST}:${PORT}`);
});

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => server.close(() => process.exit(0)));
}
