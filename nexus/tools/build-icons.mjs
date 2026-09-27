#!/usr/bin/env node
// Genera los iconos del acceso directo a partir de assets/icon.svg:
//   assets/nexus.png   (256 px, Linux)
//   assets/nexus.ico   (Windows; PNG dentro de ICO, 16–256 px)
//   assets/nexus.icns  (macOS; PNG dentro de ICNS, 16–512 px)
// Solo hace falta al cambiar el diseño. Necesita Playwright para rasterizar el SVG:
//   NODE_PATH=$(npm root -g) node tools/build-icons.mjs
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ASSETS = path.join(ROOT, 'assets');
const require = createRequire(import.meta.url);

export function buildIco(images) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); // reservado
  header.writeUInt16LE(1, 2); // 1 = icono
  header.writeUInt16LE(images.length, 4);
  let offset = 6 + 16 * images.length;
  const entries = images.map(({ size, png }) => {
    const e = Buffer.alloc(16);
    e.writeUInt8(size >= 256 ? 0 : size, 0); // 0 significa 256
    e.writeUInt8(size >= 256 ? 0 : size, 1);
    e.writeUInt8(0, 2); // sin paleta
    e.writeUInt8(0, 3);
    e.writeUInt16LE(1, 4); // planos
    e.writeUInt16LE(32, 6); // bits por píxel
    e.writeUInt32LE(png.length, 8);
    e.writeUInt32LE(offset, 12);
    offset += png.length;
    return e;
  });
  return Buffer.concat([header, ...entries, ...images.map((i) => i.png)]);
}

// Tipos ICNS que aceptan PNG (macOS 10.7+). macOS elige por tamaño en píxeles, así que las
// variantes @2x (ic11–ic14) serían copias de estas mismas imágenes; 512 px basta para un acceso directo.
export const ICNS_TYPES = [['icp4', 16], ['icp5', 32], ['icp6', 64], ['ic07', 128], ['ic08', 256], ['ic09', 512]];

export function buildIcns(images) {
  const chunks = images.map(({ type, png }) => {
    const h = Buffer.alloc(8);
    h.write(type, 0, 'ascii');
    h.writeUInt32BE(png.length + 8, 4);
    return Buffer.concat([h, png]);
  });
  const header = Buffer.alloc(8);
  header.write('icns', 0, 'ascii');
  header.writeUInt32BE(8 + chunks.reduce((n, c) => n + c.length, 0), 4);
  return Buffer.concat([header, ...chunks]);
}

async function render(svg, sizes) {
  const { chromium } = require('playwright');
  const browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
  const out = {};
  try {
    for (const size of sizes) {
      const page = await browser.newPage({ viewport: { width: size, height: size } });
      await page.setContent(`<html><body style="margin:0;background:transparent">${svg.replace('width="1024" height="1024"', `width="${size}" height="${size}"`)}</body></html>`);
      out[size] = await page.screenshot({ omitBackground: true, clip: { x: 0, y: 0, width: size, height: size } });
      await page.close();
    }
  } finally {
    await browser.close();
  }
  return out;
}

async function main() {
  const svg = fs.readFileSync(path.join(ASSETS, 'icon.svg'), 'utf8');
  const sizes = [16, 24, 32, 48, 64, 128, 256, 512];
  const png = await render(svg, sizes);
  fs.writeFileSync(path.join(ASSETS, 'nexus.png'), png[256]);
  fs.writeFileSync(path.join(ASSETS, 'nexus.ico'), buildIco([16, 24, 32, 48, 64, 128, 256].map((size) => ({ size, png: png[size] }))));
  fs.writeFileSync(path.join(ASSETS, 'nexus.icns'), buildIcns(ICNS_TYPES.map(([type, size]) => ({ type, png: png[size] }))));
  for (const f of ['nexus.png', 'nexus.ico', 'nexus.icns']) {
    console.log(`assets/${f} · ${(fs.statSync(path.join(ASSETS, f)).size / 1024).toFixed(0)} KB`);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error(err && err.message ? err.message : err);
    process.exit(1);
  });
}
