// Instalación de NEXUS como skill de Claude Code y (opcional) de sus hooks.
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';

// Lo que se copia a ~/.claude/skills/nexus (los tests no hacen falta allí).
export const APP_ENTRIES = ['SKILL.md', 'README.md', 'package.json', 'server.mjs', 'bin', 'lib', 'hooks', 'web'];

export const HOOK_EVENTS = [
  { event: 'SessionStart' },
  { event: 'UserPromptSubmit' },
  { event: 'Notification' },
  { event: 'Stop' },
  { event: 'SessionEnd' },
  { event: 'PostToolUse', matcher: 'TaskCreate|TaskUpdate|TodoWrite|ExitPlanMode' }
];

const MARK = 'nexus/hooks/emit.mjs';

function isOurs(hook) {
  return hook && typeof hook.command === 'string' && hook.command.replace(/\\/g, '/').includes(MARK);
}

export function hookCommand(appDir, event, autostart) {
  // Barras normales: funcionan igual en bash, cmd y PowerShell, también en Windows.
  let script = path.join(appDir, 'hooks', 'emit.mjs');
  if (process.platform === 'win32') script = script.replace(/\\/g, '/');
  return `node "${script}" ${event}${autostart && event === 'SessionStart' ? ' --autostart' : ''}`;
}

/** Devuelve una copia de settings con los hooks de NEXUS añadidos (sin duplicarlos). */
export function addHooks(settings, appDir, { autostart = false } = {}) {
  const out = removeHooks(settings);
  out.hooks = out.hooks && typeof out.hooks === 'object' ? out.hooks : {};
  for (const { event, matcher } of HOOK_EVENTS) {
    const list = Array.isArray(out.hooks[event]) ? out.hooks[event] : [];
    const entry = { hooks: [{ type: 'command', command: hookCommand(appDir, event, autostart), timeout: 5 }] };
    if (matcher) entry.matcher = matcher;
    list.push(entry);
    out.hooks[event] = list;
  }
  return out;
}

/** Quita solo los hooks de NEXUS; deja intactos los del usuario. */
export function removeHooks(settings) {
  const out = JSON.parse(JSON.stringify(settings || {}));
  if (!out.hooks || typeof out.hooks !== 'object') return out;
  for (const event of Object.keys(out.hooks)) {
    const list = Array.isArray(out.hooks[event]) ? out.hooks[event] : [];
    const kept = [];
    for (const entry of list) {
      if (!entry || !Array.isArray(entry.hooks)) { kept.push(entry); continue; }
      const hooks = entry.hooks.filter((h) => !isOurs(h));
      if (hooks.length) kept.push({ ...entry, hooks });
    }
    if (kept.length) out.hooks[event] = kept;
    else delete out.hooks[event];
  }
  if (!Object.keys(out.hooks).length) delete out.hooks;
  return out;
}

export function hasHooks(settings) {
  const hooks = settings && settings.hooks;
  if (!hooks) return false;
  return Object.values(hooks).some((list) => Array.isArray(list) && list.some((e) => e && Array.isArray(e.hooks) && e.hooks.some(isOurs)));
}

export async function readSettings(file) {
  let raw;
  try {
    raw = await fsp.readFile(file, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return {};
    throw err;
  }
  if (!raw.trim()) return {};
  try {
    return JSON.parse(raw);
  } catch {
    const e = new Error(`${file} no es JSON válido (¿tiene comentarios?). Añade los hooks a mano con: nexus hooks --print`);
    e.code = 'EBADJSON';
    throw e;
  }
}

export async function writeSettings(file, settings) {
  await fsp.mkdir(path.dirname(file), { recursive: true });
  if (fs.existsSync(file)) {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    await fsp.copyFile(file, `${file}.nexus-backup-${stamp}`);
  }
  const tmp = `${file}.${process.pid}.tmp`;
  await fsp.writeFile(tmp, JSON.stringify(settings, null, 2) + '\n');
  await fsp.rename(tmp, file);
}

async function copyRecursive(src, dst) {
  const st = await fsp.stat(src);
  if (st.isDirectory()) {
    await fsp.mkdir(dst, { recursive: true });
    for (const name of await fsp.readdir(src)) {
      if (name === 'node_modules' || name === '.DS_Store') continue;
      await copyRecursive(path.join(src, name), path.join(dst, name));
    }
  } else {
    await fsp.copyFile(src, dst);
  }
}

/** ¿Es este directorio una instalación de NEXUS (y por tanto se puede reemplazar)? */
export function isNexusDir(dir) {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
    return pkg && pkg.name === 'claude-nexus';
  } catch {
    return false;
  }
}

export async function installApp(srcDir, dstDir) {
  const src = path.resolve(srcDir);
  const dst = path.resolve(dstDir);
  if (src === dst) return { copied: false };
  if (fs.existsSync(dst) && !isNexusDir(dst)) {
    throw new Error(`${dst} ya existe y no es NEXUS; no lo toco. Bórralo o elige otro destino con --dir.`);
  }
  if (fs.existsSync(dst)) {
    for (const entry of APP_ENTRIES) await fsp.rm(path.join(dst, entry), { recursive: true, force: true });
  }
  await fsp.mkdir(dst, { recursive: true });
  for (const entry of APP_ENTRIES) {
    const from = path.join(src, entry);
    if (fs.existsSync(from)) await copyRecursive(from, path.join(dst, entry));
  }
  return { copied: true };
}

export async function uninstallApp(dstDir) {
  const dst = path.resolve(dstDir);
  if (!fs.existsSync(dst)) return false;
  if (!isNexusDir(dst)) throw new Error(`${dst} no parece una instalación de NEXUS; no lo borro.`);
  await fsp.rm(dst, { recursive: true, force: true });
  return true;
}
