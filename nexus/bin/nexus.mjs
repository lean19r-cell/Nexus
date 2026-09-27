#!/usr/bin/env node
// NEXUS — línea de comandos. Úsala tú o deja que Claude la use a través de la skill /nexus.
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { startServer, openBrowser, parseArgs as parseServerArgs, DEFAULT_PORT, Store } from '../server.mjs';
import { createNodeAdapter, defaultClaudeDir, nexusHome } from '../lib/node-fs.mjs';
import * as inst from '../lib/install.mjs';

const require = createRequire(import.meta.url);
const core = require('../web/js/core.js');

const HERE = path.dirname(fileURLToPath(import.meta.url));
const APP = path.resolve(HERE, '..');
const SERVER = path.join(APP, 'server.mjs');

const HELP = `NEXUS · centro de mando para Claude Code

Uso: node bin/nexus.mjs <comando> [opciones]

Panel
  open                 Arranca el servidor en segundo plano (si hace falta) y abre el panel
  start                Arranca el servidor en primer plano (Ctrl+C para salir)
  stop                 Detiene el servidor en segundo plano
  demo                 Abre el panel con datos de ejemplo

Consultas (sin abrir el navegador)
  status               Resumen: sesiones que te esperan, trabajando, tareas y planes pendientes
  tasks                Tareas abiertas de todos los proyectos
  projects             Lista de proyectos con su categoría, etapa y avance
    --project <texto>  Filtra por nombre o ruta de proyecto
    --json             Salida en JSON (para scripts o para Claude)
    --all              Incluye tareas completadas o abandonadas (tasks)

Organización
  tag <categoría>      Clasifica el proyecto de la carpeta actual:
                       dev | video | contenido | investigacion | ops | otros
    --etapa <nombre>   Etapa (p. ej. Guion, Edición, Publicado, Desarrollo, Deploy)
    --nombre <texto>   Nombre visible en el panel
    --proyecto <ruta>  Otra carpeta de proyecto en lugar de la actual

Instalación
  install              Copia NEXUS a ~/.claude/skills/nexus (skill /nexus)
    --hooks            Añade también los hooks de avisos instantáneos a ~/.claude/settings.json
    --autostart        Con --hooks: arranca el servidor al abrir cualquier sesión de Claude Code
  hooks --print        Muestra el bloque de hooks para pegarlo a mano
  hooks --remove       Quita los hooks de NEXUS de settings.json
  uninstall            Quita la skill y los hooks (tu historial en ~/.claude-nexus se conserva)
  doctor               Diagnóstico de la instalación

Opciones comunes: --port <n> (por defecto ${DEFAULT_PORT}) · --claude-dir <ruta>
`;

// ───────────────────────────────────────────────────────────── utilidades

function parse(argv) {
  const out = { cmd: null, pos: [], flags: {} };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      const key = (eq > 0 ? a.slice(2, eq) : a.slice(2)).toLowerCase();
      if (eq > 0) out.flags[key] = a.slice(eq + 1);
      else if (i + 1 < argv.length && !argv[i + 1].startsWith('--') && VALUE_FLAGS.has(key)) out.flags[key] = argv[++i];
      else out.flags[key] = true;
    } else if (!out.cmd) out.cmd = a;
    else out.pos.push(a);
  }
  return out;
}

const VALUE_FLAGS = new Set(['port', 'claude-dir', 'project', 'proyecto', 'etapa', 'stage', 'nombre', 'name', 'dir', 'home']);

const useColor = process.stdout.isTTY && !process.env.NO_COLOR;
const paint = (code) => (s) => (useColor ? `\x1b[${code}m${s}\x1b[0m` : String(s));
const cyan = paint('96');
const blue = paint('94');
const amber = paint('33');
const mint = paint('92');
const red = paint('91');
const dim = paint('2');
const bold = paint('1');

function claudeDir(flags) {
  return path.resolve(flags['claude-dir'] || defaultClaudeDir());
}

function home(flags) {
  return path.resolve(flags.home || nexusHome());
}

async function readJson(file, fallback) {
  try { return JSON.parse(await fsp.readFile(file, 'utf8')); } catch { return fallback; }
}

async function ping(port) {
  try {
    const r = await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(800) });
    if (!r.ok) return null;
    const j = await r.json();
    return j && j.name === 'nexus' ? j : null;
  } catch {
    return null;
  }
}

async function serverPort(flags) {
  if (flags.port) return Number(flags.port);
  if (process.env.NEXUS_PORT) return Number(process.env.NEXUS_PORT);
  const info = await readJson(path.join(home(flags), 'server.json'), null);
  return info && info.port ? Number(info.port) : DEFAULT_PORT;
}

async function runningServer(flags) {
  const port = await serverPort(flags);
  const h = await ping(port);
  return h ? { port, url: `http://127.0.0.1:${port}/`, health: h } : null;
}

async function ensureServer(flags) {
  const running = await runningServer(flags);
  if (running) return running;
  const port = await serverPort(flags);
  const dir = home(flags);
  await fsp.mkdir(dir, { recursive: true });
  const log = fs.openSync(path.join(dir, 'server.log'), 'a');
  const args = [SERVER, '--port', String(port), '--quiet'];
  if (flags['claude-dir']) args.push('--claude-dir', claudeDir(flags));
  const child = spawn(process.execPath, args, { detached: true, stdio: ['ignore', log, log], windowsHide: true });
  child.unref();
  for (let i = 0; i < 40; i++) {
    await new Promise((r) => setTimeout(r, 250));
    const h = await ping(port);
    if (h) return { port, url: `http://127.0.0.1:${port}/`, health: h, started: true };
  }
  throw new Error(`El servidor no respondió en el puerto ${port}. Revisa ${path.join(dir, 'server.log')}`);
}

// Modelo agregado: del servidor si está en marcha; si no, leyendo ~/.claude directamente.
async function loadModel(flags) {
  const running = await runningServer(flags);
  if (running) {
    try {
      const r = await fetch(running.url + 'api/model', { signal: AbortSignal.timeout(15000) });
      const j = await r.json();
      if (j && j.model) return { model: indexModel(j.model), url: running.url };
    } catch { /* sigue con la lectura directa */ }
  }
  const col = new core.Collector(createNodeAdapter(claudeDir(flags)));
  const store = new Store(home(flags));
  try { await store.load(col); } catch { /* sin caché */ }
  await col.scan({ full: true });
  const cfg = await readJson(path.join(home(flags), 'config.json'), null);
  store.markSessions(Object.keys(col.sessions));
  await store.flush(col).catch(() => {});
  const model = core.buildModel(col.snapshot(), cfg, Date.now());
  return { model, url: null };
}

function indexModel(m) {
  m.sessionMap = {};
  m.projectMap = {};
  m.sessions.forEach((s) => { m.sessionMap[s.id] = s; });
  m.projects.forEach((p) => { m.projectMap[p.key] = p; });
  return m;
}

function matchProject(m, q) {
  if (!q) return null;
  const needle = String(q).toLowerCase();
  const exact = m.projects.filter((p) => p.name.toLowerCase() === needle || (p.path || '').toLowerCase() === needle);
  if (exact.length) return exact;
  return m.projects.filter((p) => p.name.toLowerCase().includes(needle) || (p.path || '').toLowerCase().includes(needle));
}

const ago = (m, t) => core.fmtAgo(t, m.now);
const ICON = { pending: '○', in_progress: '◐', completed: '●', blocked: '◇' };

// ───────────────────────────────────────────────────────────── comandos de consulta

function summarize(m, filterKeys) {
  const inScope = (key) => !filterKeys || filterKeys.has(key);
  const sessions = m.sessions.filter((s) => inScope(s.key));
  const pick = (st) => sessions.filter((s) => s.state === st).map((s) => ({
    id: s.id, project: s.project, title: s.title, origin: s.origin, state: s.state,
    waitingFor: s.state === 'waiting' ? core.waitPhrase(s.waitingFor) : null,
    doing: s.current ? s.current.x : (s.last ? s.last.x : null),
    tasks: s.tasks.total ? `${s.tasks.completed}/${s.tasks.total}` : null,
    updatedAt: s.updatedAt, ago: ago(m, s.updatedAt), cwd: s.cwd
  }));
  const openTasks = m.tasks.filter((t) => inScope(t.key) && t.status !== 'completed' && !t.stale).map((t) => ({
    project: m.projectMap[t.key] ? m.projectMap[t.key].name : t.key, key: t.key, id: t.id, subject: t.subject,
    status: t.blocked ? 'blocked' : t.status, activeForm: t.activeForm, blockedBy: t.blocked ? t.blockedBy : [],
    sessionId: t.sessionId, source: t.source, updatedAt: t.updated
  }));
  const pendingPlans = m.plans.filter((p) => p.status === 'pending' && (!p.key || inScope(p.key))).map((p) => ({
    project: p.key && m.projectMap[p.key] ? m.projectMap[p.key].name : null, title: p.title, sessionId: p.sessionId, t: p.t
  }));
  const projects = m.projects.filter((p) => inScope(p.key)).map((p) => ({
    name: p.name, key: p.key, category: p.category, stage: p.stage, status: p.status,
    sessions: p.sessions.length, open: p.tasks.pending + p.tasks.in_progress, done: p.tasks.completed,
    runs7: p.runs7, tokens: p.tokens, lastActivity: p.lastActivity, ago: ago(m, p.lastActivity)
  }));
  return { waiting: pick('waiting'), working: pick('working'), idle: pick('idle'), openTasks, pendingPlans, projects };
}

function printStatus(m, sum, url, scoped) {
  const k = m.kpis;
  const d = new Date(m.now);
  console.log(bold(cyan('NEXUS')) + dim(' · Claude Code Mission Control · ' + d.toLocaleString('es-ES', { dateStyle: 'medium', timeStyle: 'short' })));
  if (!scoped) {
    const pl = (n, one, many) => `${n} ${n === 1 ? one : many}`;
    console.log(`${cyan(k.working)} trabajando · ${k.waiting ? amber(pl(k.waiting, 'te espera', 'te esperan')) : '0 te esperan'} · ${pl(k.open, 'abierta', 'abiertas')} · ` +
      `${pl(k.tasksOpen, 'tarea abierta', 'tareas abiertas')} · ${mint(pl(k.doneToday, 'completada', 'completadas'))} hoy · ${pl(k.runsToday, 'tanda', 'tandas')} hoy · ${core.fmtTok(k.tokensToday)} tokens hoy`);
  }
  console.log('');
  if (sum.waiting.length) {
    console.log(amber(`⚠ TE ESPERAN (${sum.waiting.length})`));
    sum.waiting.forEach((s) => {
      console.log(`  • ${bold(s.project)} — ${amber(s.waitingFor)}`);
      console.log(dim(`    ${s.title} · ${s.origin} · sesión ${s.id.slice(0, 8)} · ${s.ago}`));
    });
    console.log('');
  }
  if (sum.working.length) {
    console.log(cyan(`▶ TRABAJANDO (${sum.working.length})`));
    sum.working.forEach((s) => {
      console.log(`  • ${bold(s.project)} — ${s.title}`);
      console.log(dim(`    ▸ ${s.doing || '…'}${s.tasks ? ' · tareas ' + s.tasks : ''} · ${s.ago}`));
    });
    console.log('');
  }
  if (sum.idle.length) {
    console.log(blue(`○ ABIERTAS, ESPERANDO NUEVO PROMPT (${sum.idle.length})`));
    sum.idle.forEach((s) => console.log(`  • ${bold(s.project)} — ${s.title} ${dim('· ' + s.ago)}`));
    console.log('');
  }
  if (!sum.waiting.length && !sum.working.length && !sum.idle.length) {
    console.log(dim('No hay sesiones de Claude Code abiertas ahora mismo.'));
    console.log('');
  }
  if (sum.openTasks.length) {
    console.log(bold(`☰ TAREAS ABIERTAS (${sum.openTasks.length})`));
    const groups = new Map();
    sum.openTasks.forEach((t) => { if (!groups.has(t.project)) groups.set(t.project, []); groups.get(t.project).push(t); });
    let shownProjects = 0;
    for (const [project, list] of groups) {
      if (shownProjects++ >= (scoped ? 50 : 8)) break;
      console.log(`  ${bold(project)} ${dim('(' + list.length + ')')}`);
      const order = { in_progress: 0, pending: 1, blocked: 2 };
      list.sort((a, b) => order[a.status] - order[b.status]);
      list.slice(0, scoped ? 100 : 6).forEach((t) => {
        const icon = t.status === 'in_progress' ? cyan(ICON.in_progress) : t.status === 'blocked' ? amber(ICON.blocked) : ICON.pending;
        console.log(`    ${icon} ${t.subject}${t.status === 'blocked' ? dim(' (espera a #' + t.blockedBy.join(', #') + ')') : ''}`);
      });
      if (!scoped && list.length > 6) console.log(dim(`    … y ${list.length - 6} más`));
    }
    if (!scoped && groups.size > 8) console.log(dim(`  … y ${groups.size - 8} proyectos más (nexus tasks)`));
    console.log('');
  }
  if (sum.pendingPlans.length) {
    console.log(amber(`◆ PLANES PENDIENTES DE APROBACIÓN (${sum.pendingPlans.length})`));
    sum.pendingPlans.forEach((p) => console.log(`  • ${bold(p.project || 'sin proyecto')} — ${p.title}`));
    console.log('');
  }
  console.log(dim(url ? `Panel en vivo: ${url}` : 'Panel: node bin/nexus.mjs open'));
}

async function cmdStatus(flags) {
  const { model: m, url } = await loadModel(flags);
  let keys = null;
  if (flags.project || flags.proyecto) {
    const found = matchProject(m, flags.project || flags.proyecto);
    if (!found || !found.length) {
      console.error(`No encontré ningún proyecto que coincida con «${flags.project || flags.proyecto}».`);
      process.exitCode = 1;
      return;
    }
    keys = new Set(found.map((p) => p.key));
  }
  const sum = summarize(m, keys);
  if (flags.json) {
    console.log(JSON.stringify({ generatedAt: m.now, dashboard: url, kpis: m.kpis, ...sum }, null, 2));
    return;
  }
  printStatus(m, sum, url, !!keys);
}

async function cmdTasks(flags) {
  const { model: m } = await loadModel(flags);
  let tasks = m.tasks.filter((t) => flags.all || (t.status !== 'completed' && !t.stale));
  if (flags.project || flags.proyecto) {
    const found = matchProject(m, flags.project || flags.proyecto) || [];
    const keys = new Set(found.map((p) => p.key));
    tasks = tasks.filter((t) => keys.has(t.key));
  }
  if (flags.json) {
    console.log(JSON.stringify(tasks.map((t) => ({ project: m.projectMap[t.key] ? m.projectMap[t.key].name : t.key, id: t.id, subject: t.subject, status: t.blocked ? 'blocked' : t.status, stale: t.stale, source: t.source, sessionId: t.sessionId, updatedAt: t.updated, completedAt: t.completedAt })), null, 2));
    return;
  }
  if (!tasks.length) { console.log('No hay tareas abiertas.'); return; }
  const groups = new Map();
  tasks.forEach((t) => { if (!groups.has(t.key)) groups.set(t.key, []); groups.get(t.key).push(t); });
  for (const [key, list] of groups) {
    const p = m.projectMap[key];
    console.log(bold(p ? p.name : key) + dim(p && p.path ? '  ' + p.path : ''));
    list.forEach((t) => {
      const st = t.blocked ? 'blocked' : t.status;
      const icon = st === 'in_progress' ? cyan(ICON[st]) : st === 'blocked' ? amber(ICON[st]) : st === 'completed' ? mint(ICON[st]) : ICON[st];
      console.log(`  ${icon} ${t.subject}${t.stale ? dim(' · abandonada') : ''}${dim(' · ' + ago(m, t.status === 'completed' ? t.completedAt : t.updated))}`);
    });
  }
}

async function cmdProjects(flags) {
  const { model: m } = await loadModel(flags);
  let list = m.projects;
  if (flags.project || flags.proyecto) list = matchProject(m, flags.project || flags.proyecto) || [];
  if (flags.json) {
    console.log(JSON.stringify(summarize(m, new Set(list.map((p) => p.key))).projects, null, 2));
    return;
  }
  const cat = {};
  core.CATEGORIES.forEach((c) => { cat[c.id] = c; });
  list.forEach((p) => {
    const state = p.status === 'working' ? cyan('● trabajando') : p.status === 'waiting' ? amber('● te espera') : p.status === 'idle' ? blue('● abierto') : dim('○ ' + ago(m, p.lastActivity));
    const open = p.tasks.pending + p.tasks.in_progress;
    console.log(`${bold(p.name.padEnd(28))} ${(cat[p.category] || cat.other).short.padEnd(10)} ${(p.stage || '—').padEnd(14)} ` +
      `${String(p.tasks.completed + '/' + p.tasks.total).padStart(7)} tareas · ${String(open).padStart(3)} abiertas · ${state}`);
  });
}

// ───────────────────────────────────────────────────────────── organización

const CAT_ALIAS = {
  dev: 'dev', desarrollo: 'dev', code: 'dev', codigo: 'dev', 'código': 'dev', app: 'dev',
  video: 'video', 'vídeo': 'video', videos: 'video', youtube: 'video', canal: 'video', yt: 'video',
  content: 'content', contenido: 'content', blog: 'content', newsletter: 'content',
  research: 'research', investigacion: 'research', 'investigación': 'research', invest: 'research',
  ops: 'ops', automatizacion: 'ops', 'automatización': 'ops', infra: 'ops',
  other: 'other', otros: 'other', otro: 'other'
};

async function readConfig(flags, running) {
  if (running) {
    try {
      const r = await fetch(running.url + 'api/config', { signal: AbortSignal.timeout(3000) });
      return core.normalizeConfig(await r.json());
    } catch { /* cae al archivo */ }
  }
  return core.normalizeConfig(await readJson(path.join(home(flags), 'config.json'), null));
}

async function writeConfig(flags, running, cfg) {
  if (running) {
    const r = await fetch(running.url + 'api/config', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(cfg), signal: AbortSignal.timeout(3000) });
    if (!r.ok) throw new Error('El servidor rechazó la configuración (HTTP ' + r.status + ')');
    return;
  }
  const file = path.join(home(flags), 'config.json');
  await fsp.mkdir(path.dirname(file), { recursive: true });
  await fsp.writeFile(file, JSON.stringify(cfg, null, 2));
}

async function cmdTag(flags, pos) {
  const raw = (pos[0] || '').toLowerCase();
  const category = raw ? CAT_ALIAS[raw] : null;
  if (raw && !category) {
    console.error(`Categoría desconocida: «${pos[0]}». Usa: dev, video, contenido, investigacion, ops u otros.`);
    process.exitCode = 1;
    return;
  }
  const running = await runningServer(flags);
  const target = path.resolve(flags.proyecto || flags.project || process.cwd());
  let key = core.projectKeyFromCwd(target);
  if (running) {
    // Si la carpeta actual está dentro de un proyecto conocido, usamos ese proyecto.
    try {
      const r = await fetch(running.url + 'api/model', { signal: AbortSignal.timeout(10000) });
      const { model } = await r.json();
      const cands = model.projects.map((p) => p.key).filter((k) => key === k || key.startsWith(k + '/')).sort((a, b) => b.length - a.length);
      if (cands.length) key = cands[0];
    } catch { /* usamos la carpeta tal cual */ }
  }
  const cfg = await readConfig(flags, running);
  const cur = { ...(cfg.projects[key] || {}) };
  if (category) cur.category = category;
  const stage = flags.etapa || flags.stage;
  if (stage) cur.stage = String(stage);
  const name = flags.nombre || flags.name;
  if (name) cur.name = String(name);
  if (!category && !stage && !name) {
    console.log(`Proyecto: ${key}`);
    console.log(`Actual: ${JSON.stringify(cur)}`);
    console.log('Indica una categoría, --etapa o --nombre para cambiarlo.');
    return;
  }
  cfg.projects[key] = cur;
  await writeConfig(flags, running, cfg);
  const catLabel = core.CATEGORIES.find((c) => c.id === cur.category);
  console.log(`${mint('✓')} ${bold(cur.name || core.baseName(key))} → ${catLabel ? catLabel.label : 'categoría automática'}${cur.stage ? ' · etapa ' + cur.stage : ''}`);
  console.log(dim(`  ${key}`));
}

// ───────────────────────────────────────────────────────────── instalación

function skillDir(flags) {
  if (flags.dir) return path.resolve(flags.dir);
  return path.join(claudeDir(flags), 'skills', 'nexus');
}

function settingsFile(flags) {
  return path.join(claudeDir(flags), 'settings.json');
}

async function cmdInstall(flags) {
  const dst = skillDir(flags);
  const res = await inst.installApp(APP, dst);
  console.log(`${mint('✓')} Skill instalada en ${dst}${res.copied ? '' : dim(' (ya estaba ahí)')}`);
  if (flags.hooks) {
    const file = settingsFile(flags);
    const settings = await inst.readSettings(file);
    await inst.writeSettings(file, inst.addHooks(settings, dst, { autostart: !!flags.autostart }));
    console.log(`${mint('✓')} Hooks añadidos a ${file}${flags.autostart ? ' (con arranque automático del servidor)' : ''}`);
    console.log(dim('  Se guardó una copia de seguridad junto al archivo.'));
  }
  console.log('');
  console.log('Siguiente paso:');
  console.log(`  1. Reinicia Claude Code (o Claude Desktop) para que cargue la skill.`);
  console.log(`  2. Escribe ${cyan('/nexus')} o pídele «abre el centro de mando» / «¿qué tengo pendiente?».`);
  console.log(`  3. O abre el panel tú mismo: ${cyan('node "' + path.join(dst, 'bin', 'nexus.mjs') + '" open')}`);
  if (!flags.hooks) console.log(dim('  Opcional: node bin/nexus.mjs install --hooks  → avisos instantáneos al panel.'));
}

async function cmdHooks(flags) {
  const dst = skillDir(flags);
  const appDir = fs.existsSync(path.join(dst, 'hooks', 'emit.mjs')) ? dst : APP;
  if (flags.print) {
    console.log(JSON.stringify(inst.addHooks({}, appDir, { autostart: !!flags.autostart }), null, 2));
    return;
  }
  const file = settingsFile(flags);
  const settings = await inst.readSettings(file);
  if (flags.remove) {
    if (!inst.hasHooks(settings)) { console.log('No había hooks de NEXUS en ' + file); return; }
    await inst.writeSettings(file, inst.removeHooks(settings));
    console.log(`${mint('✓')} Hooks de NEXUS quitados de ${file}`);
    return;
  }
  await inst.writeSettings(file, inst.addHooks(settings, appDir, { autostart: !!flags.autostart }));
  console.log(`${mint('✓')} Hooks de NEXUS añadidos a ${file}`);
}

async function cmdUninstall(flags) {
  const file = settingsFile(flags);
  try {
    const settings = await inst.readSettings(file);
    if (inst.hasHooks(settings)) {
      await inst.writeSettings(file, inst.removeHooks(settings));
      console.log(`${mint('✓')} Hooks quitados de ${file}`);
    }
  } catch (err) {
    console.log(amber('! ') + err.message);
  }
  const dst = skillDir(flags);
  if (path.resolve(dst) === APP) {
    console.log(amber('! ') + 'Estás ejecutando NEXUS desde la carpeta de la skill; bórrala a mano cuando termines: ' + dst);
  } else if (await inst.uninstallApp(dst)) {
    console.log(`${mint('✓')} Skill quitada de ${dst}`);
  }
  console.log(dim(`Tu historial y ajustes siguen en ${home(flags)} (bórralo si ya no lo quieres).`));
}

async function cmdDoctor(flags) {
  const ok = (s) => console.log(`${mint('✓')} ${s}`);
  const warn = (s) => console.log(`${amber('!')} ${s}`);
  const [maj] = process.versions.node.split('.').map(Number);
  if (maj >= 18) ok(`Node ${process.versions.node}`); else warn(`Node ${process.versions.node}: NEXUS necesita Node 18 o superior`);
  const cd = claudeDir(flags);
  if (!fs.existsSync(cd)) { warn(`No existe ${cd}. ¿Usas CLAUDE_CONFIG_DIR? Pasa --claude-dir <ruta>.`); return; }
  ok(`Carpeta de Claude Code: ${cd}`);
  const count = async (rel, filter) => {
    try { return (await fsp.readdir(path.join(cd, rel), { withFileTypes: true })).filter(filter).length; } catch { return 0; }
  };
  const projDirs = await count('projects', (e) => e.isDirectory());
  let transcripts = 0;
  try {
    for (const d of await fsp.readdir(path.join(cd, 'projects'))) {
      try { transcripts += (await fsp.readdir(path.join(cd, 'projects', d))).filter((n) => n.endsWith('.jsonl')).length; } catch { /* no es carpeta */ }
    }
  } catch { /* sin proyectos */ }
  (transcripts ? ok : warn)(`${projDirs} carpetas de proyecto · ${transcripts} transcripciones`);
  ok(`${await count('sessions', (e) => e.name.endsWith('.json'))} sesiones vivas en el registro · ${await count('tasks', (e) => e.isDirectory())} listas de tareas · ${await count('plans', (e) => e.name.endsWith('.md'))} planes`);
  const settings = await inst.readSettings(settingsFile(flags)).catch(() => null);
  const cleanup = settings && settings.cleanupPeriodDays;
  console.log(dim(`  Claude Code borra transcripciones tras ${cleanup || 30} días; NEXUS conserva su resumen en ${home(flags)}.`));
  const running = await runningServer(flags);
  if (running) ok(`Servidor en marcha: ${running.url} (PID ${running.health.pid}, ${running.health.ready ? 'listo' : 'leyendo historial'})`);
  else warn('Servidor detenido. Arráncalo con: node bin/nexus.mjs open');
  const sd = skillDir(flags);
  if (fs.existsSync(path.join(sd, 'SKILL.md'))) ok(`Skill /nexus instalada en ${sd}`);
  else warn('Skill no instalada. Instálala con: node bin/nexus.mjs install');
  if (settings && inst.hasHooks(settings)) ok('Hooks de avisos instantáneos activos');
  else console.log(dim('  Hooks no instalados (opcionales): node bin/nexus.mjs install --hooks'));
}

// ───────────────────────────────────────────────────────────── principal

async function main() {
  const { cmd, pos, flags } = parse(process.argv.slice(2));
  switch (cmd) {
    case undefined:
    case null:
    case 'help':
    case '--help':
      console.log(HELP);
      return;
    case 'start': {
      const srv = await startServer({ ...parseServerArgs(process.argv.slice(3)), claudeDir: flags['claude-dir'] });
      const stop = async () => { await srv.close(); process.exit(0); };
      process.on('SIGINT', stop);
      process.on('SIGTERM', stop);
      return;
    }
    case 'open':
    case 'up':
    case 'demo': {
      const srv = await ensureServer(flags);
      const url = srv.url + (cmd === 'demo' ? '?demo' : '');
      if (!flags['no-browser']) openBrowser(url);
      console.log(`${cyan('NEXUS')} ${srv.started ? 'arrancado' : 'ya estaba en marcha'} → ${url}`);
      return;
    }
    case 'stop': {
      const info = await readJson(path.join(home(flags), 'server.json'), null);
      const running = await runningServer(flags);
      const pid = running ? running.health.pid : info && info.pid;
      if (!pid || !running) { console.log('NEXUS no está en marcha.'); return; }
      process.kill(pid, 'SIGTERM');
      console.log(`${mint('✓')} Servidor detenido (PID ${pid}).`);
      return;
    }
    case 'status': return cmdStatus(flags);
    case 'tasks': case 'tareas': return cmdTasks(flags);
    case 'projects': case 'proyectos': return cmdProjects(flags);
    case 'tag': case 'categoria': return cmdTag(flags, pos);
    case 'install': return cmdInstall(flags);
    case 'hooks': return cmdHooks(flags);
    case 'uninstall': return cmdUninstall(flags);
    case 'doctor': return cmdDoctor(flags);
    default:
      console.error(`Comando desconocido: ${cmd}\n`);
      console.log(HELP);
      process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error(red('✕ ') + (err && err.message ? err.message : String(err)));
  process.exitCode = 1;
});
