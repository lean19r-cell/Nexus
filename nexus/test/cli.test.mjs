import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { entryFactory, jsonl, core } from './helpers.mjs';

const CLI = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../bin/nexus.mjs');

// Ejecuta el CLI contra un ~/.claude y un ~/.claude-nexus temporales, sin servidor (puerto 1: nadie escucha).
function nexus(claudeDir, home, args) {
  return new Promise((resolve) => {
    execFile(process.execPath, [CLI, ...args, '--claude-dir', claudeDir, '--home', home, '--port', '1'], { env: { ...process.env, NO_COLOR: '1' }, timeout: 30000 }, (err, stdout, stderr) => {
      resolve({ code: err ? err.code : 0, stdout, stderr });
    });
  });
}

async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'nexus-cli-'));
  const claude = path.join(root, 'claude');
  const dir = path.join(claude, 'projects', '-Users-demo-dev-app');
  await fs.mkdir(dir, { recursive: true });
  const now = Date.now();
  const f = entryFactory({ sessionId: 's1', cwd: '/Users/demo/dev/app' });
  const use = (i, o, r, w) => ({ input_tokens: i, output_tokens: o, cache_read_input_tokens: r, cache_creation_input_tokens: w });
  await fs.writeFile(path.join(dir, 's1.jsonl'), jsonl([
    f.prompt(now - 7200000, 'hola'),
    f.assistant(now - 7100000, [f.text('a')], { id: 'a', model: 'claude-opus-5-5', usage: use(1e6, 1e5, 0, 0), stop: 'end_turn' }),
    f.assistant(now - 7000000, [f.text('b')], { id: 'b', model: 'modelo-inventado-1', usage: use(100, 100, 0, 0), stop: 'end_turn' })
  ]));
  return { root, claude, home: path.join(root, 'home') };
}

test('cli: usage --json resume el consumo con coste estimado y filtra por proyecto', async () => {
  const { root, claude, home } = await fixture();
  try {
    const r = await nexus(claude, home, ['usage', '--json']);
    assert.equal(r.code, 0, r.stderr);
    const j = JSON.parse(r.stdout);
    assert.equal(j.estimate, true);
    assert.equal(j.pricesChecked, core.PRICES_CHECKED);
    assert.equal(j.total.tokens, 1.1e6 + 200);
    assert.equal(j.total.unpricedTokens, 200);
    assert.equal(j.total.costUsd, 6, 'opus 5.5: 1M entrada a $4 + 100K salida a $20');
    assert.deepEqual(j.byModel.map((m) => m.name), ['Opus 5.5', 'modelo-inventado-1']);
    assert.equal(j.byProject.length, 1);
    assert.equal(j.byProject[0].project, 'app');

    const one = await nexus(claude, home, ['usage', '--json', '--project', 'app']);
    assert.equal(JSON.parse(one.stdout).total.tokens, j.total.tokens);
    const none = await nexus(claude, home, ['usage', '--project', 'no-existe']);
    assert.equal(none.code, 1);
    assert.match(none.stderr, /No encontré ningún proyecto/);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('cli: tag guarda etapa y fecha objetivo, valida la fecha y permite quitarla', async () => {
  const { root, claude, home } = await fixture();
  try {
    const proj = ['--proyecto', '/Users/demo/youtube/ep-49'];
    const ok = await nexus(claude, home, ['tag', 'video', '--etapa', 'Guion', '--fecha', '2026-10-05', ...proj]);
    assert.equal(ok.code, 0, ok.stderr);
    assert.match(ok.stdout, /etapa Guion · fecha objetivo 2026-10-05/);
    const file = path.join(home, 'config.json');
    let cfg = JSON.parse(await fs.readFile(file, 'utf8'));
    const key = Object.keys(cfg.projects)[0];
    assert.deepEqual(cfg.projects[key], { category: 'video', stage: 'Guion', due: '2026-10-05' });

    const bad = await nexus(claude, home, ['tag', '--fecha', '2026-02-30', ...proj]);
    assert.equal(bad.code, 1);
    assert.match(bad.stderr, /Fecha no válida/);
    cfg = JSON.parse(await fs.readFile(file, 'utf8'));
    assert.equal(cfg.projects[key].due, '2026-10-05', 'una fecha inválida no cambia nada');

    const clear = await nexus(claude, home, ['tag', '--fecha', 'ninguna', ...proj]);
    assert.equal(clear.code, 0, clear.stderr);
    cfg = JSON.parse(await fs.readFile(file, 'utf8'));
    assert.equal(cfg.projects[key].due, undefined);
    assert.equal(cfg.projects[key].stage, 'Guion');
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('cli: usage en texto muestra el coste, los modelos y avisa de los que no tienen precio', async () => {
  const { root, claude, home } = await fixture();
  try {
    const r = await nexus(claude, home, ['usage', '--days', '7']);
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /Consumo · últimos 7 días/);
    assert.match(r.stdout, /\$6,00\*? estimados/);
    assert.match(r.stdout, /Opus 5\.5\s+1,1M\s+\$6,00\s+\$4 \/ \$20 por millón/);
    assert.match(r.stdout, /modelo-inventado-1\s+200\s+—\s+sin precio/);
    assert.match(r.stdout, /\* 200 tokens de modelos sin precio/);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

// Desde un clon de git no se actualiza por la red: se pide usar «git pull». (Si alguien ejecuta las pruebas desde una
// descarga sin .git, este caso no aplica y se omite para no salir a internet.)
const inGitCheckout = fsSync.existsSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../.git'));
test('cli: update no toca un clon de git y explica qué hacer', { skip: !inGitCheckout && 'no es un clon de git' }, async () => {
  const { root, claude, home } = await fixture();
  try {
    const r = await nexus(claude, home, ['update', '--check']);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /git pull/);
    assert.doesNotMatch(r.stdout, /Consultando GitHub/);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
