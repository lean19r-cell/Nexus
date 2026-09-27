// Adaptador de sistema de archivos para el Collector de core.js (Node ≥ 18).
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

export function defaultClaudeDir() {
  if (process.env.CLAUDE_CONFIG_DIR) return path.resolve(process.env.CLAUDE_CONFIG_DIR);
  return path.join(os.homedir(), '.claude');
}

export function nexusHome() {
  if (process.env.NEXUS_HOME) return path.resolve(process.env.NEXUS_HOME);
  return path.join(os.homedir(), '.claude-nexus');
}

export function createNodeAdapter(root) {
  const abs = (rel) => path.join(root, ...String(rel).split('/'));
  return {
    root,
    async list(rel) {
      try {
        const entries = await fsp.readdir(abs(rel), { withFileTypes: true });
        return entries.map((e) => ({ name: e.name, dir: e.isDirectory() }));
      } catch {
        return [];
      }
    },
    async stat(rel) {
      try {
        const st = await fsp.stat(abs(rel));
        return { size: st.size, mtime: Math.floor(st.mtimeMs) };
      } catch {
        return null;
      }
    },
    async read(rel, start, max) {
      let fh;
      try {
        fh = await fsp.open(abs(rel), 'r');
        const buf = Buffer.allocUnsafe(Math.max(0, max));
        const { bytesRead } = await fh.read(buf, 0, buf.length, start);
        return new Uint8Array(buf.buffer, buf.byteOffset, bytesRead);
      } catch {
        return new Uint8Array(0);
      } finally {
        if (fh) await fh.close().catch(() => {});
      }
    },
    isAlive(pid) {
      if (!pid || pid < 1) return undefined;
      try {
        process.kill(pid, 0);
        return true;
      } catch (err) {
        // EPERM: el proceso existe pero es de otro usuario.
        return err && err.code === 'EPERM';
      }
    },
    exists(rel) {
      return fs.existsSync(abs(rel));
    }
  };
}
