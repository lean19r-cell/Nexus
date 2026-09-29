import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import { checkForUpdate, applyUpdate, fetchLatest, selfUpdateSupport, createUpdater, UpdateError } from '../lib/update.mjs';
import { SHA, PKG, fakeGithub, tree, workspace, read, blobSha } from './gh-helpers.mjs';

test('actualización: una copia idéntica con saltos de línea CRLF (Windows) no cuenta como cambio', async () => {
  const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 1, 2]); // contiene CR: no debe normalizarse
  const remote = { 'package.json': PKG, 'server.mjs': 'a\nb\n', 'web/index.html': '<p>hola</p>\n', 'assets/nexus.png': png };
  const gh = await fakeGithub(remote);
  const ws = await workspace({ 'package.json': PKG, 'server.mjs': 'a\r\nb\r\n', 'web/index.html': '<p>hola</p>\r\n', 'assets/nexus.png': png });
  try {
    const r = await checkForUpdate({ appDir: ws.appDir, api: gh.api });
    assert.equal(r.available, false, JSON.stringify(r.diff));
    assert.equal(r.latest.sha, SHA);
    assert.equal(r.latest.message, 'NEXUS: algo nuevo');
    assert.equal(r.latest.files.length, 4, 'docs, test y lo de fuera de nexus/ no forman parte de la app');
  } finally {
    await gh.close();
    await ws.clean();
  }
});

test('actualización: detecta cambiados, añadidos y quitados, los instala con copia de seguridad y luego queda al día', async () => {
  const remote = { 'package.json': PKG, 'server.mjs': 'nuevo\n', 'bin/nexus.mjs': '#!/usr/bin/env node\nnuevo\n', 'web/js/nuevo.js': 'export {}\n', 'web/index.html': 'igual\n' };
  const gh = await fakeGithub(remote);
  const ws = await workspace({ 'package.json': PKG, 'server.mjs': 'viejo\n', 'lib/vieja.mjs': 'vieja\n', 'web/index.html': 'igual\n' });
  try {
    const r = await checkForUpdate({ appDir: ws.appDir, api: gh.api });
    assert.equal(r.available, true);
    assert.deepEqual(r.diff.changed.map((f) => f.path), ['server.mjs']);
    assert.deepEqual(r.diff.added.map((f) => f.path).sort(), ['bin/nexus.mjs', 'web/js/nuevo.js']);
    assert.deepEqual(r.diff.removed, ['lib/vieja.mjs']);

    const res = await applyUpdate({ appDir: ws.appDir, latest: r.latest, diff: r.diff, backupDir: ws.backupDir, api: gh.api, raw: gh.raw });
    assert.deepEqual([res.changed, res.added, res.removed], [1, 2, 1]);
    assert.equal(await read(path.join(ws.appDir, 'server.mjs')), 'nuevo\n');
    assert.equal(await read(path.join(ws.appDir, 'web/js/nuevo.js')), 'export {}\n');
    assert.equal(fsSync.existsSync(path.join(ws.appDir, 'lib')), false, 'la carpeta que quedó vacía se quita');
    if (process.platform !== 'win32') assert.ok(fsSync.statSync(path.join(ws.appDir, 'bin/nexus.mjs')).mode & 0o111, 'conserva el permiso de ejecución');
    assert.equal(await read(path.join(ws.backupDir, 'server.mjs')), 'viejo\n');
    assert.equal(await read(path.join(ws.backupDir, 'lib/vieja.mjs')), 'vieja\n');
    assert.equal(gh.hits.raw, 3, 'solo se descarga lo que cambia');
    assert.equal(fsSync.readdirSync(path.join(ws.appDir, 'web')).some((n) => n.endsWith('.nexus-new')), false);

    assert.equal((await checkForUpdate({ appDir: ws.appDir, api: gh.api })).available, false);
  } finally {
    await gh.close();
    await ws.clean();
  }
});

test('actualización: un archivo alterado en la descarga no se instala y no se toca nada', async () => {
  const remote = { 'package.json': PKG, 'server.mjs': 'nuevo\n', 'web/a.js': 'a\n', 'web/b.js': 'b\n' };
  const gh = await fakeGithub(remote, { tamper: { 'web/b.js': 'código malicioso\n' } });
  const ws = await workspace({ 'package.json': PKG, 'server.mjs': 'viejo\n' });
  try {
    const r = await checkForUpdate({ appDir: ws.appDir, api: gh.api });
    await assert.rejects(applyUpdate({ appDir: ws.appDir, latest: r.latest, diff: r.diff, backupDir: ws.backupDir, api: gh.api, raw: gh.raw }), (e) => e instanceof UpdateError && e.code === 'verify' && /web\/b\.js/.test(e.message));
    assert.equal(await read(path.join(ws.appDir, 'server.mjs')), 'viejo\n');
    assert.equal(fsSync.existsSync(path.join(ws.appDir, 'web')), false);
  } finally {
    await gh.close();
    await ws.clean();
  }
});

test('actualización: si falla a mitad de la instalación se restaura la versión anterior', async () => {
  const remote = { 'package.json': PKG, 'server.mjs': 'nuevo\n', 'web/x.js': 'x\n' };
  const gh = await fakeGithub(remote);
  const ws = await workspace({ 'package.json': PKG, 'server.mjs': 'viejo\n' });
  try {
    await fs.mkdir(path.join(ws.appDir, 'web', 'x.js'), { recursive: true }); // un directorio donde debe ir un archivo
    const r = await checkForUpdate({ appDir: ws.appDir, api: gh.api });
    await assert.rejects(applyUpdate({ appDir: ws.appDir, latest: r.latest, diff: r.diff, backupDir: ws.backupDir, api: gh.api, raw: gh.raw }), (e) => e.code === 'apply' && /Se restauró/.test(e.message));
    assert.equal(await read(path.join(ws.appDir, 'server.mjs')), 'viejo\n', 'el archivo que ya se había cambiado vuelve a su versión');
    assert.equal(fsSync.readdirSync(ws.appDir).concat(fsSync.readdirSync(path.join(ws.appDir, 'web'))).some((n) => n.endsWith('.nexus-new')), false, 'sin temporales sueltos');
  } finally {
    await gh.close();
    await ws.clean();
  }
});

test('actualización: rechaza rutas peligrosas, listados incompletos y repositorios que no son NEXUS', async () => {
  const base = { 'package.json': PKG, 'server.mjs': 'x\n' };
  for (const [bad, code] of [['../fuera.js', 'unsafe'], ['web/..\\x.js', 'unsafe'], ['/abs.js', 'unsafe']]) {
    const gh = await fakeGithub(base, { extraTree: [{ path: 'nexus/' + bad, type: 'blob', mode: '100644', sha: SHA, size: 1 }] });
    try {
      await assert.rejects(fetchLatest({ api: gh.api }), (e) => e.code === code, bad);
    } finally { await gh.close(); }
  }
  const ghSym = await fakeGithub(base, { extraTree: [{ path: 'nexus/web/enlace', type: 'blob', mode: '120000', sha: SHA, size: 1 }] });
  try {
    assert.equal((await fetchLatest({ api: ghSym.api })).files.some((f) => f.path === 'web/enlace'), false, 'los enlaces simbólicos se ignoran');
  } finally { await ghSym.close(); }
  const ghOther = await fakeGithub({ 'leeme.txt': 'no soy nexus' });
  try {
    await assert.rejects(fetchLatest({ api: ghOther.api }), (e) => e.code === 'badresponse');
  } finally { await ghOther.close(); }
});

test('actualización: errores de red y de GitHub con mensajes claros', async () => {
  const gh = await fakeGithub({ 'package.json': PKG, 'server.mjs': 'x' }, { statuses: { '/repos/lean19r-cell/Nexus/commits/main': 403 } });
  try {
    await assert.rejects(fetchLatest({ api: gh.api }), (e) => e.code === 'ratelimit' && /limitó/.test(e.message));
  } finally { await gh.close(); }
  const gh404 = await fakeGithub({}, { statuses: { '/repos/lean19r-cell/Nexus/commits/main': 404 } });
  try {
    await assert.rejects(fetchLatest({ api: gh404.api }), (e) => e.code === 'notfound');
  } finally { await gh404.close(); }
  const closed = await fakeGithub({});
  const dead = closed.api;
  await closed.close();
  await assert.rejects(fetchLatest({ api: dead }), (e) => e.code === 'offline' && /conexión/.test(e.message));
});

test('actualización: no se toca un clon de git, una carpeta que no es NEXUS ni una que no se puede escribir', async () => {
  const ws = await workspace({ 'package.json': PKG });
  try {
    assert.equal(selfUpdateSupport(ws.appDir).ok, true);
    await fs.mkdir(path.join(ws.root, '.git')); // la app dentro de un clon: repo/nexus
    const g = selfUpdateSupport(ws.appDir);
    assert.deepEqual([g.ok, g.reason], [false, 'git']);
    assert.match(g.message, /git pull/);
    await fs.rm(path.join(ws.root, '.git'), { recursive: true });
    await fs.writeFile(path.join(ws.appDir, 'package.json'), JSON.stringify({ name: 'otra-cosa' }));
    assert.equal(selfUpdateSupport(ws.appDir).reason, 'notnexus');
    await assert.rejects(applyUpdate({ appDir: ws.appDir, latest: { sha: SHA }, diff: { changed: [], added: [], removed: [] }, backupDir: ws.backupDir }), (e) => e.code === 'notnexus');
  } finally {
    await ws.clean();
  }
});

test('actualizador: comprueba, instala y pide reiniciar; la instalación automática no se repite con la misma versión', async () => {
  const remote = { 'package.json': PKG, 'server.mjs': 'nuevo\n' };
  const gh = await fakeGithub(remote);
  const ws = await workspace({ 'package.json': PKG, 'server.mjs': 'viejo\n' });
  const seen = [];
  let settings = { check: true, install: false };
  let restarts = 0;
  try {
    const up = createUpdater({ appDir: ws.appDir, home: ws.home, api: gh.api, raw: gh.raw, getSettings: () => settings, onChange: (s) => seen.push(s), restart: async () => { restarts++; } });
    assert.equal(up.state().available, false);
    assert.equal(up.state().supported, true);

    let s = await up.check();
    assert.equal(s.available, true);
    assert.deepEqual(s.changes, { changed: 1, added: 0, removed: 0 });
    assert.equal(s.latest.sha, SHA);
    assert.ok(seen.some((x) => x.checking) && seen.at(-1).checking === false, 'avisa del cambio de estado');
    assert.equal(await read(path.join(ws.appDir, 'server.mjs')), 'viejo\n', 'comprobar no instala');

    // Sin instalación automática: tick solo comprueba.
    await up.tick();
    assert.equal(restarts, 0);
    assert.equal(await read(path.join(ws.appDir, 'server.mjs')), 'viejo\n');

    s = await up.install();
    assert.equal(s.error, null);
    assert.equal(s.needsRestart, true);
    assert.equal(s.available, false);
    assert.equal(s.installed.sha, SHA);
    assert.equal(await read(path.join(ws.appDir, 'server.mjs')), 'nuevo\n');

    // Otra versión en el repositorio + instalación automática: instala y reinicia, una sola vez por versión.
    await fs.writeFile(path.join(ws.appDir, 'server.mjs'), 'viejo otra vez\n');
    const up2 = createUpdater({ appDir: ws.appDir, home: ws.home, api: gh.api, raw: gh.raw, getSettings: () => settings, restart: async () => { restarts++; } });
    settings = { check: true, install: true };
    await up2.tick();
    assert.equal(restarts, 1);
    assert.equal(await read(path.join(ws.appDir, 'server.mjs')), 'nuevo\n');
    await fs.writeFile(path.join(ws.appDir, 'server.mjs'), 'estropeado\n');
    const up3 = createUpdater({ appDir: ws.appDir, home: ws.home, api: gh.api, raw: gh.raw, getSettings: () => settings, restart: async () => { restarts++; } });
    await up3.tick();
    assert.equal(restarts, 1, 'la misma versión no se instala sola dos veces');
    assert.equal(up3.state().available, true, 'pero sigue avisando de que hay una actualización');

    // Comprobación desactivada: no toca la red.
    const before = gh.hits.api;
    settings = { check: false, install: true };
    await up3.tick();
    assert.equal(gh.hits.api, before);
  } finally {
    await gh.close();
    await ws.clean();
  }
});

test('actualizador: en una carpeta no actualizable no consulta la red y explica por qué', async () => {
  const gh = await fakeGithub({ 'package.json': PKG, 'server.mjs': 'x' });
  const ws = await workspace({ 'package.json': PKG });
  try {
    await fs.mkdir(path.join(ws.root, '.git'));
    const up = createUpdater({ appDir: ws.appDir, home: ws.home, api: gh.api, raw: gh.raw });
    const s = await up.check();
    assert.equal(s.supported, false);
    assert.equal(s.reason, 'git');
    assert.equal(gh.hits.api, 0);
    const i = await up.install();
    assert.match(i.error, /git pull/);
    up.start();
    up.stop();
  } finally {
    await gh.close();
    await ws.clean();
  }
});
