// Acceso directo de escritorio para abrir NEXUS con doble clic.
//   macOS   → NEXUS.app en el Escritorio (sin ventana de terminal)
//   Windows → NEXUS.lnk en el Escritorio y en el menú Inicio (vía PowerShell)
//   Linux   → NEXUS.desktop en el Escritorio y en el menú de aplicaciones
// Todos ejecutan `node bin/nexus.mjs open --gui`: arranca el servidor si hace falta y abre el panel.
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

export const APP_NAME = 'NEXUS';
export const BUNDLE_ID = 'local.nexus.mission-control';
const DESCRIPTION = 'Abrir NEXUS, el centro de mando de Claude Code';

// ───────────────────────────────────────────────────────────── entrecomillado

/** Argumento seguro para sh (comillas simples). */
export function shQuote(s) {
  return "'" + String(s).replace(/'/g, "'\\''") + "'";
}

/** Cadena literal de PowerShell (comillas simples; la comilla se duplica). */
export function psQuote(s) {
  return "'" + String(s).replace(/'/g, "''") + "'";
}

/** Cadena literal de AppleScript. */
export function asQuote(s) {
  return '"' + String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';
}

/**
 * Argumento de la clave Exec de un .desktop: entre comillas dobles escapando " ` $ \,
 * con % → %% y luego la regla de escape de cadenas (\ → \\), como pide la especificación.
 */
export function execArg(s) {
  const quoted = '"' + String(s).replace(/%/g, '%%').replace(/(["`$\\])/g, '\\$1') + '"';
  return quoted.replace(/\\/g, '\\\\');
}

function xml(s) {
  return String(s).replace(/[<>&"']/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' }[c]));
}

function cliPath(appDir) {
  return path.join(appDir, 'bin', 'nexus.mjs');
}

// ───────────────────────────────────────────────────────────── macOS

export function macLauncher({ node, cli, log }) {
  return [
    '#!/bin/sh',
    '# NEXUS · abre el centro de mando (creado por «nexus shortcut»).',
    `mkdir -p ${shQuote(path.dirname(log))} 2>/dev/null`,
    `exec ${shQuote(node)} ${shQuote(cli)} open --gui >>${shQuote(log)} 2>&1`,
    ''
  ].join('\n');
}

export function macInfoPlist() {
  const entries = [
    ['CFBundleName', APP_NAME],
    ['CFBundleDisplayName', APP_NAME],
    ['CFBundleIdentifier', BUNDLE_ID],
    ['CFBundleExecutable', 'nexus'],
    ['CFBundleIconFile', 'nexus'],
    ['CFBundlePackageType', 'APPL'],
    ['CFBundleShortVersionString', '1.0'],
    ['CFBundleVersion', '1'],
    ['LSMinimumSystemVersion', '10.13']
  ];
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    '<dict>',
    ...entries.map(([k, v]) => `  <key>${k}</key><string>${xml(v)}</string>`),
    // Sin icono en el Dock: el lanzador solo vive un segundo.
    '  <key>LSUIElement</key><true/>',
    '  <key>NSHighResolutionCapable</key><true/>',
    '</dict>',
    '</plist>',
    ''
  ].join('\n');
}

function isOurBundle(bundle) {
  try {
    return fs.readFileSync(path.join(bundle, 'Contents', 'Info.plist'), 'utf8').includes(BUNDLE_ID);
  } catch {
    return false;
  }
}

async function createMac({ appDir, node, dir, home }) {
  const target = dir || path.join(home, 'Desktop');
  const bundle = path.join(target, `${APP_NAME}.app`);
  if (fs.existsSync(bundle)) {
    if (!isOurBundle(bundle)) throw new Error(`Ya existe ${bundle} y no lo creó NEXUS; no lo toco.`);
    await fsp.rm(bundle, { recursive: true, force: true });
  }
  const contents = path.join(bundle, 'Contents');
  await fsp.mkdir(path.join(contents, 'MacOS'), { recursive: true });
  await fsp.mkdir(path.join(contents, 'Resources'), { recursive: true });
  await fsp.writeFile(path.join(contents, 'Info.plist'), macInfoPlist());
  const exe = path.join(contents, 'MacOS', 'nexus');
  const log = path.join(process.env.NEXUS_HOME || path.join(home, '.claude-nexus'), 'launcher.log');
  await fsp.writeFile(exe, macLauncher({ node, cli: cliPath(appDir), log }), { mode: 0o755 });
  await fsp.chmod(exe, 0o755);
  const icon = path.join(appDir, 'assets', 'nexus.icns');
  if (fs.existsSync(icon)) await fsp.copyFile(icon, path.join(contents, 'Resources', 'nexus.icns'));
  return [bundle];
}

async function removeMac({ dir, home }) {
  const bundle = path.join(dir || path.join(home, 'Desktop'), `${APP_NAME}.app`);
  if (!fs.existsSync(bundle) || !isOurBundle(bundle)) return [];
  await fsp.rm(bundle, { recursive: true, force: true });
  return [bundle];
}

// ───────────────────────────────────────────────────────────── Linux

export function linuxDesktopEntry({ node, cli, icon }) {
  return [
    '[Desktop Entry]',
    'Type=Application',
    'Version=1.0',
    `Name=${APP_NAME}`,
    'GenericName=Centro de mando de Claude Code',
    `Comment=${DESCRIPTION}`,
    `Exec=${execArg(node)} ${execArg(cli)} open --gui`,
    `Icon=${icon}`,
    'Terminal=false',
    'StartupNotify=false',
    'Categories=Development;Utility;',
    'X-NEXUS=1',
    ''
  ].join('\n');
}

function linuxDesktopDir(home) {
  try {
    const out = execFileSync('xdg-user-dir', ['DESKTOP'], { encoding: 'utf8', timeout: 3000, stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    if (out && out !== home && fs.existsSync(out)) return out;
  } catch { /* sin xdg-user-dirs */ }
  const fallback = path.join(home, 'Desktop');
  return fs.existsSync(fallback) ? fallback : null;
}

function isOurEntry(file) {
  try { return fs.readFileSync(file, 'utf8').includes('X-NEXUS=1'); } catch { return false; }
}

async function createLinux({ appDir, node, dir, home }) {
  const entry = linuxDesktopEntry({ node, cli: cliPath(appDir), icon: path.join(appDir, 'assets', 'nexus.png') });
  const menuDir = path.join(process.env.XDG_DATA_HOME || path.join(home, '.local', 'share'), 'applications');
  const files = [];
  await fsp.mkdir(menuDir, { recursive: true });
  const menuFile = path.join(menuDir, 'nexus.desktop');
  if (fs.existsSync(menuFile) && !isOurEntry(menuFile)) throw new Error(`Ya existe ${menuFile} y no lo creó NEXUS; no lo toco.`);
  await fsp.writeFile(menuFile, entry, { mode: 0o755 });
  files.push(menuFile);
  const desktop = dir || linuxDesktopDir(home);
  if (desktop) {
    const file = path.join(desktop, `${APP_NAME}.desktop`);
    if (fs.existsSync(file) && !isOurEntry(file)) throw new Error(`Ya existe ${file} y no lo creó NEXUS; no lo toco.`);
    await fsp.mkdir(desktop, { recursive: true });
    await fsp.writeFile(file, entry, { mode: 0o755 });
    await fsp.chmod(file, 0o755);
    // GNOME pide marcar como "de confianza" los lanzadores del escritorio.
    try { execFileSync('gio', ['set', file, 'metadata::trusted', 'true'], { timeout: 3000, stdio: 'ignore' }); } catch { /* otro escritorio */ }
    files.push(file);
  }
  return files;
}

async function removeLinux({ dir, home }) {
  const removed = [];
  const candidates = [
    path.join(process.env.XDG_DATA_HOME || path.join(home, '.local', 'share'), 'applications', 'nexus.desktop'),
    path.join(dir || linuxDesktopDir(home) || path.join(home, 'Desktop'), `${APP_NAME}.desktop`)
  ];
  for (const f of candidates) {
    if (fs.existsSync(f) && isOurEntry(f)) {
      await fsp.rm(f, { force: true });
      removed.push(f);
    }
  }
  return removed;
}

// ───────────────────────────────────────────────────────────── Windows

function folders(dir) {
  return dir ? psQuote(dir) : "[Environment]::GetFolderPath('Desktop'), [Environment]::GetFolderPath('Programs')";
}

/** Script de PowerShell que crea NEXUS.lnk (Escritorio y menú Inicio salvo que se indique otra carpeta). */
export function windowsShortcutScript({ node, cli, appDir, icon, dir }) {
  return [
    "$ErrorActionPreference = 'Stop'",
    '$ws = New-Object -ComObject WScript.Shell',
    `foreach ($d in @(${folders(dir)})) {`,
    '  if (-not $d) { continue }',
    '  New-Item -ItemType Directory -Force -Path $d | Out-Null',
    "  $lnk = Join-Path $d 'NEXUS.lnk'",
    '  $s = $ws.CreateShortcut($lnk)',
    `  $s.TargetPath = ${psQuote(node)}`,
    `  $s.Arguments = ${psQuote(`"${cli}" open --gui`)}`,
    `  $s.WorkingDirectory = ${psQuote(appDir)}`,
    `  $s.IconLocation = ${psQuote(icon + ',0')}`,
    '  $s.WindowStyle = 7',
    `  $s.Description = ${psQuote(DESCRIPTION)}`,
    '  $s.Save()',
    '  Write-Output $lnk',
    '}'
  ].join('\r\n');
}

export function windowsRemoveScript({ dir }) {
  return [
    `foreach ($d in @(${folders(dir)})) {`,
    '  if (-not $d) { continue }',
    "  $lnk = Join-Path $d 'NEXUS.lnk'",
    '  if (Test-Path -LiteralPath $lnk) { Remove-Item -LiteralPath $lnk -Force; Write-Output $lnk }',
    '}'
  ].join('\r\n');
}

function powershell(script, timeout = 30000) {
  const encoded = Buffer.from(script, 'utf16le').toString('base64');
  return execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded], {
    encoding: 'utf8',
    windowsHide: true,
    timeout
  });
}

function lines(out) {
  return String(out || '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
}

async function createWindows({ appDir, node, dir }) {
  const out = powershell(windowsShortcutScript({ node, cli: cliPath(appDir), appDir, icon: path.join(appDir, 'assets', 'nexus.ico'), dir }));
  return lines(out);
}

async function removeWindows({ dir }) {
  return lines(powershell(windowsRemoveScript({ dir })));
}

// ───────────────────────────────────────────────────────────── API

export async function createShortcut({ appDir, node = process.execPath, dir = null, platform = process.platform, home = os.homedir() }) {
  if (platform === 'darwin') return createMac({ appDir, node, dir, home });
  if (platform === 'win32') return createWindows({ appDir, node, dir });
  return createLinux({ appDir, node, dir, home });
}

export async function removeShortcut({ dir = null, platform = process.platform, home = os.homedir() } = {}) {
  if (platform === 'darwin') return removeMac({ dir, home });
  if (platform === 'win32') return removeWindows({ dir });
  return removeLinux({ dir, home });
}

/** Aviso visible cuando no hay terminal (el acceso directo la oculta). Nunca lanza. */
export function guiAlert(title, message, platform = process.platform) {
  try {
    if (platform === 'darwin') {
      execFileSync('osascript', ['-e', `display alert ${asQuote(title)} message ${asQuote(message)} as critical`], { timeout: 600000, stdio: 'ignore' });
    } else if (platform === 'win32') {
      powershell(`Add-Type -AssemblyName PresentationFramework; [System.Windows.MessageBox]::Show(${psQuote(message)}, ${psQuote(title)}) | Out-Null`, 600000);
    } else {
      execFileSync('notify-send', ['--urgency=critical', title, message], { timeout: 5000, stdio: 'ignore' });
    }
  } catch { /* sin interfaz gráfica: queda el registro */ }
}
