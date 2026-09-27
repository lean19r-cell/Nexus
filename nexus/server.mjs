#!/usr/bin/env node
// NEXUS — servidor colector local.
// Lee ~/.claude de forma incremental, conserva su propio historial en ~/.claude-nexus
// y sirve el dashboard en http://127.0.0.1:2077 con actualizaciones en vivo (SSE).
import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import zlib from 'node:zlib';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createNodeAdapter, defaultClaudeDir, nexusHome } from './lib/node-fs.mjs';

const require = createRequire(import.meta.url);
const core = require('./web/js/core.js');

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WEB_ROOT = path.join(HERE, 'web');
export const DEFAULT_PORT = 2077;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8'
};

function log(opts, ...args) {
  if (!opts.quiet) console.log('[nexus]', ...args);
}

async function writeAtomic(file, data) {
  await fsp.mkdir(path.dirname(file), { recursive: true });
  const tmp = file + '.' + process.pid + '.tmp';
  await fsp.writeFile(tmp, data);
  await fsp.rename(tmp, file);
}

async function readJsonFile(file, fallback) {
  try {
    return JSON.parse(await fsp.readFile(file, 'utf8'));
  } catch {
    return fallback;
  }
}

export function openBrowser(url) {
  const cmd = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'cmd' : 'xdg-open';
  // En Windows, `start` toma el primer argumento entre comillas como título: le pasamos uno vacío.
  const args = process.platform === 'win32' ? ['/c', 'start', '', url] : [url];
  try {
    const child = spawn(cmd, args, { stdio: 'ignore', detached: true, windowsHide: true });
    child.on('error', () => {});
    child.unref();
  } catch {
    /* sin navegador: el usuario abre la URL a mano */
  }
}

// ───────────────────────────────────────────────────────────── caché en disco

export class Store {
  constructor(home) {
    this.home = home;
    this.dir = path.join(home, 'cache');
    this.sessionsDir = path.join(this.dir, 'sessions');
    this.dirty = new Set();
    this.indexDirty = false;
  }

  async load(collector) {
    const index = await readJsonFile(path.join(this.dir, 'index.json'), null);
    if (!index) return 0;
    const sessions = {};
    let names = [];
    try { names = await fsp.readdir(this.sessionsDir); } catch { /* sin caché */ }
    for (const name of names) {
      if (!name.endsWith('.json')) continue;
      const s = await readJsonFile(path.join(this.sessionsDir, name), null);
      if (s && s.id) sessions[s.id] = s;
    }
    return collector.importState(index, sessions) ? Object.keys(sessions).length : 0;
  }

  markSessions(ids) {
    for (const id of ids) this.dirty.add(id);
    this.indexDirty = true;
  }

  async flush(collector) {
    const ids = [...this.dirty];
    this.dirty.clear();
    for (const id of ids) {
      const s = collector.sessions[id];
      const file = path.join(this.sessionsDir, encodeURIComponent(id) + '.json');
      if (!s) {
        await fsp.rm(file, { force: true }).catch(() => {});
        continue;
      }
      await writeAtomic(file, JSON.stringify(s));
    }
    if (this.indexDirty || ids.length) {
      this.indexDirty = false;
      await writeAtomic(path.join(this.dir, 'index.json'), JSON.stringify(collector.exportIndex()));
    }
  }
}

// ───────────────────────────────────────────────────────────── servidor

export async function startServer(options = {}) {
  const opts = {
    port: Number(options.port !== undefined && options.port !== null && options.port !== '' ? options.port : (process.env.NEXUS_PORT || DEFAULT_PORT)),
    host: options.host || process.env.NEXUS_HOST || '127.0.0.1',
    claudeDir: path.resolve(options.claudeDir || defaultClaudeDir()),
    home: path.resolve(options.home || nexusHome()),
    open: !!options.open,
    quiet: !!options.quiet,
    pollMs: Number(options.pollMs || 1500),
    fullMs: Number(options.fullMs || 60000),
    cache: options.cache !== false
  };

  const adapter = createNodeAdapter(opts.claudeDir);
  const collector = new core.Collector(adapter);
  collector.hookStates = {};
  const store = new Store(opts.home);
  const configFile = path.join(opts.home, 'config.json');
  let config = core.normalizeConfig(await readJsonFile(configFile, null));

  const clients = new Set();
  let seq = 0;
  let ready = false;
  let scanning = false;
  let pathsQueued = false;
  let fullQueued = false;
  let pendingPaths = new Set();
  let lastProgress = 0;
  const startedAt = Date.now();

  if (opts.cache) {
    try {
      const n = await store.load(collector);
      if (n) log(opts, `caché cargada: ${n} sesiones`);
    } catch (err) {
      log(opts, 'caché ignorada:', err.message);
    }
  }

  function send(res, event, data) {
    try {
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    } catch {
      clients.delete(res);
    }
  }

  function broadcast(event, data) {
    for (const res of clients) send(res, event, data);
  }

  collector.onProgress = (meta) => {
    const now = Date.now();
    if (ready || now - lastProgress < 250) return;
    lastProgress = now;
    broadcast('progress', { bytes: meta.bytes, lines: meta.lines, files: Object.keys(collector.files).length });
  };

  function snapshot() {
    const snap = collector.snapshot();
    snap.seq = seq;
    snap.ready = ready;
    snap.config = config;
    snap.source = 'server';
    snap.claudeDir = opts.claudeDir;
    snap.server = { version: core.VERSION, pid: process.pid, startedAt, home: opts.home };
    return snap;
  }

  function publish(ch) {
    if (!ch) return;
    const delta = { sessions: {}, taskLists: {}, plans: {}, live: null, meta: collector.publicMeta() };
    let any = false;
    for (const id of ch.sessions) {
      const s = collector.sessions[id];
      delta.sessions[id] = s ? core.publicSession(s) : null;
      any = true;
    }
    for (const id of ch.taskIds || []) {
      const l = collector.taskLists[id];
      delta.taskLists[id] = l ? { id: l.id, tasks: l.tasks, mtime: l.mtime, archived: l.archived } : null;
      any = true;
    }
    for (const name of ch.planNames || []) {
      delta.plans[name] = collector.plans[name] || null;
      any = true;
    }
    if (ch.live) {
      delta.live = collector.live;
      any = true;
    }
    if (ch.sessions.length || (ch.taskIds || []).length || (ch.planNames || []).length) store.markSessions(ch.sessions);
    if (!any) return;
    seq++;
    delta.seq = seq;
    broadcast('delta', delta);
  }

  async function runScan(kind) {
    if (scanning) {
      // Un evento de hook no debe perderse: se procesa en cuanto termine el escaneo en curso.
      if (kind === 'paths') pathsQueued = true;
      else if (kind === 'full') fullQueued = true;
      return;
    }
    scanning = true;
    try {
      let ch;
      if (kind === 'paths') {
        const paths = [...pendingPaths];
        pendingPaths = new Set();
        ch = await collector.scanPaths(paths);
      } else {
        ch = await collector.scan({ full: kind === 'full' });
      }
      if (ch.tasks || ch.plans) store.indexDirty = true;
      publish(ch);
    } catch (err) {
      log(opts, 'error en el escaneo:', err && err.stack ? err.stack : err);
    } finally {
      scanning = false;
    }
    if (fullQueued) {
      fullQueued = false;
      setTimeout(() => runScan('full'), 0);
    } else if (pathsQueued) {
      pathsQueued = false;
      setTimeout(() => runScan('paths'), 0);
    }
  }

  // ─── rutas

  function allowedHost(req) {
    const host = String(req.headers.host || '').toLowerCase();
    const ok = [`127.0.0.1:${opts.port}`, `localhost:${opts.port}`, `[::1]:${opts.port}`];
    if (opts.host !== '127.0.0.1' && opts.host !== 'localhost') return true; // el usuario expuso el puerto a propósito
    return ok.includes(host);
  }

  function allowedOrigin(req) {
    const origin = req.headers.origin;
    if (!origin) return true;
    try {
      const u = new URL(origin);
      return (u.hostname === '127.0.0.1' || u.hostname === 'localhost' || u.hostname === '[::1]') && Number(u.port) === opts.port;
    } catch {
      return false;
    }
  }

  function json(req, res, code, data) {
    const body = Buffer.from(JSON.stringify(data));
    const headers = { 'Content-Type': MIME['.json'], 'Cache-Control': 'no-store' };
    if (body.length > 64 * 1024 && /\bgzip\b/.test(req.headers['accept-encoding'] || '')) {
      headers['Content-Encoding'] = 'gzip';
      res.writeHead(code, headers);
      res.end(zlib.gzipSync(body, { level: 4 }));
      return;
    }
    res.writeHead(code, headers);
    res.end(body);
  }

  function readBody(req, limit = 1024 * 1024) {
    return new Promise((resolve, reject) => {
      const chunks = [];
      let size = 0;
      req.on('data', (c) => {
        size += c.length;
        if (size > limit) {
          reject(new Error('cuerpo demasiado grande'));
          req.destroy();
          return;
        }
        chunks.push(c);
      });
      req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
      req.on('error', reject);
    });
  }

  function onHook(evt) {
    const sid = evt.session_id ? String(evt.session_id) : null;
    const name = String(evt.hook_event_name || evt.event || '');
    const now = Date.now();
    if (sid) {
      const prev = collector.hookStates[sid] || { startedAt: now };
      const st = { ...prev, at: now, cwd: evt.cwd || prev.cwd || null };
      switch (name) {
        case 'SessionStart': st.status = 'idle'; st.ended = false; st.startedAt = now; st.waitingFor = null; break;
        case 'UserPromptSubmit': case 'PreToolUse': case 'PostToolUse': case 'SubagentStop': st.status = 'busy'; st.waitingFor = null; break;
        case 'Notification': st.status = 'waiting'; st.waitingFor = core.trunc(String(evt.message || 'tu respuesta'), 160); break;
        case 'Stop': st.status = 'idle'; st.waitingFor = null; break;
        case 'SessionEnd': st.ended = true; break;
        default: break;
      }
      collector.hookStates[sid] = st;
    }
    if (evt.transcript_path) {
      const rel = path.relative(opts.claudeDir, String(evt.transcript_path));
      if (rel && !rel.startsWith('..') && !path.isAbsolute(rel)) pendingPaths.add(rel.split(path.sep).join('/'));
    }
    if (/^Task(Create|Update)$/.test(String(evt.tool_name || '')) && sid) pendingPaths.add('tasks/' + sid);
    if (name === 'Notification') {
      broadcast('notify', { sessionId: sid, message: core.trunc(String(evt.message || ''), 200), cwd: evt.cwd || null, t: now });
    }
    setTimeout(() => runScan('paths'), 30);
  }

  async function serveStatic(req, res, urlPath) {
    let rel = decodeURIComponent(urlPath);
    if (rel === '/' || rel === '') rel = '/index.html';
    const file = path.normalize(path.join(WEB_ROOT, rel));
    if (!file.startsWith(WEB_ROOT + path.sep)) {
      res.writeHead(403).end();
      return;
    }
    try {
      const data = await fsp.readFile(file);
      res.writeHead(200, {
        'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
        'Cache-Control': 'no-cache',
        'X-Content-Type-Options': 'nosniff'
      });
      res.end(data);
    } catch {
      res.writeHead(404, { 'Content-Type': MIME['.txt'] }).end('No encontrado');
    }
  }

  const server = http.createServer(async (req, res) => {
    if (!allowedHost(req)) {
      res.writeHead(421, { 'Content-Type': MIME['.txt'] }).end('Host no permitido');
      return;
    }
    const url = new URL(req.url, `http://127.0.0.1:${opts.port}`);
    const p = url.pathname;
    try {
      if (req.method === 'GET' && p === '/api/health') {
        return json(req, res, 200, { ok: true, name: 'nexus', version: core.VERSION, pid: process.pid, ready, claudeDir: opts.claudeDir, home: opts.home, uptime: Date.now() - startedAt, clients: clients.size });
      }
      if (req.method === 'GET' && p === '/api/snapshot') return json(req, res, 200, snapshot());
      if (req.method === 'GET' && p === '/api/model') {
        // Modelo ya agregado (lo usa el CLI `nexus status`).
        const model = core.buildModel(collector.snapshot(), config, Date.now());
        delete model.sessionMap;
        delete model.projectMap;
        return json(req, res, 200, { ready, model });
      }
      if (req.method === 'GET' && p === '/api/stream') {
        res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-store', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
        res.write('retry: 2000\n\n');
        clients.add(res);
        send(res, 'hello', { seq, ready, version: core.VERSION });
        req.on('close', () => clients.delete(res));
        return;
      }
      if (req.method === 'GET' && p === '/api/config') return json(req, res, 200, config);
      if (req.method === 'POST' && (p === '/api/config' || p === '/api/hook' || p === '/api/rescan')) {
        if (!allowedOrigin(req)) return json(req, res, 403, { error: 'origen no permitido' });
        if (!/application\/json/.test(req.headers['content-type'] || '')) return json(req, res, 415, { error: 'se espera JSON' });
        const raw = await readBody(req);
        let body = {};
        try { body = raw ? JSON.parse(raw) : {}; } catch { return json(req, res, 400, { error: 'JSON inválido' }); }
        if (p === '/api/config') {
          config = core.normalizeConfig(body);
          await writeAtomic(configFile, JSON.stringify(config, null, 2));
          broadcast('config', config);
          return json(req, res, 200, config);
        }
        if (p === '/api/hook') {
          onHook(body || {});
          return json(req, res, 200, { ok: true });
        }
        setTimeout(() => runScan('full'), 0);
        return json(req, res, 200, { ok: true });
      }
      if (req.method === 'GET' && !p.startsWith('/api/')) return serveStatic(req, res, p);
      json(req, res, 404, { error: 'no encontrado' });
    } catch (err) {
      json(req, res, 500, { error: String(err && err.message ? err.message : err) });
    }
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(opts.port, opts.host, () => {
      server.off('error', reject);
      opts.port = server.address().port; // por si se pidió el puerto 0
      resolve();
    });
  });

  const url = `http://${opts.host === '0.0.0.0' ? '127.0.0.1' : opts.host}:${opts.port}/`;
  log(opts, `NEXUS en línea → ${url}`);
  log(opts, `leyendo ${opts.claudeDir}`);
  await writeAtomic(path.join(opts.home, 'server.json'), JSON.stringify({ pid: process.pid, port: opts.port, host: opts.host, url, version: core.VERSION, startedAt }, null, 2)).catch(() => {});
  if (opts.open) openBrowser(url);

  // Primer escaneo completo (puede tardar con historiales grandes; la UI muestra el progreso).
  const t0 = Date.now();
  await runScan('full');
  ready = true;
  seq++;
  broadcast('ready', { seq });
  log(opts, `escaneo inicial: ${Object.keys(collector.sessions).length} sesiones en ${Date.now() - t0} ms`);
  if (opts.cache) await store.flush(collector).catch((err) => log(opts, 'no se pudo guardar la caché:', err.message));

  let lastFull = Date.now();
  const poll = setInterval(() => {
    const full = Date.now() - lastFull >= opts.fullMs;
    if (full) lastFull = Date.now();
    runScan(full ? 'full' : 'hot');
  }, opts.pollMs);
  const flush = opts.cache ? setInterval(() => store.flush(collector).catch(() => {}), 5000) : null;
  const heartbeat = setInterval(() => {
    for (const res of clients) {
      try { res.write(': ping\n\n'); } catch { clients.delete(res); }
    }
  }, 15000);

  let closed = false;
  async function close() {
    if (closed) return;
    closed = true;
    clearInterval(poll);
    clearInterval(heartbeat);
    if (flush) clearInterval(flush);
    for (const res of clients) { try { res.end(); } catch { /* ya cerrado */ } }
    clients.clear();
    await new Promise((r) => server.close(() => r()));
    if (opts.cache) await store.flush(collector).catch(() => {});
    try {
      const info = await readJsonFile(path.join(opts.home, 'server.json'), null);
      if (info && info.pid === process.pid) await fsp.rm(path.join(opts.home, 'server.json'), { force: true });
    } catch { /* nada */ }
  }

  return { url, server, collector, close, get ready() { return ready; }, opts };
}

// ───────────────────────────────────────────────────────────── ejecución directa

export function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    if (a === '--port' || a === '-p') out.port = next();
    else if (a.startsWith('--port=')) out.port = a.slice(7);
    else if (a === '--host') out.host = next();
    else if (a === '--claude-dir') out.claudeDir = next();
    else if (a.startsWith('--claude-dir=')) out.claudeDir = a.slice(13);
    else if (a === '--home') out.home = next();
    else if (a === '--open' || a === '-o') out.open = true;
    else if (a === '--quiet' || a === '-q') out.quiet = true;
    else if (a === '--no-cache') out.cache = false;
    else if (a === '--demo') out.demo = true;
  }
  return out;
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (isMain) {
  const args = parseArgs(process.argv.slice(2));
  startServer(args).then((srv) => {
    if (args.demo) openBrowser(srv.url + '?demo');
    const stop = async () => {
      await srv.close();
      process.exit(0);
    };
    process.on('SIGINT', stop);
    process.on('SIGTERM', stop);
  }).catch((err) => {
    if (err && err.code === 'EADDRINUSE') {
      console.error(`[nexus] el puerto ya está en uso. ¿NEXUS ya está corriendo? Prueba: node bin/nexus.mjs open`);
    } else {
      console.error('[nexus] no se pudo iniciar:', err && err.stack ? err.stack : err);
    }
    process.exit(1);
  });
}
