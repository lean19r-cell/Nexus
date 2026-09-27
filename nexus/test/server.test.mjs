import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { startServer } from '../server.mjs';
import { entryFactory, jsonl } from './helpers.mjs';

function request(port, { method = 'GET', path: p = '/', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path: p, headers: { Host: `127.0.0.1:${port}`, ...headers } }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

// Escucha el SSE hasta que llegue un evento que cumpla la condición.
function waitEvent(port, predicate, timeoutMs = 6000) {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port, path: '/api/stream', headers: { Host: `127.0.0.1:${port}` } }, (res) => {
      let buf = '';
      res.on('data', (c) => {
        buf += c.toString('utf8');
        let idx;
        while ((idx = buf.indexOf('\n\n')) >= 0) {
          const block = buf.slice(0, idx);
          buf = buf.slice(idx + 2);
          const ev = /^event: (.+)$/m.exec(block);
          const data = /^data: (.+)$/m.exec(block);
          if (!ev || !data) continue;
          const payload = JSON.parse(data[1]);
          if (predicate(ev[1], payload)) {
            clearTimeout(timer);
            req.destroy();
            resolve(payload);
            return;
          }
        }
      });
    });
    const timer = setTimeout(() => { req.destroy(); reject(new Error('no llegó el evento esperado')); }, timeoutMs);
    req.on('error', () => {});
  });
}

async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'nexus-test-'));
  const claudeDir = path.join(root, 'claude');
  const home = path.join(root, 'home');
  const dir = path.join(claudeDir, 'projects', '-Users-demo-dev-app');
  await fs.mkdir(dir, { recursive: true });
  const f = entryFactory({ sessionId: 'srv1' });
  const file = path.join(dir, 'srv1.jsonl');
  await fs.writeFile(file, jsonl([f.prompt(Date.now() - 60000, 'Primera tanda'), f.assistant(Date.now() - 50000, [f.text('Hecho')], { id: 'r1', stop: 'end_turn' })]));
  return { root, claudeDir, home, file, f };
}

test('servidor: API, seguridad, tiempo real, hooks y configuración', async (t) => {
  const fx = await fixture();
  const srv = await startServer({ port: 0, claudeDir: fx.claudeDir, home: fx.home, quiet: true, pollMs: 150, fullMs: 60000 });
  t.after(async () => {
    await srv.close();
    await fs.rm(fx.root, { recursive: true, force: true });
  });
  const port = srv.opts.port;

  const health = JSON.parse((await request(port, { path: '/api/health' })).text);
  assert.equal(health.name, 'nexus');
  assert.equal(health.ready, true);

  const snap = JSON.parse((await request(port, { path: '/api/snapshot' })).text);
  assert.equal(snap.source, 'server');
  assert.equal(snap.sessions.srv1.runs.length, 1);
  assert.ok(!('_pending' in snap.sessions.srv1), 'no se exponen campos internos');

  const page = await request(port, { path: '/' });
  assert.equal(page.status, 200);
  assert.match(page.text, /NEXUS Mission Control/);
  assert.equal((await request(port, { path: '/js/core.js' })).status, 200);
  assert.equal((await request(port, { path: '/../server.mjs' })).status, 404);

  // Protección contra DNS rebinding y peticiones de otros orígenes.
  assert.equal((await request(port, { path: '/api/snapshot', headers: { Host: 'evil.example:' + port } })).status, 421);
  const cross = await request(port, { method: 'POST', path: '/api/config', headers: { 'Content-Type': 'application/json', Origin: 'https://evil.example' }, body: '{}' });
  assert.equal(cross.status, 403);
  const notJson = await request(port, { method: 'POST', path: '/api/config', headers: { 'Content-Type': 'text/plain' }, body: '{}' });
  assert.equal(notJson.status, 415);

  // Una tanda nueva en la transcripción llega por SSE como delta.
  const deltaP = waitEvent(port, (ev, d) => ev === 'delta' && d.sessions && d.sessions.srv1 && d.sessions.srv1.runs.length === 2);
  await new Promise((r) => setTimeout(r, 100));
  await fs.appendFile(fx.file, jsonl([fx.f.prompt(Date.now(), 'Segunda tanda')]));
  const delta = await deltaP;
  assert.equal(delta.sessions.srv1.runs[1].p, 'Segunda tanda');

  // Un hook de Notification marca la sesión como "te espera" al instante.
  const liveP = waitEvent(port, (ev, d) => ev === 'delta' && d.live && d.live.hooked && d.live.hooked.status === 'waiting');
  await new Promise((r) => setTimeout(r, 100));
  const hook = await request(port, { method: 'POST', path: '/api/hook', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ hook_event_name: 'Notification', session_id: 'hooked', cwd: '/Users/demo/x', message: 'Claude necesita tu permiso para usar Bash' }) });
  assert.equal(hook.status, 200);
  const live = await liveP;
  assert.equal(live.live.hooked.waitingFor, 'Claude necesita tu permiso para usar Bash');

  // La configuración se guarda en disco y el modelo la aplica.
  const cfg = { projects: { '/Users/demo/dev/app': { name: 'Mi app', category: 'video', stage: 'Edición' } } };
  const saved = await request(port, { method: 'POST', path: '/api/config', headers: { 'Content-Type': 'application/json', Origin: `http://127.0.0.1:${port}` }, body: JSON.stringify(cfg) });
  assert.equal(saved.status, 200);
  const onDisk = JSON.parse(await fs.readFile(path.join(fx.home, 'config.json'), 'utf8'));
  assert.equal(onDisk.projects['/Users/demo/dev/app'].stage, 'Edición');
  const model = JSON.parse((await request(port, { path: '/api/model' })).text).model;
  const p = model.projects.find((x) => x.key === '/Users/demo/dev/app');
  assert.equal(p.name, 'Mi app');
  assert.equal(p.category, 'video');
});

test('servidor: la caché permite arrancar sin releer el historial', async (t) => {
  const fx = await fixture();
  t.after(() => fs.rm(fx.root, { recursive: true, force: true }));
  const a = await startServer({ port: 0, claudeDir: fx.claudeDir, home: fx.home, quiet: true });
  await a.close();
  const b = await startServer({ port: 0, claudeDir: fx.claudeDir, home: fx.home, quiet: true });
  try {
    assert.equal(b.collector.meta.bytes, 0, 'todo salió de la caché');
    assert.equal(b.collector.sessions.srv1.runs.length, 1);
  } finally {
    await b.close();
  }
});
