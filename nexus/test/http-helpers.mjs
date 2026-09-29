// Cliente HTTP y lector de SSE mínimos para probar el servidor.
import http from 'node:http';

export function request(port, { method = 'GET', path: p = '/', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path: p, headers: { Host: `127.0.0.1:${port}`, ...headers } }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

// Escucha el SSE hasta que llegue un evento que cumpla la condición.

export function waitEvent(port, predicate, timeoutMs = 6000) {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port, path: '/api/stream', headers: { Host: `127.0.0.1:${port}` } }, (res) => {
      let buf = '';
      res.on('data', (c) => {
        buf += c.toString('utf8');
        let idx;
        while ((idx = buf.indexOf('\n\n')) >= 0) {
          const block = buf.slice(0, idx);
          buf = buf.slice(idx + 2);
          const ev = /^event: (.+)$/m.exec(block);
          const data = /^data: (.+)$/m.exec(block);
          if (!ev || !data) continue;
          const payload = JSON.parse(data[1]);
          if (predicate(ev[1], payload)) {
            clearTimeout(timer);
            req.destroy();
            resolve(payload);
            return;
          }
        }
      });
    });
    const timer = setTimeout(() => { req.destroy(); reject(new Error('no llegó el evento esperado')); }, timeoutMs);
    req.on('error', () => {});
  });
}
