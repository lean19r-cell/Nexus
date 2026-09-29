// Ayudas para probar las actualizaciones sin red: un «GitHub» local y carpetas de instalación temporales.
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { blobSha } from '../lib/update.mjs';

export { blobSha };

export const SHA = 'a'.repeat(40);
export const PKG = JSON.stringify({ name: 'claude-nexus', version: '1.0.0' });

// Un «GitHub» local: commit, árbol de archivos y contenido en bruto de un repositorio con la app en nexus/.
export async function fakeGithub(files, { extraTree = [], tamper = {}, statuses = {} } = {}) {
  const buf = (v) => (Buffer.isBuffer(v) ? v : Buffer.from(v));
  const hits = { api: 0, raw: 0 };
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    const p = url.pathname;
    const send = (code, body, type = 'application/json') => { res.writeHead(code, { 'Content-Type': type }); res.end(body); };
    if (statuses[p]) return send(statuses[p], '{}');
    if (p === '/repos/lean19r-cell/Nexus/commits/main') {
      hits.api++;
      return send(200, JSON.stringify({ sha: SHA, commit: { message: 'NEXUS: algo nuevo\n\ncuerpo', committer: { date: '2026-09-29T12:00:00Z' } } }));
    }
    if (p === `/repos/lean19r-cell/Nexus/git/trees/${SHA}`) {
      hits.api++;
      const tree = Object.entries(files).map(([rel, v]) => ({ path: 'nexus/' + rel, type: 'blob', mode: rel === 'bin/nexus.mjs' ? '100755' : '100644', sha: blobSha(buf(v)), size: buf(v).length }));
      tree.push({ path: 'README.md', type: 'blob', mode: '100644', sha: SHA, size: 3 }, { path: 'nexus/docs/captura.jpg', type: 'blob', mode: '100644', sha: SHA, size: 3 }, { path: 'nexus/test/a.test.mjs', type: 'blob', mode: '100644', sha: SHA, size: 3 }, ...extraTree);
      return send(200, JSON.stringify({ sha: SHA, truncated: false, tree }));
    }
    const m = /^\/raw\/lean19r-cell\/Nexus\/([0-9a-f]{40})\/nexus\/(.+)$/.exec(p);
    if (m && m[1] === SHA && Object.hasOwn(files, decodeURIComponent(m[2]))) {
      hits.raw++;
      const rel = decodeURIComponent(m[2]);
      return send(200, tamper[rel] !== undefined ? buf(tamper[rel]) : buf(files[rel]), 'application/octet-stream');
    }
    send(404, '{}');
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${server.address().port}`;
  return { api: url, raw: url + '/raw', hits, close: () => new Promise((r) => { server.closeAllConnections(); server.close(r); }) };
}

export async function tree(dir, files) {
  for (const [rel, v] of Object.entries(files)) {
    const f = path.join(dir, rel);
    await fs.mkdir(path.dirname(f), { recursive: true });
    await fs.writeFile(f, v);
  }
}

export async function workspace(local) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'nexus-upd-'));
  const appDir = path.join(root, 'app');
  await tree(appDir, local);
  return { root, appDir, backupDir: path.join(root, 'home', 'backup', 'app'), home: path.join(root, 'home'), clean: () => fs.rm(root, { recursive: true, force: true }) };
}

export const read = (f) => fs.readFile(f, 'utf8');
