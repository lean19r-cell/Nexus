import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as inst from '../lib/install.mjs';

const APP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('hooks: se añaden sin duplicar y se quitan sin tocar los del usuario', () => {
  const user = { model: 'opus', hooks: { Stop: [{ matcher: '', hooks: [{ type: 'command', command: '~/.claude/mi-hook.sh' }] }] } };
  const once = inst.addHooks(user, '/home/u/.claude/skills/nexus', { autostart: true });
  const twice = inst.addHooks(once, '/home/u/.claude/skills/nexus', { autostart: true });
  assert.deepEqual(twice, once, 'instalar dos veces no duplica');
  assert.equal(once.model, 'opus');
  assert.equal(once.hooks.Stop.length, 2);
  assert.ok(once.hooks.SessionStart[0].hooks[0].command.endsWith('SessionStart --autostart'));
  assert.equal(once.hooks.PostToolUse[0].matcher, 'TaskCreate|TaskUpdate|TodoWrite|ExitPlanMode');
  assert.ok(inst.hasHooks(once));
  const removed = inst.removeHooks(once);
  assert.deepEqual(removed, user);
  assert.equal(inst.hasHooks(removed), false);
  assert.deepEqual(inst.removeHooks({ hooks: { Stop: [{ hooks: [{ type: 'command', command: 'node "C:\\Users\\u\\.claude\\skills\\nexus\\hooks\\emit.mjs" Stop' }] }] } }), {}, 'reconoce rutas de Windows');
});

test('settings.json: copia de seguridad y rechazo de JSON con comentarios', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'nexus-inst-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'settings.json');
  assert.deepEqual(await inst.readSettings(file), {});
  await fs.writeFile(file, '{ "a": 1 }');
  await inst.writeSettings(file, { a: 2 });
  const names = await fs.readdir(dir);
  assert.ok(names.some((n) => n.startsWith('settings.json.nexus-backup-')));
  assert.deepEqual(JSON.parse(await fs.readFile(file, 'utf8')), { a: 2 });
  await fs.writeFile(file, '{ // comentario\n "a": 1 }');
  await assert.rejects(inst.readSettings(file), (err) => err.code === 'EBADJSON');
});

test('skill: instala, actualiza y desinstala solo carpetas de NEXUS', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'nexus-skill-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const dst = path.join(dir, 'skills', 'nexus');
  await inst.installApp(APP, dst);
  for (const entry of ['SKILL.md', 'server.mjs', 'bin/nexus.mjs', 'web/index.html', 'web/js/core.js', 'hooks/emit.mjs', 'lib/shortcut.mjs', 'assets/nexus.icns', 'assets/nexus.ico']) {
    await fs.access(path.join(dst, entry));
  }
  await assert.rejects(fs.access(path.join(dst, 'test')), 'los tests no se copian');
  await inst.installApp(APP, dst); // reinstalar actualiza sin error
  const skill = await fs.readFile(path.join(dst, 'SKILL.md'), 'utf8');
  assert.match(skill, /^---\nname: nexus\ndescription: /);

  const foreign = path.join(dir, 'skills', 'otra');
  await fs.mkdir(foreign, { recursive: true });
  await fs.writeFile(path.join(foreign, 'SKILL.md'), 'x');
  await assert.rejects(inst.installApp(APP, foreign), /no es NEXUS/);
  await assert.rejects(inst.uninstallApp(foreign), /no parece/);

  assert.equal(await inst.uninstallApp(dst), true);
  await assert.rejects(fs.access(dst));
});
