// Utilidades de prueba: transcripciones sintéticas con la forma real de Claude Code 2.1.x
// y un sistema de archivos en memoria para el Collector.
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
export const core = require('../web/js/core.js');

export const T0 = Date.UTC(2026, 8, 27, 9, 0, 0); // 27 sep 2026, 09:00 UTC

let uid = 0;
export function nextId(prefix = 'u') {
  uid += 1;
  return `${prefix}-${String(uid).padStart(6, '0')}`;
}

export function iso(ms) {
  return new Date(ms).toISOString();
}

export function entryFactory({ sessionId, cwd = '/Users/demo/dev/app', gitBranch = 'main', entrypoint = 'claude-desktop', sidechain = false }) {
  const base = (t, over) => ({
    parentUuid: null,
    isSidechain: sidechain,
    userType: 'external',
    cwd,
    sessionId,
    version: '2.1.283',
    gitBranch,
    entrypoint,
    timestamp: iso(t),
    uuid: nextId('uuid'),
    ...over
  });
  return {
    prompt(t, text, promptId = nextId('prompt'), extra = {}) {
      return base(t, { type: 'user', promptId, origin: { kind: 'human' }, permissionMode: 'default', message: { role: 'user', content: text }, ...extra });
    },
    meta(t, text) {
      return base(t, { type: 'user', isMeta: true, message: { role: 'user', content: text } });
    },
    // Una respuesta del modelo se escribe como una línea por bloque, repitiendo id y usage.
    assistant(t, blocks, { id = nextId('msg'), usage = { input_tokens: 10, output_tokens: 100, cache_read_input_tokens: 1000, cache_creation_input_tokens: 50 }, stop = 'tool_use', model = 'claude-opus-5-5' } = {}) {
      return blocks.map((b, i) => base(t + i, {
        type: 'assistant',
        requestId: 'req_' + id,
        message: { model, id, type: 'message', role: 'assistant', content: [b], stop_reason: stop, stop_sequence: null, usage }
      }));
    },
    toolUse(name, input, id = nextId('toolu')) {
      return { type: 'tool_use', id, name, input };
    },
    text(text) {
      return { type: 'text', text };
    },
    result(t, toolUseId, content, { isError = false, toolUseResult, promptId } = {}) {
      const e = base(t, { type: 'user', message: { role: 'user', content: [{ tool_use_id: toolUseId, type: 'tool_result', content, is_error: isError }] } });
      if (toolUseResult !== undefined) e.toolUseResult = toolUseResult;
      if (promptId) e.promptId = promptId;
      return e;
    },
    raw(t, obj) {
      return base(t, obj);
    }
  };
}

export function jsonl(entries) {
  return entries.flat().map((e) => JSON.stringify(e)).join('\n') + '\n';
}

/** Sistema de archivos en memoria compatible con el adaptador del Collector. */
export function memFS() {
  const files = new Map();
  let clock = T0;
  const fs = {
    files,
    // Reloj del sistema simulado, para pasarlo al Collector ({ now: fs.now }).
    now: () => clock,
    set(rel, content, mtime) {
      files.set(rel, { data: Buffer.from(content), mtime: mtime || (clock += 1000) });
    },
    append(rel, content, mtime) {
      const cur = files.get(rel);
      const data = cur ? Buffer.concat([cur.data, Buffer.from(content)]) : Buffer.from(content);
      files.set(rel, { data, mtime: mtime || (clock += 1000) });
    },
    remove(rel) {
      for (const k of [...files.keys()]) if (k === rel || k.startsWith(rel + '/')) files.delete(k);
    },
    async list(rel) {
      const prefix = rel ? rel + '/' : '';
      const out = new Map();
      for (const k of files.keys()) {
        if (!k.startsWith(prefix)) continue;
        const rest = k.slice(prefix.length).split('/');
        const dir = rest.length > 1;
        if (!out.has(rest[0]) || dir) out.set(rest[0], dir);
      }
      return [...out].map(([name, dir]) => ({ name, dir }));
    },
    async stat(rel) {
      const f = files.get(rel);
      return f ? { size: f.data.length, mtime: f.mtime } : null;
    },
    async read(rel, start, max) {
      const f = files.get(rel);
      if (!f) return new Uint8Array(0);
      const b = f.data.subarray(start, start + max);
      return new Uint8Array(b.buffer, b.byteOffset, b.length);
    }
  };
  return fs;
}
