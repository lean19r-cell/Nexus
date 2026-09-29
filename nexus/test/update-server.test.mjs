import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { startServer } from '../server.mjs';
import { request, waitEvent } from './http-helpers.mjs';
import { SHA, PKG, fakeGithub, workspace, read } from './gh-helpers.mjs';

const post = (port, p, body = {}, headers = {}) => request(port, { method: 'POST', path: p, headers: { 'Content-Type': 'application/json', Origin: `http://127.0.0.1:${port}`, ...headers }, body: JSON.stringify(body) });

async function setup(t, { local, remote, settings } = {}) {
  const gh = await fakeGithub(remote || { 'package.json': PKG, 'server.mjs': 'nuevo\n', 'web/index.html': 'nuevo\n' });
  const ws = await workspace(local || { 'package.json': PKG, 'server.mjs': 'viejo\n', 'web/index.html': 'viejo\n' });
  const claudeDir = path.join(ws.root, 'claude');
  await fs.mkdir(claudeDir, { recursive: true });
  if (settings) await fs.mkdir(ws.home, { recursive: true }).then(() => fs.writeFile(path.join(ws.home, 'config.json'), JSON.stringify(settings)));
  const restarts = [];
  const srv = await startServer({
    port: 0, claudeDir, home: ws.home, quiet: true, cache: false, appDir: ws.appDir,
    update: { api: gh.api, raw: gh.raw, firstDelayMs: 60 * 60 * 1000 },
    restart: async (o) => { restarts.push({ port: o.port, home: o.home }); }
  });
  t.after(async () => {
    await srv.close();
    await gh.close();
    await ws.clean();
  });
  return { gh, ws, srv, port: srv.opts.port, restarts };
}

test('servidor: expone el estado de actualización, avisa en directo y solo acepta órdenes del propio panel', async (t) => {
  const { srv, port, ws } = await setup(t);

  const state = JSON.parse((await request(port, { path: '/api/update' })).text);
  assert.equal(state.supported, true);
  assert.equal(state.available, false, 'aún no se ha comprobado');
  assert.deepEqual(state.settings, { check: true, install: false });
  const snap = JSON.parse((await request(port, { path: '/api/snapshot' })).text);
  assert.equal(snap.update.supported, true);
  assert.match(snap.server.boot, /^\d+-\d+$/);

  // Seguridad: mismo trato que el resto de órdenes (origen propio y JSON).
  assert.equal((await post(port, '/api/update/install', {}, { Origin: 'https://evil.example' })).status, 403);
  assert.equal((await request(port, { method: 'POST', path: '/api/update/check', headers: { 'Content-Type': 'text/plain' }, body: '{}' })).status, 415);
  assert.equal((await request(port, { method: 'POST', path: '/api/restart', headers: { 'Content-Type': 'application/json', Origin: 'https://evil.example' }, body: '{}' })).status, 403);
  assert.equal((await request(port, { path: '/api/update/install' })).status, 404, 'instalar no se puede pedir con GET');
  assert.equal(await read(path.join(ws.appDir, 'server.mjs')), 'viejo\n', 'nada de lo anterior tocó la instalación');

  // Comprobar avisa por SSE al resto de pestañas.
  const seen = waitEvent(port, (ev, d) => ev === 'update' && d.available === true);
  await new Promise((r) => setTimeout(r, 100));
  const checked = JSON.parse((await post(port, '/api/update/check')).text);
  assert.equal(checked.available, true);
  assert.deepEqual(checked.changes, { changed: 2, added: 0, removed: 0 });
  assert.equal(checked.latest.sha, SHA);
  assert.equal((await seen).latest.message, 'NEXUS: algo nuevo');
  assert.equal(srv.updater.state().available, true);
});

test('servidor: instala la actualización, pide reiniciar y reinicia con los mismos datos', async (t) => {
  const { port, ws, restarts } = await setup(t);
  await post(port, '/api/update/check');
  const done = waitEvent(port, (ev, d) => ev === 'update' && d.needsRestart === true);
  await new Promise((r) => setTimeout(r, 100));
  const res = JSON.parse((await post(port, '/api/update/install')).text);
  assert.equal(res.error, null);
  assert.equal(res.needsRestart, true);
  assert.equal(res.available, false);
  assert.equal(res.installed.sha, SHA);
  assert.equal((await done).needsRestart, true);
  assert.equal(await read(path.join(ws.appDir, 'server.mjs')), 'nuevo\n');
  assert.equal(await read(path.join(ws.appDir, 'web/index.html')), 'nuevo\n');
  assert.equal(await read(path.join(ws.backupDir, 'server.mjs')), 'viejo\n', 'guarda la versión anterior');

  assert.equal(restarts.length, 0, 'instalar no reinicia por sí solo');
  const r = await post(port, '/api/restart');
  assert.equal(r.status, 200);
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.deepEqual(restarts, [{ port, home: ws.home }]);
});

test('servidor: los interruptores de Ajustes cambian la comprobación y la instalación automáticas', async (t) => {
  const { port } = await setup(t);
  const saved = await post(port, '/api/config', { ui: { updateCheck: false, autoUpdate: true } });
  assert.equal(saved.status, 200);
  const state = JSON.parse((await request(port, { path: '/api/update' })).text);
  assert.deepEqual(state.settings, { check: false, install: true });
});

test('servidor: con la instalación automática activada actualiza y reinicia solo, una vez por versión', async (t) => {
  const { srv, ws, restarts, gh } = await setup(t, { settings: { ui: { autoUpdate: true } } });
  await srv.updater.tick();
  assert.equal(await read(path.join(ws.appDir, 'server.mjs')), 'nuevo\n');
  assert.equal(restarts.length, 1);
  assert.equal(srv.updater.state().needsRestart, true);
  assert.ok(gh.hits.raw > 0);
});

test('servidor: desde un clon de git no ofrece actualizar y explica por qué', async (t) => {
  const gh = await fakeGithub({ 'package.json': PKG, 'server.mjs': 'x' });
  const ws = await workspace({ 'package.json': PKG });
  await fs.mkdir(path.join(ws.root, '.git'));
  const claudeDir = path.join(ws.root, 'claude');
  await fs.mkdir(claudeDir, { recursive: true });
  const srv = await startServer({ port: 0, claudeDir, home: ws.home, quiet: true, cache: false, appDir: ws.appDir, update: { api: gh.api, raw: gh.raw } });
  t.after(async () => { await srv.close(); await gh.close(); await ws.clean(); });
  const port = srv.opts.port;
  const state = JSON.parse((await post(port, '/api/update/check')).text);
  assert.equal(state.supported, false);
  assert.equal(state.reason, 'git');
  assert.match(state.message, /git pull/);
  const inst = JSON.parse((await post(port, '/api/update/install')).text);
  assert.match(inst.error, /git pull/);
  assert.equal(gh.hits.api, 0, 'ni siquiera consulta la red');
});
