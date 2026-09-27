import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import fss from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import * as sc from '../lib/shortcut.mjs';

const APP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

test('entrecomillado seguro para sh, PowerShell, AppleScript y .desktop', () => {
  const nasty = "a b'c$d`e\"f\\g";
  // sh interpreta de vuelta exactamente la cadena original.
  assert.equal(execFileSync('sh', ['-c', 'printf %s ' + sc.shQuote(nasty)], { encoding: 'utf8' }), nasty);
  assert.equal(sc.psQuote("C:\\Users\\O'Neil"), "'C:\\Users\\O''Neil'");
  assert.equal(sc.asQuote('dijo "hola" \\ fin'), '"dijo \\"hola\\" \\\\ fin"');
  assert.equal(sc.execArg('/home/u/mis apps/node'), '"/home/u/mis apps/node"');
  assert.equal(sc.execArg('/a/100%/x'), '"/a/100%%/x"');
  // $ y " se escapan con \ y después la regla de cadenas duplica cada \.
  assert.equal(sc.execArg('/a/$b"c'), '"/a/\\\\$b\\\\"c"');
  assert.equal(sc.execArg('/a\\b'), '"/a\\\\\\\\b"');
});

test('macOS: NEXUS.app con lanzador, Info.plist e icono; no toca apps ajenas', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'nexus-mac-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const [bundle] = await sc.createShortcut({ platform: 'darwin', appDir: APP, node: '/opt/homebrew/bin/node', dir, home: dir });
  assert.equal(bundle, path.join(dir, 'NEXUS.app'));

  const plist = await fs.readFile(path.join(bundle, 'Contents', 'Info.plist'), 'utf8');
  assert.match(plist, /<key>CFBundleExecutable<\/key><string>nexus<\/string>/);
  assert.match(plist, /<key>CFBundleIconFile<\/key><string>nexus<\/string>/);
  assert.ok(plist.includes(sc.BUNDLE_ID));

  const exe = path.join(bundle, 'Contents', 'MacOS', 'nexus');
  assert.ok((await fs.stat(exe)).mode & 0o111, 'el lanzador es ejecutable');
  const script = await fs.readFile(exe, 'utf8');
  assert.ok(script.startsWith('#!/bin/sh\n'));
  assert.ok(script.includes(`exec '/opt/homebrew/bin/node' '${path.join(APP, 'bin', 'nexus.mjs')}' open --gui >>`));
  execFileSync('sh', ['-n', exe]); // sintaxis válida

  const icns = await fs.readFile(path.join(bundle, 'Contents', 'Resources', 'nexus.icns'));
  assert.equal(icns.subarray(0, 4).toString('ascii'), 'icns');

  // Volver a crearlo lo reemplaza (p. ej. tras cambiar de versión de Node).
  await sc.createShortcut({ platform: 'darwin', appDir: APP, node: '/usr/local/bin/node', dir, home: dir });
  assert.ok((await fs.readFile(exe, 'utf8')).includes("'/usr/local/bin/node'"));

  const foreign = path.join(dir, 'otra');
  await fs.mkdir(path.join(foreign, 'NEXUS.app', 'Contents'), { recursive: true });
  await fs.writeFile(path.join(foreign, 'NEXUS.app', 'Contents', 'Info.plist'), '<plist/>');
  await assert.rejects(sc.createShortcut({ platform: 'darwin', appDir: APP, node: 'node', dir: foreign, home: dir }), /no lo creó NEXUS/);
  assert.deepEqual(await sc.removeShortcut({ platform: 'darwin', dir: foreign, home: dir }), []);

  assert.deepEqual(await sc.removeShortcut({ platform: 'darwin', dir, home: dir }), [bundle]);
  assert.equal(fss.existsSync(bundle), false);
});

test('Linux: lanzador en el menú de aplicaciones y en el escritorio', async (t) => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'nexus-linux-'));
  const prev = process.env.XDG_DATA_HOME;
  process.env.XDG_DATA_HOME = path.join(home, 'data');
  t.after(async () => {
    if (prev === undefined) delete process.env.XDG_DATA_HOME; else process.env.XDG_DATA_HOME = prev;
    await fs.rm(home, { recursive: true, force: true });
  });
  const desk = path.join(home, 'Escritorio');
  await fs.mkdir(desk);
  const appDir = '/opt/mis apps/nexus';
  const files = await sc.createShortcut({ platform: 'linux', appDir, node: '/usr/bin/node', dir: desk, home });
  assert.deepEqual(files, [path.join(home, 'data', 'applications', 'nexus.desktop'), path.join(desk, 'NEXUS.desktop')]);
  const entry = await fs.readFile(files[1], 'utf8');
  assert.match(entry, /^\[Desktop Entry\]$/m);
  assert.match(entry, /^Exec="\/usr\/bin\/node" "\/opt\/mis apps\/nexus\/bin\/nexus\.mjs" open --gui$/m);
  assert.match(entry, /^Icon=\/opt\/mis apps\/nexus\/assets\/nexus\.png$/m);
  assert.match(entry, /^Terminal=false$/m);
  assert.ok((await fs.stat(files[1])).mode & 0o111);
  assert.deepEqual((await sc.removeShortcut({ platform: 'linux', dir: desk, home })).sort(), files.slice().sort());
});

test('Windows: el script de PowerShell crea NEXUS.lnk con icono y ventana minimizada', () => {
  const appDir = "C:\\Users\\O'Neil\\.claude\\skills\\nexus";
  const ps = sc.windowsShortcutScript({
    node: 'C:\\Program Files\\nodejs\\node.exe',
    cli: appDir + '\\bin\\nexus.mjs',
    appDir,
    icon: appDir + '\\assets\\nexus.ico',
    dir: null
  });
  assert.ok(ps.includes("foreach ($d in @([Environment]::GetFolderPath('Desktop'), [Environment]::GetFolderPath('Programs'))) {"));
  assert.ok(ps.includes("$s.TargetPath = 'C:\\Program Files\\nodejs\\node.exe'"));
  assert.ok(ps.includes(`$s.Arguments = '"C:\\Users\\O''Neil\\.claude\\skills\\nexus\\bin\\nexus.mjs" open --gui'`));
  assert.ok(ps.includes("$s.IconLocation = 'C:\\Users\\O''Neil\\.claude\\skills\\nexus\\assets\\nexus.ico,0'"));
  assert.ok(ps.includes('$s.WindowStyle = 7'));
  assert.ok(sc.windowsShortcutScript({ node: 'n', cli: 'c', appDir: 'a', icon: 'i', dir: 'D:\\Atajos' }).includes("foreach ($d in @('D:\\Atajos')) {"));
  assert.ok(sc.windowsRemoveScript({ dir: null }).includes("Remove-Item -LiteralPath $lnk -Force"));
});

test('iconos: ICO, ICNS y PNG válidos', async () => {
  const ico = await fs.readFile(path.join(APP, 'assets', 'nexus.ico'));
  assert.equal(ico.readUInt16LE(0), 0);
  assert.equal(ico.readUInt16LE(2), 1, 'tipo icono');
  const count = ico.readUInt16LE(4);
  const sizes = [];
  for (let i = 0; i < count; i++) {
    const e = 6 + i * 16;
    sizes.push(ico[e] || 256);
    const len = ico.readUInt32LE(e + 8);
    const off = ico.readUInt32LE(e + 12);
    assert.ok(off + len <= ico.length);
    assert.deepEqual(ico.subarray(off, off + 8), PNG_SIGNATURE);
  }
  for (const s of [16, 32, 48, 256]) assert.ok(sizes.includes(s), `falta el tamaño ${s}`);

  const icns = await fs.readFile(path.join(APP, 'assets', 'nexus.icns'));
  assert.equal(icns.subarray(0, 4).toString('ascii'), 'icns');
  assert.equal(icns.readUInt32BE(4), icns.length);
  const types = [];
  let off = 8;
  while (off < icns.length) {
    types.push(icns.subarray(off, off + 4).toString('ascii'));
    assert.deepEqual(icns.subarray(off + 8, off + 16), PNG_SIGNATURE);
    off += icns.readUInt32BE(off + 4);
  }
  assert.equal(off, icns.length);
  for (const t of ['icp4', 'icp5', 'ic07', 'ic08', 'ic09']) assert.ok(types.includes(t), `falta ${t}`);

  const png = await fs.readFile(path.join(APP, 'assets', 'nexus.png'));
  assert.deepEqual(png.subarray(0, 8), PNG_SIGNATURE);
  assert.equal(png.readUInt32BE(16), 256, 'ancho de 256 px');
});
