#!/usr/bin/env node
// Genera un único HTML autocontenido (CSS y JS en línea) a partir de web/.
//
//   node tools/build-standalone.mjs                 → dist/nexus.html (ábrelo con doble clic)
//   node tools/build-standalone.mjs --artifact      → dist/nexus-artifact.html (sin <html>/<head>/<body>,
//                                                     para publicarlo como Artifact; arranca en modo demo)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const WEB = path.join(ROOT, 'web');
const artifact = process.argv.includes('--artifact');
const out = process.argv.slice(2).find((a) => !a.startsWith('--')) || path.join(ROOT, 'dist', artifact ? 'nexus-artifact.html' : 'nexus.html');

let html = fs.readFileSync(path.join(WEB, 'index.html'), 'utf8');

html = html.replace(/<link rel="stylesheet" href="(css\/[^"]+)">/g, (_, href) => {
  const css = fs.readFileSync(path.join(WEB, href), 'utf8');
  return '<style>\n' + css + '\n</style>';
});

html = html.replace(/<script src="(js\/[^"]+)"><\/script>/g, (_, src) => {
  const js = fs.readFileSync(path.join(WEB, src), 'utf8').replace(/<\/script/gi, '<\\/script');
  return '<script>\n' + js + '\n</script>';
});

if (artifact) {
  // El visor de Artifacts añade su propio esqueleto (doctype, charset y viewport).
  const head = /<head>([\s\S]*?)<\/head>/.exec(html)[1]
    .replace(/<meta charset="utf-8">\s*/, '')
    .replace(/<meta name="viewport"[^>]*>\s*/, '');
  const body = /<body>([\s\S]*?)<\/body>/.exec(html)[1];
  html = head.trim() + '\n' + body.trim() + '\n';
}

fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, html);
console.log(`${path.relative(process.cwd(), out)} · ${(Buffer.byteLength(html) / 1024).toFixed(0)} KB`);
