// Actualización de NEXUS desde GitHub, sin git ni dependencias.
//
// Comprueba qué archivos cambiaron respecto a la última versión de la rama principal, descarga solo esos,
// verifica cada uno contra el hash que publica GitHub e instala con copia de seguridad y reversión.
//
// Seguridad: la fuente es fija (SOURCE), la descarga se ancla a la SHA exacta del commit que se comprobó y ningún
// archivo se escribe si su hash no coincide. Las URL base solo se pueden cambiar por código (pruebas), nunca por
// configuración ni variables de entorno.
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { APP_ENTRIES, isNexusDir } from './install.mjs';

export const SOURCE = { owner: 'lean19r-cell', repo: 'Nexus', branch: 'main', dir: 'nexus' };
export const API_URL = 'https://api.github.com';
export const RAW_URL = 'https://raw.githubusercontent.com';

// Carpetas de nexus/ que no forman parte de la app instalada (igual que hace `install`).
const NOT_INSTALLED = new Set(['docs', 'test', 'tools', 'node_modules', 'dist']);
const BINARY = /\.(png|jpe?g|gif|webp|ico|icns|woff2?)$/i;
const MAX_FILE = 5 * 1024 * 1024;
const MAX_TOTAL = 40 * 1024 * 1024;

export class UpdateError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'UpdateError';
    this.code = code || 'update';
  }
}

// ───────────────────────────────────────────────────────────── utilidades

/** Hash de un archivo tal como lo calcula git (el que GitHub publica para cada archivo). */
export function blobSha(buf) {
  return crypto.createHash('sha1').update('blob ' + buf.length + '\0').update(buf).digest('hex');
}

// En Windows git convierte los saltos de línea a CRLF al clonar y `install` los copia así: los archivos de texto se
// comparan con LF para no dar por distinta una copia idéntica.
function forCompare(buf, rel) {
  if (BINARY.test(rel) || buf.indexOf(13) < 0) return buf;
  return Buffer.from(buf.toString('latin1').replace(/\r\n/g, '\n'), 'latin1');
}

function safeRel(rel) {
  if (!rel || rel.length > 200) return false;
  return rel.split('/').every((seg) => seg && seg !== '.' && seg !== '..' && /^[\w.@+ -]+$/.test(seg));
}

function inside(root, file) {
  const r = path.resolve(root) + path.sep;
  return (path.resolve(file) + path.sep).startsWith(r);
}

async function pool(items, size, fn) {
  const queue = items.slice();
  let failure = null;
  await Promise.all(Array.from({ length: Math.min(size, queue.length) }, async () => {
    while (queue.length && !failure) {
      try { await fn(queue.shift()); } catch (err) { failure = err; }
    }
  }));
  if (failure) throw failure;
}

async function readJson(file, fallback) {
  try { return JSON.parse(await fsp.readFile(file, 'utf8')); } catch { return fallback; }
}

/** ¿Se puede actualizar esta carpeta? No si es un clon de git (ahí se usa `git pull`) ni si no se puede escribir. */
export function selfUpdateSupport(appDir) {
  const dir = path.resolve(appDir);
  if (!isNexusDir(dir)) return { ok: false, reason: 'notnexus', message: `${dir} no parece una instalación de NEXUS.` };
  if (fs.existsSync(path.join(dir, '.git')) || fs.existsSync(path.join(dir, '..', '.git'))) {
    return { ok: false, reason: 'git', message: 'Estás ejecutando NEXUS desde un repositorio de git: actualízalo con «git pull» y vuelve a ejecutar «node nexus/bin/nexus.mjs install».' };
  }
  try {
    fs.accessSync(dir, fs.constants.W_OK);
  } catch {
    return { ok: false, reason: 'readonly', message: `No hay permiso para escribir en ${dir}.` };
  }
  return { ok: true };
}

// ───────────────────────────────────────────────────────────── consulta a GitHub

async function request(url, { fetchImpl, signal, json }) {
  let res;
  try {
    res = await fetchImpl(url, { headers: { 'User-Agent': 'nexus-updater', Accept: json ? 'application/vnd.github+json' : '*/*' }, signal });
  } catch (err) {
    if (err && (err.name === 'AbortError' || err.name === 'TimeoutError')) throw new UpdateError('GitHub tardó demasiado en responder.', 'timeout');
    throw new UpdateError('No se pudo conectar con GitHub. Revisa tu conexión a internet (si usas un proxy, define HTTPS_PROXY y NODE_USE_ENV_PROXY=1).', 'offline');
  }
  if (res.status === 403 || res.status === 429) throw new UpdateError('GitHub limitó las consultas desde tu conexión; inténtalo de nuevo dentro de un rato.', 'ratelimit');
  if (res.status === 404) throw new UpdateError('No se encontró el repositorio o el archivo en GitHub.', 'notfound');
  if (!res.ok) throw new UpdateError(`GitHub respondió con el error HTTP ${res.status}.`, 'http');
  return res;
}

/**
 * Última versión de la rama principal: { sha, date, message, files: [{ path, sha, size, exec }] }.
 * `path` es relativo a la carpeta de la app (sin el prefijo `nexus/`).
 */
export async function fetchLatest({ source = SOURCE, api = API_URL, fetchImpl = fetch, signal } = {}) {
  const sig = signal || AbortSignal.timeout(30000);
  const base = `${api}/repos/${source.owner}/${source.repo}`;
  const commit = await (await request(`${base}/commits/${source.branch}`, { fetchImpl, signal: sig, json: true })).json();
  const sha = commit && commit.sha;
  if (!/^[0-9a-f]{40}$/.test(String(sha))) throw new UpdateError('GitHub devolvió una respuesta inesperada.', 'badresponse');
  const tree = await (await request(`${base}/git/trees/${sha}?recursive=1`, { fetchImpl, signal: sig, json: true })).json();
  if (!tree || !Array.isArray(tree.tree)) throw new UpdateError('GitHub devolvió una respuesta inesperada.', 'badresponse');
  if (tree.truncated) throw new UpdateError('El listado de archivos de GitHub llegó incompleto; no actualizo por seguridad.', 'badresponse');
  const prefix = source.dir + '/';
  const files = [];
  for (const e of tree.tree) {
    if (e.type !== 'blob' || typeof e.path !== 'string' || !e.path.startsWith(prefix)) continue;
    const rel = e.path.slice(prefix.length);
    if (NOT_INSTALLED.has(rel.split('/')[0])) continue;
    if (e.mode === '120000' || e.mode === '160000') continue; // enlaces simbólicos y submódulos: se ignoran
    if (!safeRel(rel)) throw new UpdateError(`El repositorio contiene una ruta no válida («${rel}»); no actualizo por seguridad.`, 'unsafe');
    if (!/^[0-9a-f]{40}$/.test(String(e.sha)) || !(e.size >= 0) || e.size > MAX_FILE) throw new UpdateError(`Datos no válidos para «${rel}»; no actualizo por seguridad.`, 'unsafe');
    files.push({ path: rel, sha: e.sha, size: e.size, exec: e.mode === '100755' });
  }
  if (!files.some((f) => f.path === 'server.mjs') || !files.some((f) => f.path === 'package.json')) {
    throw new UpdateError('El repositorio no parece contener NEXUS; no actualizo.', 'badresponse');
  }
  const message = String((commit.commit && commit.commit.message) || '').split('\n')[0].slice(0, 200);
  const date = commit.commit && commit.commit.committer && commit.commit.committer.date ? Date.parse(commit.commit.committer.date) || null : null;
  return { sha, date, message, files };
}

// ───────────────────────────────────────────────────────────── comparación con lo instalado

async function walk(dir, rel, out) {
  let entries;
  try { entries = await fsp.readdir(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    const r = rel + '/' + e.name;
    if (e.isDirectory()) await walk(path.join(dir, e.name), r, out);
    else if (e.isFile()) out.set(r, blobSha(forCompare(await fsp.readFile(path.join(dir, e.name)), r)));
  }
}

/** Mapa ruta → hash de los archivos de la instalación que pertenecen a las carpetas indicadas. */
export async function localFiles(appDir, tops) {
  const out = new Map();
  for (const top of tops) {
    const p = path.join(appDir, top);
    let st;
    try { st = await fsp.lstat(p); } catch { continue; }
    if (st.isDirectory()) await walk(p, top, out);
    else if (st.isFile()) out.set(top, blobSha(forCompare(await fsp.readFile(p), top)));
  }
  return out;
}

export function diffFiles(remote, local) {
  const changed = [];
  const added = [];
  const seen = new Set();
  for (const f of remote) {
    seen.add(f.path);
    if (!local.has(f.path)) added.push(f);
    else if (local.get(f.path) !== f.sha) changed.push(f);
  }
  const removed = [...local.keys()].filter((rel) => !seen.has(rel));
  return { changed, added, removed };
}

/** Compara la instalación con la última versión: { latest, diff, available }. No modifica nada. */
export async function checkForUpdate({ appDir, ...opts }) {
  const latest = await fetchLatest(opts);
  const tops = new Set([...APP_ENTRIES, ...latest.files.map((f) => f.path.split('/')[0])]);
  const diff = diffFiles(latest.files, await localFiles(appDir, tops));
  return { latest, diff, available: diff.changed.length + diff.added.length + diff.removed.length > 0 };
}

// ───────────────────────────────────────────────────────────── instalación

async function download(f, latest, { source, raw, fetchImpl, signal }) {
  const url = `${raw}/${source.owner}/${source.repo}/${latest.sha}/${source.dir}/${f.path.split('/').map(encodeURIComponent).join('/')}`;
  const buf = Buffer.from(await (await request(url, { fetchImpl, signal, json: false })).arrayBuffer());
  if (buf.length !== f.size || blobSha(buf) !== f.sha) {
    throw new UpdateError(`El archivo «${f.path}» no coincide con el que publica GitHub (descarga dañada o alterada); no instalo nada.`, 'verify');
  }
  return buf;
}

async function restore(applied, appDir, backupDir) {
  for (const a of applied.reverse()) {
    const dst = path.join(appDir, a.rel);
    try {
      if (a.existed) {
        await fsp.mkdir(path.dirname(dst), { recursive: true });
        await fsp.copyFile(path.join(backupDir, a.rel), dst);
      } else {
        await fsp.rm(dst, { force: true });
      }
    } catch { /* se sigue con el resto: es lo mejor que se puede hacer */ }
  }
}

async function pruneEmptyDirs(appDir, rels) {
  for (const rel of rels) {
    let dir = path.dirname(path.join(appDir, rel));
    while (inside(appDir, dir) && path.resolve(dir) !== path.resolve(appDir)) {
      try { await fsp.rmdir(dir); } catch { break; }
      dir = path.dirname(dir);
    }
  }
}

/**
 * Descarga, verifica e instala lo que cambió. Si algo falla, no queda nada a medias: la instalación conserva (o
 * recupera) la versión anterior y la copia de seguridad queda en `backupDir`.
 */
export async function applyUpdate({ appDir, latest, diff, backupDir, source = SOURCE, raw = RAW_URL, fetchImpl = fetch, signal }) {
  const support = selfUpdateSupport(appDir);
  if (!support.ok) throw new UpdateError(support.message, support.reason);
  const todo = [...diff.changed, ...diff.added];
  if (todo.reduce((n, f) => n + f.size, 0) > MAX_TOTAL) throw new UpdateError('La actualización es más grande de lo esperado; no la instalo.', 'size');
  for (const f of todo) if (!safeRel(f.path) || !inside(appDir, path.join(appDir, f.path))) throw new UpdateError('Ruta no válida; no instalo nada.', 'unsafe');
  for (const rel of diff.removed) if (!safeRel(rel) || !inside(appDir, path.join(appDir, rel))) throw new UpdateError('Ruta no válida; no instalo nada.', 'unsafe');

  const sig = signal || AbortSignal.timeout(120000);
  const staging = await fsp.mkdtemp(path.join(os.tmpdir(), 'nexus-update-'));
  try {
    // 1) Descargar y verificar todo antes de tocar la instalación.
    await pool(todo, 6, async (f) => {
      const buf = await download(f, latest, { source, raw, fetchImpl, signal: sig });
      const file = path.join(staging, f.path);
      await fsp.mkdir(path.dirname(file), { recursive: true });
      await fsp.writeFile(file, buf);
    });

    // 2) Copia de seguridad de lo que se va a cambiar o quitar (solo se conserva la de la última actualización).
    await fsp.rm(backupDir, { recursive: true, force: true });
    for (const rel of [...diff.changed.map((f) => f.path), ...diff.removed]) {
      const dst = path.join(backupDir, rel);
      await fsp.mkdir(path.dirname(dst), { recursive: true });
      await fsp.copyFile(path.join(appDir, rel), dst);
    }

    // 3) Instalar: cada archivo se escribe junto a su destino y se renombra encima (sustitución atómica).
    const applied = [];
    try {
      for (const f of todo) {
        const dst = path.join(appDir, f.path);
        const existed = fs.existsSync(dst);
        await fsp.mkdir(path.dirname(dst), { recursive: true });
        const tmp = dst + '.nexus-new';
        await fsp.copyFile(path.join(staging, f.path), tmp);
        if (f.exec && process.platform !== 'win32') await fsp.chmod(tmp, 0o755);
        await fsp.rename(tmp, dst);
        applied.push({ rel: f.path, existed });
      }
      for (const rel of diff.removed) {
        await fsp.rm(path.join(appDir, rel), { force: true });
        applied.push({ rel, existed: true });
      }
    } catch (err) {
      await restore(applied, appDir, backupDir);
      for (const f of todo) await fsp.rm(path.join(appDir, f.path) + '.nexus-new', { force: true }).catch(() => {});
      throw new UpdateError(`No se pudo instalar la actualización (${err.message}). Se restauró la versión anterior.`, 'apply');
    }
    await pruneEmptyDirs(appDir, diff.removed);
    return { sha: latest.sha, changed: diff.changed.length, added: diff.added.length, removed: diff.removed.length };
  } finally {
    await fsp.rm(staging, { recursive: true, force: true }).catch(() => {});
  }
}

// ───────────────────────────────────────────────────────────── orquestador para el servidor

const HOUR = 3600000;

/**
 * Estado de las actualizaciones de un servidor en marcha, con comprobación periódica opcional.
 *   getSettings() → { check, install }   (leídos en cada vuelta, así los cambios de Ajustes se aplican al momento)
 *   onChange(state)                      (se llama con cada cambio de estado)
 *   restart()                            (solo lo usa la instalación automática)
 */
export function createUpdater({ appDir, home, getSettings = () => ({ check: true, install: false }), onChange = () => {}, restart = null, fetchImpl = fetch, api = API_URL, raw = RAW_URL, source = SOURCE, intervalMs = 6 * HOUR, firstDelayMs = 30000, log = () => {} }) {
  const support = selfUpdateSupport(appDir);
  const marker = path.join(home, 'update.json');
  const backupDir = path.join(home, 'backup', 'app');
  let busy = false;
  let checking = false;
  let installing = false;
  let checkedAt = null;
  let latest = null;
  let available = false;
  let changes = null;
  let installed = null;
  let needsRestart = false;
  let error = null;
  let timers = [];

  const brief = (l) => (l ? { sha: l.sha, date: l.date, message: l.message } : null);

  function state() {
    const s = getSettings();
    return {
      supported: support.ok, reason: support.ok ? null : support.reason, message: support.ok ? null : support.message,
      checking, installing, checkedAt, latest: brief(latest), available, changes, installed, needsRestart, error,
      settings: { check: s.check !== false, install: !!s.install }
    };
  }

  function emit() {
    try { onChange(state()); } catch { /* el aviso no debe romper la actualización */ }
  }

  async function check() {
    if (!support.ok) return state();
    if (busy) return state();
    busy = true;
    checking = true;
    error = null;
    emit();
    try {
      const r = await checkForUpdate({ appDir, fetchImpl, api, source });
      latest = r.latest;
      available = r.available;
      changes = r.available ? { changed: r.diff.changed.length, added: r.diff.added.length, removed: r.diff.removed.length } : null;
    } catch (err) {
      error = err && err.message ? err.message : String(err);
      log('comprobación de actualizaciones:', error);
    } finally {
      checkedAt = Date.now();
      busy = false;
      checking = false;
      emit();
    }
    return state();
  }

  async function install() {
    if (!support.ok) { error = support.message; emit(); return state(); }
    if (busy) return state();
    busy = true;
    installing = true;
    error = null;
    emit();
    try {
      // Se vuelve a comparar justo antes: se instala lo último que hay, no lo que se vio hace horas.
      const r = await checkForUpdate({ appDir, fetchImpl, api, source });
      latest = r.latest;
      if (r.available) {
        await applyUpdate({ appDir, latest: r.latest, diff: r.diff, backupDir, source, raw, fetchImpl });
        installed = { sha: r.latest.sha, at: Date.now() };
        needsRestart = true;
        log('actualización instalada:', r.latest.sha);
      }
      available = false;
      changes = null;
    } catch (err) {
      error = err && err.message ? err.message : String(err);
      log('instalación de la actualización:', error);
    } finally {
      checkedAt = Date.now();
      busy = false;
      installing = false;
      emit();
    }
    return state();
  }

  async function tick() {
    const s = getSettings();
    if (!support.ok || s.check === false) return;
    await check();
    if (!available || !s.install || needsRestart) return;
    // Instalación automática: nunca dos veces con la misma versión, para no entrar en un bucle de reinicios si algo falla.
    const seen = await readJson(marker, {});
    if (seen.autoTried === latest.sha) return;
    await fsp.mkdir(home, { recursive: true });
    await fsp.writeFile(marker, JSON.stringify({ ...seen, autoTried: latest.sha }));
    await install();
    if (needsRestart && restart) await restart();
  }

  function start() {
    stop();
    if (!support.ok) return;
    const first = setTimeout(() => { tick().catch(() => {}); }, firstDelayMs);
    const every = setInterval(() => { tick().catch(() => {}); }, intervalMs);
    first.unref();
    every.unref();
    timers = [first, every];
  }

  function stop() {
    timers.forEach((t) => { clearTimeout(t); clearInterval(t); });
    timers = [];
  }

  return { state, check, install, start, stop, tick, support };
}
