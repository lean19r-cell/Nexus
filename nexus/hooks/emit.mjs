#!/usr/bin/env node
// Hook de Claude Code → NEXUS.
// Reenvía el evento al servidor local para que el panel se actualice al instante.
// Reglas: no escribe nada en stdout (Claude lo leería), no tarda y siempre sale con 0.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const args = process.argv.slice(2);
const autostart = args.includes('--autostart');
const port = Number(process.env.NEXUS_PORT || 2077);
const url = `http://127.0.0.1:${port}/api/hook`;

let input = '';
let finished = false;

function finish() {
  if (finished) return;
  finished = true;
  process.exit(0);
}

setTimeout(finish, 2500).unref();

function startServer() {
  try {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const server = path.join(here, '..', 'server.mjs');
    const home = process.env.NEXUS_HOME || path.join(os.homedir(), '.claude-nexus');
    fs.mkdirSync(home, { recursive: true });
    const log = fs.openSync(path.join(home, 'server.log'), 'a');
    const child = spawn(process.execPath, [server, '--port', String(port), '--quiet'], {
      detached: true,
      stdio: ['ignore', log, log],
      windowsHide: true
    });
    child.unref();
  } catch {
    /* sin servidor: el panel se pondrá al día al abrirlo */
  }
}

async function send() {
  let evt = {};
  try { evt = JSON.parse(input || '{}'); } catch { evt = {}; }
  const body = JSON.stringify({
    hook_event_name: evt.hook_event_name || args.find((a) => !a.startsWith('--')) || null,
    session_id: evt.session_id || null,
    transcript_path: evt.transcript_path || null,
    cwd: evt.cwd || null,
    message: typeof evt.message === 'string' ? evt.message.slice(0, 300) : null,
    notification_type: evt.notification_type || null,
    tool_name: evt.tool_name || null
  });
  try {
    await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
      signal: AbortSignal.timeout(500)
    });
  } catch {
    if (autostart && evt.hook_event_name === 'SessionStart') startServer();
  }
  finish();
}

process.stdin.setEncoding('utf8');
process.stdin.on('data', (d) => {
  if (input.length < 2_000_000) input += d;
});
process.stdin.on('end', send);
process.stdin.on('error', send);
