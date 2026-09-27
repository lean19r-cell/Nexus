import test from 'node:test';
import assert from 'node:assert/strict';
import { core, entryFactory, jsonl, memFS, T0 } from './helpers.mjs';

const DAY = 86400000;

function ingestAll(s, entries, ctx = {}) {
  for (const line of jsonl(entries).trim().split('\n')) core.ingestEntry(s, JSON.parse(line), ctx);
  return s;
}

function richSession(SID, t = T0, cwd = '/Users/demo/dev/app') {
  const f = entryFactory({ sessionId: SID, cwd });
  const read = f.toolUse('Read', { file_path: cwd + '/src/a.ts' });
  const edit = f.toolUse('Edit', { file_path: cwd + '/src/a.ts', old_string: 'x', new_string: 'y' });
  const create = f.toolUse('TaskCreate', { subject: 'Escribir tests', description: 'Cubrir el login', activeForm: 'Escribiendo tests' });
  const start = f.toolUse('TaskUpdate', { taskId: '1', status: 'in_progress' });
  const done = f.toolUse('TaskUpdate', { taskId: '1', status: 'completed' });
  const plan = f.toolUse('ExitPlanMode', { plan: '# Plan: arreglar login\n\n- [x] paso uno\n- [ ] paso dos' });
  const bash = f.toolUse('Bash', { command: 'npm test' });
  return [
    f.prompt(t, 'Arregla el login', 'prompt-1'),
    f.assistant(t + 1000, [{ type: 'thinking', thinking: '', signature: 'sig' }, read], { id: 'm1' }),
    f.result(t + 2000, read.id, 'contenido', { promptId: 'prompt-1' }),
    f.assistant(t + 3000, [plan], { id: 'm2' }),
    f.result(t + 60000, plan.id, 'User has approved your plan. You can now start coding.', {
      promptId: 'prompt-1',
      toolUseResult: { plan: '# Plan: arreglar login\n\n- [x] paso uno\n- [x] paso dos', isAgent: false, filePath: '/Users/demo/.claude/plans/happy-cat.md' }
    }),
    f.assistant(t + 61000, [create], { id: 'm3' }),
    f.result(t + 62000, create.id, 'Task #1 created successfully: Escribir tests', { toolUseResult: { task: { id: '1', subject: 'Escribir tests' } } }),
    f.assistant(t + 63000, [start, edit], { id: 'm4' }),
    f.result(t + 64000, start.id, 'Updated task #1 status', { toolUseResult: { success: true, taskId: '1', updatedFields: ['status'], statusChange: { from: 'pending', to: 'in_progress' } } }),
    f.result(t + 64500, edit.id, 'ok'),
    f.assistant(t + 65000, [done], { id: 'm5' }),
    f.result(t + 66000, done.id, 'Updated task #1 status'),
    f.assistant(t + 70000, [f.text('Listo: login arreglado.')], { id: 'm6', stop: 'end_turn' }),
    { type: 'ai-title', aiTitle: 'Arreglar login', sessionId: SID },
    { type: 'pr-link', sessionId: SID, prNumber: 7, prUrl: 'https://github.com/demo/app/pull/7', prRepository: 'demo/app', timestamp: new Date(t + 71000).toISOString() },
    f.prompt(t + 120000, '<command-message>review is running…</command-message>\n<command-name>/review</command-name>\n<command-args>src</command-args>', 'prompt-2'),
    f.assistant(t + 121000, [bash], { id: 'm7' }),
    f.result(t + 124000, bash.id, "The user doesn't want to proceed with this tool use. The tool use was rejected.", { isError: true }),
    f.prompt(t + 125000, '[Request interrupted by user for tool use]'),
    { type: 'custom-title', customTitle: 'Login v2', sessionId: SID }
  ];
}

test('parser: tandas, tokens sin duplicar, tareas, plan, PR y títulos', () => {
  const s = ingestAll(core.createSessionState('s1'), richSession('s1'));
  assert.equal(s.cwd, '/Users/demo/dev/app');
  assert.equal(s.entrypoint, 'claude-desktop');
  assert.equal(s.counts.prompts, 2);
  assert.equal(s.runs.length, 2);
  assert.equal(s.runs[0].id, 'prompt-1');
  assert.equal(s.runs[0].st, 'ok');
  assert.equal(s.runs[0].res, 'Listo: login arreglado.');
  assert.equal(s.runs[0].ed, 1);
  assert.equal(s.runs[1].src, 'command');
  assert.equal(s.runs[1].p, '/review src');
  assert.equal(s.runs[1].st, 'int');
  // m1 ocupa dos líneas (thinking + tool_use) con el mismo usage: se cuenta una vez.
  assert.equal(s.counts.messages, 7);
  assert.equal(s.tokens.out, 700);
  assert.equal(s.tokens.cr, 7000);
  assert.equal(s.counts.tools, 7);
  assert.equal(s.counts.rejections, 1);
  assert.equal(s.counts.errors, 0);
  assert.equal(s.counts.interrupts, 1);
  const task = s.tasks['1'];
  assert.equal(task.sub, 'Escribir tests');
  assert.equal(task.st, 'completed');
  assert.equal(task.ts, T0 + 63000);
  assert.equal(task.tc, T0 + 65000);
  assert.equal(s.plans.length, 1);
  assert.equal(s.plans[0].st, 'approved');
  assert.equal(s.plans[0].fp, '/Users/demo/.claude/plans/happy-cat.md');
  assert.match(s.plans[0].md, /\[x\] paso dos/);
  assert.deepEqual(core.planSteps(s.plans[0].md), { done: 2, total: 2 });
  assert.equal(s.prs.length, 1);
  assert.deepEqual(s.files, ['/Users/demo/dev/app/src/a.ts']);
  assert.equal(core.sessionTitle(s), 'Login v2');
  assert.equal(Object.keys(s._pending).length, 0);
});

test('parser: plan rechazado, errores de API, compactación, meta y comandos locales', () => {
  const f = entryFactory({ sessionId: 's2' });
  const plan = f.toolUse('ExitPlanMode', { plan: '# Plan malo' });
  const s = ingestAll(core.createSessionState('s2'), [
    f.prompt(T0, 'Planifica la migración'),
    f.meta(T0 + 10, 'Base directory for this skill: /x'),
    f.raw(T0 + 20, { type: 'user', message: { role: 'user', content: '<local-command-stdout>Model set</local-command-stdout>' } }),
    f.assistant(T0 + 1000, [plan], { id: 'p1' }),
    f.result(T0 + 2000, plan.id, "User rejected Claude's plan: usa Redis", { isError: true }),
    f.raw(T0 + 3000, { type: 'assistant', isApiErrorMessage: true, message: { id: 'err1', role: 'assistant', model: '<synthetic>', content: [{ type: 'text', text: 'API Error: 529 Overloaded' }] } }),
    f.raw(T0 + 4000, { type: 'user', isCompactSummary: true, message: { role: 'user', content: 'Resumen…' } }),
    f.raw(T0 + 5000, { type: 'system', subtype: 'compact_boundary', content: 'Conversation compacted' })
  ]);
  assert.equal(s.counts.prompts, 1, 'meta y salida de comandos locales no son tandas');
  assert.equal(s.plans[0].st, 'rejected');
  assert.equal(s.counts.errors, 1);
  assert.equal(s.counts.compactions, 2);
  assert.equal(s.model, 'claude-opus-5-5', 'el mensaje sintético de error no cambia el modelo');
});

test('parser: TodoWrite registra inicio y fin de cada ítem', () => {
  const f = entryFactory({ sessionId: 's3' });
  const s = ingestAll(core.createSessionState('s3'), [
    f.prompt(T0, 'Haz tres cosas'),
    f.assistant(T0 + 1000, [f.toolUse('TodoWrite', { todos: [{ content: 'A', status: 'in_progress', activeForm: 'Haciendo A' }, { content: 'B', status: 'pending', activeForm: 'Haciendo B' }] })]),
    f.assistant(T0 + 5000, [f.toolUse('TodoWrite', { todos: [{ content: 'A', status: 'completed', activeForm: 'Haciendo A' }, { content: 'B', status: 'in_progress', activeForm: 'Haciendo B' }] })])
  ]);
  const [a, b] = s.todos;
  assert.equal(a.s, 'completed');
  assert.equal(a.t0, T0 + 1000);
  assert.equal(a.done, T0 + 5000);
  assert.equal(b.s, 'in_progress');
  assert.equal(b.ts, T0 + 5000);
});

test('parser: el trabajo de un subagente suma a la sesión y a la tanda en curso', () => {
  const main = entryFactory({ sessionId: 's4' });
  const side = entryFactory({ sessionId: 's4', sidechain: true });
  const s = core.createSessionState('s4');
  ingestAll(s, [main.prompt(T0, 'Investiga'), main.assistant(T0 + 100, [main.toolUse('Agent', { description: 'Explorar', subagent_type: 'Explore', prompt: 'x' })], { id: 'a1' })]);
  const ctx = { sub: true };
  ingestAll(s, [
    side.prompt(T0 + 200, 'x'),
    side.assistant(T0 + 300, [side.toolUse('Grep', { pattern: 'foo' })], { id: 'sub1' }),
    side.assistant(T0 + 400, [side.toolUse('Edit', { file_path: '/Users/demo/dev/app/b.ts' })], { id: 'sub2' })
  ], ctx);
  assert.equal(s.runs.length, 1, 'el prompt del subagente no es una tanda');
  assert.equal(s.counts.subagents, 1);
  assert.equal(s.runs[0].tools, 3);
  assert.equal(s.runs[0].ed, 1);
  assert.ok(!s.feed.some((e) => /Busca/.test(e.x)), 'las lecturas del subagente no ensucian el registro');
  assert.ok(s.feed.some((e) => e.sub && /Edita/.test(e.x)));
});

function seedFS(fs) {
  const dir = 'projects/-Users-demo-dev-app';
  fs.set(`${dir}/s1.jsonl`, jsonl(richSession('s1')));
  fs.set('tasks/s1/1.json', JSON.stringify({ id: '1', subject: 'Escribir tests', description: '', activeForm: 'Escribiendo tests', status: 'completed', blocks: ['2'], blockedBy: [] }));
  fs.set('tasks/s1/2.json', JSON.stringify({ id: '2', subject: 'Desplegar', description: '', activeForm: 'Desplegando', status: 'pending', blocks: [], blockedBy: ['3'] }));
  fs.set('tasks/s1/3.json', JSON.stringify({ id: '3', subject: 'Revisar CI', description: '', activeForm: 'Revisando CI', status: 'in_progress', blocks: ['2'], blockedBy: [] }));
  fs.set('tasks/s1/.lock', '');
  // El archivo del plan se editó después de aprobarlo: su texto es el más reciente.
  fs.set('plans/happy-cat.md', '# Plan: arreglar login\n\n- [x] paso uno\n- [x] paso dos\n- [ ] paso tres', T0 + 200000);
  fs.set('plans/suelto.md', '# Plan huérfano\n\n- [ ] algo');
  return dir;
}

test('collector: lectura incremental, líneas a medias y reescrituras', async () => {
  const fs = memFS();
  const dir = 'projects/-Users-demo-dev-app';
  const f = entryFactory({ sessionId: 's9' });
  const first = jsonl([f.prompt(T0, 'uno'), f.assistant(T0 + 10, [f.text('hecho')], { id: 'x1', stop: 'end_turn' })]);
  fs.set(`${dir}/s9.jsonl`, first);
  const col = new core.Collector(fs, { now: fs.now });
  let ch = await col.scan({ full: true });
  assert.deepEqual(ch.sessions, ['s9']);
  assert.equal(col.sessions.s9.runs.length, 1);

  // Una línea a medio escribir no se procesa hasta que llega el salto de línea.
  const next = JSON.stringify(f.prompt(T0 + 100, 'dos'));
  fs.append(`${dir}/s9.jsonl`, next.slice(0, 25));
  await col.scan();
  assert.equal(col.sessions.s9.runs.length, 1);
  fs.append(`${dir}/s9.jsonl`, next.slice(25) + '\n');
  ch = await col.scan();
  assert.deepEqual(ch.sessions, ['s9']);
  assert.equal(col.sessions.s9.runs.length, 2);
  assert.equal(col.meta.badLines, 0);

  // Sin cambios: nada que publicar.
  ch = await col.scan();
  assert.deepEqual(ch.sessions, []);

  // Archivo reescrito más corto: la sesión se reconstruye desde cero.
  fs.set(`${dir}/s9.jsonl`, jsonl([f.prompt(T0, 'solo uno')]));
  ch = await col.scan();
  assert.deepEqual(ch.rebuild, ['s9']);
  assert.equal(col.sessions.s9.runs.length, 1);
  assert.equal(col.sessions.s9.runs[0].p, 'solo uno');
});

test('collector: subagentes (layout nuevo y antiguo), tareas, planes y registro vivo', async () => {
  const fs = memFS();
  const dir = seedFS(fs);
  const side = entryFactory({ sessionId: 's1', sidechain: true });
  fs.set(`${dir}/s1/subagents/agent-a1.jsonl`, jsonl([side.assistant(T0 + 1500, [side.toolUse('Bash', { command: 'ls' })], { id: 'sa1' })]));
  fs.set(`${dir}/agent-old.jsonl`, jsonl([side.assistant(T0 + 1600, [side.toolUse('Bash', { command: 'pwd' })], { id: 'sa2' })]));
  fs.set('sessions/4242.json', JSON.stringify({ pid: 4242, sessionId: 's1', cwd: '/Users/demo/dev/app', status: 'waiting', waitingFor: 'input needed', entrypoint: 'claude-desktop', startedAt: T0, updatedAt: T0, statusUpdatedAt: T0 + 5000 }));
  fs.set('sessions/4242.10c1.key', 'x');
  const col = new core.Collector(fs, { now: fs.now });
  await col.scan({ full: true });
  const s = col.sessions.s1;
  assert.equal(s.counts.tools, 9, '7 propias + 1 del subagente nuevo + 1 del antiguo');
  assert.equal(Object.keys(col.taskLists.s1.tasks).length, 3);
  assert.equal(col.plans['happy-cat.md'].title, 'Plan: arreglar login');
  assert.equal(col.live.s1.status, 'waiting');

  const m = core.buildModel(col.snapshot(), {}, T0 + 10 * 60000);
  const sv = m.sessionMap.s1;
  assert.equal(sv.state, 'waiting');
  assert.equal(core.waitPhrase(sv.waitingFor), 'Espera tu respuesta');
  assert.equal(sv.origin, 'DESKTOP');
  const byId = Object.fromEntries(m.tasks.filter((t) => t.source === 'task').map((t) => [t.id, t]));
  assert.equal(byId['1'].status, 'completed');
  assert.equal(byId['1'].completedAt, T0 + 65000, 'la hora de completado sale de la transcripción');
  assert.equal(byId['2'].blocked, true, 'bloqueada por #3, que sigue abierta');
  assert.equal(byId['3'].blocked, false);
  assert.equal(m.kpis.waiting, 1);
  assert.equal(m.kpis.tasksBlocked, 1);
  // El plan del archivo se une al de la sesión (mismo filePath) y trae el texto más nuevo.
  const linked = m.plans.find((p) => p.sessionId === 's1');
  assert.equal(linked.status, 'approved');
  assert.deepEqual(linked.steps, { done: 2, total: 3 });
  const orphan = m.plans.find((p) => p.file === 'suelto.md');
  assert.equal(orphan.status, 'draft');
  assert.equal(orphan.key, null);
});

test('collector: conserva el historial cuando Claude Code borra archivos', async () => {
  const fs = memFS();
  const dir = seedFS(fs);
  const col = new core.Collector(fs, { now: fs.now });
  await col.scan({ full: true });
  fs.remove(`${dir}/s1.jsonl`);
  fs.remove('tasks/s1');
  fs.remove('plans/happy-cat.md');
  const ch = await col.scan({ full: true });
  assert.deepEqual(ch.sessions, ['s1']);
  assert.equal(col.sessions.s1.archived, true);
  assert.equal(col.taskLists.s1.archived, true);
  assert.equal(col.plans['happy-cat.md'].archived, true);
  const m = core.buildModel(col.snapshot(), {}, T0 + 60 * DAY);
  assert.equal(m.sessions.length, 1);
  assert.ok(m.tasks.filter((t) => t.status !== 'completed').every((t) => t.stale), 'lo abierto de listas borradas cuenta como abandonado');
  assert.equal(m.kpis.tasksOpen, 0);
});

test('collector: exportar e importar el estado evita releer los archivos', async () => {
  const fs = memFS();
  seedFS(fs);
  const a = new core.Collector(fs, { now: fs.now });
  await a.scan({ full: true });
  const index = JSON.parse(JSON.stringify(a.exportIndex()));
  const sessions = JSON.parse(JSON.stringify(a.sessions));
  const b = new core.Collector(fs, { now: fs.now });
  assert.equal(b.importState(index, sessions), true);
  const ch = await b.scan({ full: true });
  assert.deepEqual(ch.sessions, []);
  assert.equal(b.meta.bytes, 0, 'no se leyó ningún byte de transcripciones');
  const ma = core.buildModel(a.snapshot(), {}, T0 + 3600000);
  const mb = core.buildModel(b.snapshot(), {}, T0 + 3600000);
  assert.deepEqual(mb.kpis, ma.kpis);
});

test('modelo: worktrees, alias, categorías, nombres repetidos y tareas abandonadas', () => {
  const mk = (id, cwd, t, extra) => {
    const f = entryFactory({ sessionId: id, cwd });
    const s = ingestAll(core.createSessionState(id), [f.prompt(t, 'hola'), f.assistant(t + 1000, [f.text('ok')], { id: 'x' + id, stop: 'end_turn' })]);
    return Object.assign(core.publicSession(s), extra || {});
  };
  const now = T0 + 10 * DAY;
  const old = mk('old', '/Users/demo/dev/app', T0, { todos: [{ c: 'algo viejo', s: 'pending', t0: T0, t1: T0 }] });
  const data = {
    sessions: {
      a: mk('a', '/Users/demo/dev/app', now - 3600000),
      b: mk('b', '/Users/demo/dev/app/.claude/worktrees/feat-x', now - 1800000),
      c: mk('c', '/Users/demo/youtube/ep-12', now - 7200000),
      d: mk('d', '/Users/demo/clientes/app', now - 7200000),
      e: mk('e', '/Users/demo/scratch/montaje-final', now - 7200000),
      old: old
    },
    taskLists: {}, plans: {}, live: {}
  };
  let m = core.buildModel(data, {}, now);
  const app = m.projectMap['/Users/demo/dev/app'];
  assert.equal(app.sessions.length, 3, 'el worktree se agrupa con su repositorio');
  assert.equal(m.projectMap['/Users/demo/youtube/ep-12'].category, 'video');
  assert.equal(m.projectMap['/Users/demo/scratch/montaje-final'].category, 'video');
  assert.equal(app.category, 'dev');
  assert.equal(app.name, 'app · dev');
  assert.equal(m.projectMap['/Users/demo/clientes/app'].name, 'app · clientes');
  const stale = m.tasks.find((t) => t.subject === 'algo viejo');
  assert.equal(stale.stale, true);
  assert.equal(m.kpis.tasksOpen, 0);
  assert.equal(m.kpis.tasksStale, 1);

  m = core.buildModel(data, {
    projects: { '/Users/demo/dev/app': { name: 'Finanzas', category: 'ops', stage: 'Deploy', pinned: true } },
    aliases: { '/Users/demo/clientes/app': '/Users/demo/dev/app' }
  }, now);
  const merged = m.projectMap['/Users/demo/dev/app'];
  assert.equal(merged.name, 'Finanzas');
  assert.equal(merged.category, 'ops');
  assert.equal(merged.stage, 'Deploy');
  assert.equal(merged.sessions.length, 4);
  assert.equal(m.projectMap['/Users/demo/clientes/app'], undefined);
  assert.equal(m.projects[0].key, '/Users/demo/dev/app', 'los proyectos fijados van primero');
});

test('modelo: estado inferido sin registro vivo', () => {
  const f = entryFactory({ sessionId: 'z' });
  const s = ingestAll(core.createSessionState('z'), [f.prompt(T0, 'x'), f.assistant(T0 + 1000, [f.toolUse('Bash', { command: 'sleep 1' })], { id: 'z1' })]);
  assert.equal(core.inferState(s, null, T0 + 30000), 'working');
  assert.equal(core.inferState(s, null, T0 + 3 * 60000), 'idle');
  assert.equal(core.inferState(s, null, T0 + 60 * 60000), 'ended');
  assert.equal(core.inferState(s, { status: 'busy', verified: true, via: 'registry' }, T0 + 60 * 60000), 'working');
  assert.equal(core.inferState(s, { status: 'busy', verified: false, via: 'registry', statusAt: T0, updatedAt: T0 }, T0 + 2 * 3600000), 'ended', 'registro sin PID verificado y sin movimiento: sesión muerta');
});

test('formato: tokens, duraciones y tiempos relativos', () => {
  assert.deepEqual([0, 999, 1000, 1234, 12345, 999499, 999950, 1e6, 12345678, 2.5e9].map(core.fmtTok),
    ['0', '999', '1K', '1,23K', '12,3K', '999K', '1M', '1M', '12,3M', '2,5B']);
  assert.equal(core.fmtDur(45000), '45 s');
  assert.equal(core.fmtDur(3 * 3600000 + 5 * 60000), '3 h 5 min');
  assert.equal(core.fmtAgo(T0 - 5000, T0), 'ahora');
  assert.equal(core.fmtAgo(T0 - 5 * 60000, T0), 'hace 5 min');
  assert.equal(core.fmtAgo(T0 - 30 * 3600000, T0), 'ayer');
});

test('markdown: escapa HTML y enlaces peligrosos', () => {
  const html = core.renderMarkdown('# Título <img src=x onerror=alert(1)>\n\n<script>alert(1)</script>\n\n[mal](javascript:alert(1)) [bien](https://example.com)\n\n- [x] hecho\n- [ ] pendiente\n\n```js\nconst a = "<b>";\n```\n\n| a | b |\n|---|---|\n| 1 | <i>2</i> |');
  assert.ok(!/<script|<img|<i>/.test(html), html);
  assert.ok(!/href="javascript/.test(html));
  assert.match(html, /<a href="https:\/\/example.com"/);
  assert.match(html, /<li class="task done">/);
  assert.match(html, /<pre><code data-lang="js">const a = &quot;&lt;b&gt;&quot;;/);
  assert.match(html, /<table>/);
});
