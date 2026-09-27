/*!
 * NEXUS core — parser, colector y agregador de la actividad de Claude Code.
 *
 * Este archivo es isomórfico: se carga como <script> clásico en el navegador
 * (expone window.NexusCore) y con require() en Node (module.exports).
 * No tiene dependencias.
 *
 * Fuentes que entiende (todas dentro de ~/.claude):
 *   projects/<dir>/<sessionId>.jsonl                  transcripción de cada sesión
 *   projects/<dir>/<sessionId>/subagents/agent-*.jsonl  subagentes (layout nuevo)
 *   projects/<dir>/agent-*.jsonl                       subagentes (layout antiguo)
 *   tasks/<listId>/<taskId>.json                       tareas (TaskCreate/TaskUpdate)
 *   plans/<slug>.md                                    planes del modo plan
 *   sessions/<pid>.json                                registro de sesiones vivas
 */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.NexusCore = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var VERSION = '1.0.0';
  var STATE_VERSION = 3;

  var LIMITS = {
    runs: 250,        // tandas guardadas por sesión
    feed: 40,         // eventos recientes por sesión
    files: 300,       // archivos tocados por sesión
    runFiles: 40,     // archivos tocados por tanda
    plans: 40,        // planes por sesión
    todos: 150,       // ítems de TodoWrite
    prompt: 700,      // caracteres de un prompt
    result: 500,      // caracteres de la respuesta final de una tanda
    planMd: 120000,   // caracteres de un plan
    planFile: 262144, // bytes leídos de un archivo de plan
    taskFile: 65536,  // bytes leídos de un archivo de tarea
    liveFile: 65536,  // bytes leídos de un archivo de sesión viva
    chunk: 4 * 1024 * 1024
  };

  var HOT_WINDOW = 3 * 60 * 60 * 1000; // archivos tocados en las últimas 3 h se vigilan en cada pasada

  // ───────────────────────────────────────────────────────────── utilidades

  function toMs(ts) {
    if (typeof ts === 'number' && isFinite(ts)) return ts > 1e12 ? ts : ts * 1000;
    if (typeof ts === 'string' && ts) {
      var n = Date.parse(ts);
      return isFinite(n) ? n : 0;
    }
    return 0;
  }

  function trunc(s, n) {
    if (typeof s !== 'string') return '';
    return s.length > n ? s.slice(0, n - 1) + '…' : s;
  }

  function oneLine(s) {
    return typeof s === 'string' ? s.replace(/\s+/g, ' ').trim() : '';
  }

  function normPath(p) {
    if (!p || typeof p !== 'string') return '';
    var x = p.replace(/\\/g, '/');
    if (/^[A-Za-z]:\//.test(x)) x = x[0].toLowerCase() + x.slice(1);
    if (x.length > 1) x = x.replace(/\/+$/, '');
    return x;
  }

  function baseName(p) {
    var x = normPath(p);
    if (!x) return '';
    var parts = x.split('/').filter(Boolean);
    return parts.length ? parts[parts.length - 1] : x;
  }

  function shortPath(p, segs) {
    var x = normPath(p);
    if (!x) return '';
    var parts = x.split('/').filter(Boolean);
    return parts.slice(-(segs || 2)).join('/');
  }

  // Agrupa worktrees (<repo>/.claude/worktrees/<nombre>) bajo el repo principal.
  function projectKeyFromCwd(cwd) {
    var p = normPath(cwd);
    if (!p) return '';
    var m = /^(.*?)\/\.claude\/worktrees\/[^/]+/.exec(p) || /^(.*?)\/\.worktrees\/[^/]+/.exec(p);
    if (m && m[1]) return m[1];
    return p;
  }

  function hostOf(url) {
    var m = /^[a-z]+:\/\/([^/?#]+)/i.exec(url || '');
    return m ? m[1] : trunc(url || '', 40);
  }

  function has(o, k) { return Object.prototype.hasOwnProperty.call(o, k); }

  function values(o) {
    var out = [];
    for (var k in o) if (has(o, k)) out.push(o[k]);
    return out;
  }

  function normStatus(st) {
    if (st === 'in_progress' || st === 'completed' || st === 'pending') return st;
    if (st === 'done' || st === 'complete') return 'completed';
    if (st === 'active' || st === 'running') return 'in_progress';
    return 'pending';
  }

  function textOf(content) {
    if (typeof content === 'string') return content;
    if (!Array.isArray(content)) return '';
    var out = [];
    for (var i = 0; i < content.length; i++) {
      var b = content[i];
      if (!b) continue;
      if (typeof b === 'string') out.push(b);
      else if (b.type === 'text' && typeof b.text === 'string') out.push(b.text);
      else if (b.type === 'image') out.push('[imagen]');
    }
    return out.join('\n');
  }

  function cleanPrompt(text) {
    return oneLine(String(text || '')
      .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, ' ')
      .replace(/<ide_[a-z_]+>[\s\S]*?<\/ide_[a-z_]+>/g, ' ')
      .replace(/<user-prompt-submit-hook>[\s\S]*?<\/user-prompt-submit-hook>/g, ' '));
  }

  function planTitle(md) {
    if (typeof md !== 'string') return 'Plan';
    var lines = md.split('\n');
    for (var i = 0; i < lines.length; i++) {
      var l = lines[i].trim();
      if (!l) continue;
      l = l.replace(/^#+\s*/, '').replace(/[*_`]/g, '').trim();
      if (l) return trunc(l, 140);
    }
    return 'Plan';
  }

  function planSteps(md) {
    if (typeof md !== 'string') return null;
    var done = (md.match(/^\s*[-*+]\s+\[[xX]\]/gm) || []).length;
    var open = (md.match(/^\s*[-*+]\s+\[ \]/gm) || []).length;
    return done + open ? { done: done, total: done + open } : null;
  }

  var ORIGINS = {
    'claude-desktop': 'DESKTOP', 'claude-desktop-3p': 'DESKTOP', 'remote_desktop': 'DESKTOP·NUBE',
    'cli': 'CLI', 'claude-vscode': 'VS CODE', 'claude-jetbrains': 'JETBRAINS',
    'remote_mobile': 'MÓVIL', 'local-agent': 'COWORK', 'remote_cowork': 'COWORK',
    'sdk-ts': 'SDK', 'sdk-py': 'SDK', 'sdk-cli': 'SDK', 'print': 'CLI -p',
    'github-action': 'GITHUB', 'claude-code-github-action': 'GITHUB',
    'claude-in-slack': 'SLACK', 'claude_in_slack': 'SLACK', 'remote_trigger': 'RUTINA', 'mcp': 'MCP'
  };

  function originLabel(ep) {
    if (!ep) return '—';
    if (has(ORIGINS, ep)) return ORIGINS[ep];
    if (/^remote/.test(ep)) return 'NUBE';
    return String(ep).toUpperCase();
  }

  var STATUS_ES = { pending: 'pendiente', in_progress: 'en curso', completed: 'completada', deleted: 'eliminada' };

  // Motivo de espera del registro de sesiones vivas (~/.claude/sessions) → frase legible.
  var WAIT_ES = {
    'input needed': 'Espera tu respuesta',
    'dialog open': 'Espera en un diálogo (permiso o pregunta)',
    'worker request': 'Espera que respondas a un agente',
    'sandbox request': 'Espera un permiso de sandbox',
    'goal proposal': 'Espera que apruebes su propuesta'
  };

  function waitPhrase(w) {
    if (!w) return 'Espera tu respuesta';
    if (has(WAIT_ES, w)) return WAIT_ES[w];
    return String(w).length > 24 || /\s\S+\s/.test(String(w)) ? String(w) : 'Espera: ' + w;
  }

  function describeTool(name, input) {
    var i = input || {};
    switch (name) {
      case 'Read': return 'Lee ' + shortPath(i.file_path);
      case 'Edit': case 'MultiEdit': return 'Edita ' + shortPath(i.file_path);
      case 'Write': return 'Escribe ' + shortPath(i.file_path);
      case 'NotebookEdit': return 'Edita notebook ' + shortPath(i.notebook_path);
      case 'Bash': return '$ ' + trunc(oneLine(i.command), 90);
      case 'BashOutput': return 'Lee salida de proceso';
      case 'KillShell': case 'KillBash': return 'Detiene proceso';
      case 'Grep': return 'Busca «' + trunc(String(i.pattern || ''), 40) + '»';
      case 'Glob': return 'Explora ' + trunc(String(i.pattern || ''), 50);
      case 'LS': return 'Lista ' + shortPath(i.path);
      case 'WebFetch': return 'Web ' + hostOf(i.url);
      case 'WebSearch': return 'Busca en la web «' + trunc(String(i.query || ''), 50) + '»';
      case 'Task': case 'Agent': return 'Agente ' + (i.subagent_type ? '[' + i.subagent_type + '] ' : '') + trunc(oneLine(i.description || ''), 60);
      case 'TodoWrite': return 'Actualiza su lista de tareas';
      case 'TaskCreate': return 'Nueva tarea «' + trunc(oneLine(i.subject || ''), 60) + '»';
      case 'TaskUpdate': return 'Tarea #' + i.taskId + (i.status ? ' → ' + (STATUS_ES[i.status] || i.status) : ' actualizada');
      case 'TaskList': return 'Revisa la lista de tareas';
      case 'TaskGet': return 'Consulta tarea #' + i.taskId;
      case 'ExitPlanMode': return 'Presenta un plan para aprobación';
      case 'EnterPlanMode': return 'Entra en modo plan';
      case 'Skill': return 'Skill ' + (i.skill || i.command || i.name || '');
      case 'SlashCommand': return 'Comando ' + (i.command || '');
      case 'AskUserQuestion': return 'Te hace una pregunta';
      default:
        if (typeof name === 'string' && name.indexOf('mcp__') === 0) {
          var parts = name.split('__');
          return 'MCP ' + parts[1] + ' · ' + parts.slice(2).join('__');
        }
        return String(name || 'herramienta');
    }
  }

  var MEDIA_CMD = /\b(ffmpeg|ffprobe|yt-dlp|youtube-dl|whisper|remotion|melt|handbrake|magick|imagemagick|sox|auto-editor|mediainfo)\b/i;
  var MEDIA_FILE = /\.(mp4|mov|mkv|webm|avi|m4a|mp3|wav|flac|aac|srt|vtt|ass|psd|prproj|drp|aep|fcpxml|kdenlive)$/i;

  // ───────────────────────────────────────────────────────────── parser de sesiones

  function createSessionState(id) {
    return {
      v: STATE_VERSION,
      id: id,
      dir: null,
      cwd: null,
      cwd0: null,
      gitBranch: null,
      version: null,
      entrypoint: null,
      permissionMode: null,
      slug: null,
      aiTitle: null,
      customTitle: null,
      summary: null,
      tag: null,
      agentName: null,
      firstPrompt: null,
      lastPrompt: null,
      startedAt: 0,
      updatedAt: 0,
      model: null,
      models: {},
      counts: { prompts: 0, messages: 0, tools: 0, errors: 0, edits: 0, bash: 0, subagents: 0, compactions: 0, interrupts: 0, rejections: 0 },
      tokens: { in: 0, out: 0, cr: 0, cw: 0 },
      tools: {},
      files: [],
      runs: [],
      todos: null,
      todosAt: 0,
      tasks: {},
      plans: [],
      prs: [],
      feed: [],
      last: null,
      tail: null,
      stopReason: null,
      signals: { media: 0 },
      act: {},
      archived: false,
      _pending: {}
    };
  }

  // Actividad por hora (herramientas y tokens) de las últimas 72 h: alimenta el gráfico de 24 h
  // sin atribuir todo el trabajo de una tanda larga a la hora en que empezó.
  function bumpAct(s, t, tools, tokens) {
    if (!t) return;
    if (!s.act) s.act = {};
    var h = Math.floor(t / 3600000);
    var k = String(h);
    var a = s.act[k] || (s.act[k] = [0, 0]);
    a[0] += tools;
    a[1] += tokens;
    if (!s._actMax || h > s._actMax) {
      s._actMax = h;
      for (var key in s.act) if (has(s.act, key) && +key < h - 72) delete s.act[key];
    }
  }

  function touch(s, t) {
    if (!t) return;
    if (!s.startedAt || t < s.startedAt) s.startedAt = t;
    if (t > s.updatedAt) s.updatedAt = t;
  }

  function addFeed(s, t, k, x, sub) {
    var ev = { t: t || s.updatedAt, k: k, x: trunc(String(x || ''), 160) };
    if (sub) ev.sub = 1;
    s.feed.push(ev);
    if (s.feed.length > LIMITS.feed) s.feed.splice(0, s.feed.length - LIMITS.feed);
    if (!s.last || ev.t >= s.last.t) s.last = ev;
  }

  function addFile(list, p, cap) {
    var x = normPath(p);
    if (!x) return;
    var i = list.indexOf(x);
    if (i >= 0) list.splice(i, 1);
    list.push(x);
    if (list.length > cap) list.splice(0, list.length - cap);
  }

  function currentRun(s) {
    return s.runs.length ? s.runs[s.runs.length - 1] : null;
  }

  function runById(s, id) {
    if (!id) return null;
    for (var i = s.runs.length - 1; i >= 0; i--) if (s.runs[i].id === id) return s.runs[i];
    return null;
  }

  // La tanda que estaba en marcha en el instante t (para atribuir trabajo de subagentes).
  function runAt(s, t) {
    var r = s.runs;
    if (!r.length) return null;
    if (!t) return r[r.length - 1];
    var lo = 0, hi = r.length - 1, ans = -1;
    while (lo <= hi) {
      var mid = (lo + hi) >> 1;
      if (r[mid].t <= t) { ans = mid; lo = mid + 1; } else hi = mid - 1;
    }
    return ans >= 0 ? r[ans] : null;
  }

  function startRun(s, run) {
    var prev = currentRun(s);
    if (prev && prev.st === 'run') prev.st = 'ok';
    // Herramientas que nunca recibieron resultado (p. ej. interrumpidas) ya no importan.
    for (var id in s._pending) {
      if (has(s._pending, id) && s._pending[id].t < run.t - 30 * 60 * 1000) delete s._pending[id];
    }
    s.runs.push(run);
    if (s.runs.length > LIMITS.runs) s.runs.splice(0, s.runs.length - LIMITS.runs);
  }

  function applyTodos(s, todos, t) {
    if (!Array.isArray(todos)) return;
    var prev = {};
    (s.todos || []).forEach(function (x) { prev[x.c] = x; });
    var next = [];
    for (var i = 0; i < todos.length && next.length < LIMITS.todos; i++) {
      var td = todos[i];
      if (!td || typeof td !== 'object') continue;
      var c = trunc(oneLine(String(td.content || td.subject || '')), 300);
      if (!c) continue;
      var st = normStatus(td.status);
      var old = has(prev, c) ? prev[c] : null;
      var item = { c: c, s: st, t0: old ? old.t0 : t, t1: old && old.s === st ? old.t1 : t };
      if (td.activeForm) item.a = trunc(oneLine(String(td.activeForm)), 200);
      if (st === 'completed') item.done = old && old.s === 'completed' && old.done ? old.done : t;
      if (st === 'in_progress') item.ts = old && old.ts ? old.ts : t;
      next.push(item);
    }
    s.todos = next;
    s.todosAt = t;
  }

  function taskRec(s, id, t) {
    id = String(id);
    if (!has(s.tasks, id)) s.tasks[id] = { id: id, sub: '', st: 'pending', t0: t, t1: t };
    return s.tasks[id];
  }

  function onToolUse(s, b, e, t, ctx, run) {
    var name = String(b.name || '?');
    var input = b.input && typeof b.input === 'object' ? b.input : {};
    s.counts.tools++;
    s.tools[name] = (s.tools[name] || 0) + 1;
    bumpAct(s, t, 1, 0);
    if (run) run.tools++;
    var pend = { n: name, t: t, r: run ? run.id : null };
    switch (name) {
      case 'Edit': case 'Write': case 'MultiEdit': case 'NotebookEdit': {
        var fp = input.file_path || input.notebook_path;
        s.counts.edits++;
        addFile(s.files, fp, LIMITS.files);
        if (run) { run.ed++; addFile(run.files, fp, LIMITS.runFiles); }
        if (MEDIA_FILE.test(fp || '')) s.signals.media++;
        break;
      }
      case 'Bash': {
        s.counts.bash++;
        if (run) run.bash++;
        if (MEDIA_CMD.test(input.command || '')) s.signals.media++;
        break;
      }
      case 'Task': case 'Agent':
        s.counts.subagents++;
        if (run) run.sub++;
        break;
      case 'TodoWrite':
        if (!ctx.sub) applyTodos(s, input.todos, t);
        break;
      case 'TaskCreate':
        pend.sub = trunc(oneLine(String(input.subject || '')), 300);
        pend.desc = trunc(String(input.description || ''), 600);
        if (input.activeForm) pend.af = trunc(oneLine(String(input.activeForm)), 200);
        break;
      case 'TaskUpdate': {
        if (input.taskId === undefined || input.taskId === null) break;
        var tk = taskRec(s, input.taskId, t);
        if (input.subject) tk.sub = trunc(oneLine(String(input.subject)), 300);
        if (input.description) tk.desc = trunc(String(input.description), 600);
        if (input.activeForm) tk.af = trunc(oneLine(String(input.activeForm)), 200);
        if (input.owner) tk.own = trunc(String(input.owner), 80);
        if (input.status === 'deleted') tk.del = 1;
        else if (input.status) {
          var st = normStatus(input.status);
          if (st !== tk.st) {
            tk.st = st;
            if (st === 'in_progress' && !tk.ts) tk.ts = t;
            if (st === 'completed') tk.tc = t;
          }
        }
        tk.t1 = t;
        addFeed(s, t, 'task', describeTool(name, input) + (tk.sub ? ' · ' + tk.sub : ''), ctx.sub);
        break;
      }
      case 'ExitPlanMode': {
        var md = typeof input.plan === 'string' ? input.plan : '';
        var plan = { id: String(b.id || t), t: t, title: md ? planTitle(md) : 'Plan', md: trunc(md, LIMITS.planMd), st: 'pending' };
        s.plans.push(plan);
        if (s.plans.length > LIMITS.plans) s.plans.splice(0, s.plans.length - LIMITS.plans);
        pend.plan = plan.id;
        addFeed(s, t, 'plan', 'Plan propuesto: ' + plan.title, ctx.sub);
        break;
      }
      default:
        break;
    }
    // Las lecturas de los subagentes son ruido: solo mostramos sus acciones con efecto.
    var noisy = ctx.sub && /^(Read|Grep|Glob|LS|WebFetch|WebSearch|TaskList|TaskGet|TodoWrite)$/.test(name);
    if (name !== 'TaskUpdate' && name !== 'ExitPlanMode' && !noisy) addFeed(s, t, 'tool', describeTool(name, input), ctx.sub);
    if (b.id) s._pending[b.id] = pend;
    if (!ctx.sub) s.tail = 'tool';
  }

  function resultText(block) {
    var c = block && block.content;
    if (typeof c === 'string') return c;
    return textOf(c);
  }

  function onToolResult(s, block, e, t, ctx) {
    var id = block.tool_use_id;
    var p = id && has(s._pending, id) ? s._pending[id] : null;
    if (p) delete s._pending[id];
    var txt = resultText(block);
    // Un rechazo (permiso denegado o plan rechazado) siempre viene marcado como is_error.
    var rejected = block.is_error === true && /doesn't want to proceed with this tool use|User rejected/.test(txt || '');
    var isErr = block.is_error === true && !rejected;
    var run = p ? runById(s, p.r) : (ctx.sub ? runAt(s, t) : currentRun(s));
    if (rejected) s.counts.rejections++;
    if (isErr) {
      s.counts.errors++;
      if (run) run.err++;
    }
    if (!p) return;
    var tur = e.toolUseResult && typeof e.toolUseResult === 'object' ? e.toolUseResult : null;
    if (p.n === 'TaskCreate') {
      var tid = tur && tur.task && tur.task.id;
      if (tid === undefined || tid === null) {
        var m = /Task #(\S+) created/.exec(txt || '');
        tid = m ? m[1] : null;
      }
      if (tid !== null && tid !== undefined && !isErr) {
        var tk = taskRec(s, tid, p.t);
        tk.sub = p.sub || (tur && tur.task && tur.task.subject) || tk.sub;
        if (p.desc) tk.desc = p.desc;
        if (p.af) tk.af = p.af;
        tk.t0 = Math.min(tk.t0 || p.t, p.t);
        addFeed(s, p.t, 'task', 'Nueva tarea #' + tid + ' · ' + tk.sub, ctx.sub);
      }
    } else if (p.n === 'ExitPlanMode' && p.plan) {
      var plan = null;
      for (var i = s.plans.length - 1; i >= 0; i--) if (s.plans[i].id === p.plan) { plan = s.plans[i]; break; }
      if (plan) {
        if (tur && typeof tur.plan === 'string' && tur.plan) {
          plan.md = trunc(tur.plan, LIMITS.planMd);
          plan.title = planTitle(tur.plan);
        }
        if (tur && typeof tur.filePath === 'string') plan.fp = normPath(tur.filePath);
        plan.st = rejected || block.is_error === true ? 'rejected' : 'approved';
        plan.t1 = t;
        addFeed(s, t, 'plan', (plan.st === 'approved' ? 'Plan aprobado: ' : 'Plan rechazado: ') + plan.title, ctx.sub);
      }
    }
  }

  function onUser(s, e, t, ctx) {
    var msg = e.message || {};
    var content = msg.content;
    var blocks = Array.isArray(content) ? content : null;
    var hasResult = false;
    if (blocks) {
      for (var i = 0; i < blocks.length; i++) {
        var b = blocks[i];
        if (b && b.type === 'tool_result') {
          hasResult = true;
          onToolResult(s, b, e, t, ctx);
        }
      }
    }
    if (ctx.sub) return;
    if (hasResult) {
      s.tail = 'result';
      var r0 = currentRun(s);
      if (r0 && t > r0.e) r0.e = t;
      return;
    }
    if (e.isCompactSummary) {
      s.counts.compactions++;
      addFeed(s, t, 'compact', 'Contexto compactado');
      return;
    }
    if (e.isMeta) return;
    var text = textOf(content);
    if (!text || !text.trim()) return;
    var trimmed = text.trim();
    if (/^\[Request interrupted by user/.test(trimmed)) {
      s.counts.interrupts++;
      var r1 = currentRun(s);
      if (r1) { r1.st = 'int'; if (t > r1.e) r1.e = t; }
      s.tail = 'int';
      addFeed(s, t, 'int', 'Interrumpido por el usuario');
      return;
    }
    if (/^<(local-command-stdout|local-command-stderr|local-command-caveat|bash-stdout|bash-stderr)>/.test(trimmed)) return;
    var label, src = 'human';
    var cmd = /<command-name>\s*([^<]+?)\s*<\/command-name>/.exec(trimmed);
    var bash = /^<bash-input>([\s\S]*?)<\/bash-input>/.exec(trimmed);
    if (cmd) {
      var args = /<command-args>([\s\S]*?)<\/command-args>/.exec(trimmed);
      label = cmd[1] + (args && args[1].trim() ? ' ' + args[1].trim() : '');
      src = 'command';
    } else if (bash) {
      addFeed(s, t, 'shell', '! ' + bash[1]);
      return;
    } else if (/^<task-notification>/.test(trimmed)) {
      var sm = /<summary>([\s\S]*?)<\/summary>/.exec(trimmed);
      label = sm ? sm[1] : 'Notificación de tarea en segundo plano';
      src = 'auto';
    } else {
      label = trimmed;
      var ok = e.origin && e.origin.kind;
      if (ok && ok !== 'human') src = String(ok);
    }
    label = trunc(cleanPrompt(label), LIMITS.prompt);
    if (!label) return;
    s.counts.prompts++;
    if (!s.firstPrompt && src !== 'command') s.firstPrompt = label;
    if (src === 'human') s.lastPrompt = label;
    startRun(s, {
      id: String(e.promptId || e.uuid || t),
      t: t, e: t, p: label, src: src, st: 'run',
      tools: 0, ed: 0, bash: 0, err: 0, sub: 0, msgs: 0, out: 0, tk: 0, files: [], res: null
    });
    s.tail = 'prompt';
    addFeed(s, t, 'prompt', (src === 'command' ? '' : '» ') + label);
  }

  function addUsage(s, run, u, ctx, mid, t) {
    // Una misma respuesta se escribe en varias líneas (una por bloque) repitiendo usage:
    // se suma solo el incremento respecto a lo ya contado para ese message.id.
    var inT = +u.input_tokens || 0, outT = +u.output_tokens || 0;
    var cr = +u.cache_read_input_tokens || 0, cw = +u.cache_creation_input_tokens || 0;
    var seen = ctx.mid === mid ? ctx.mu : null;
    var d = seen
      ? { i: Math.max(0, inT - seen[0]), o: Math.max(0, outT - seen[1]), r: Math.max(0, cr - seen[2]), w: Math.max(0, cw - seen[3]) }
      : { i: inT, o: outT, r: cr, w: cw };
    ctx.mid = mid;
    ctx.mu = seen
      ? [Math.max(seen[0], inT), Math.max(seen[1], outT), Math.max(seen[2], cr), Math.max(seen[3], cw)]
      : [inT, outT, cr, cw];
    s.tokens.in += d.i; s.tokens.out += d.o; s.tokens.cr += d.r; s.tokens.cw += d.w;
    bumpAct(s, t, 0, d.i + d.o + d.r + d.w);
    if (run) { run.out += d.o; run.tk += d.i + d.o + d.r + d.w; }
  }

  function onAssistant(s, e, t, ctx) {
    var m = e.message || {};
    var mid = m.id || e.requestId || e.uuid || null;
    var isNew = mid === null || ctx.mid !== mid;
    var run = ctx.sub ? runAt(s, t) : currentRun(s);
    if (isNew) {
      s.counts.messages++;
      if (run && !ctx.sub) run.msgs++;
      if (m.model && m.model !== '<synthetic>') {
        s.models[m.model] = (s.models[m.model] || 0) + 1;
        if (!ctx.sub) s.model = m.model;
      }
    }
    if (m.usage && typeof m.usage === 'object') addUsage(s, run, m.usage, ctx, mid, t);
    else if (isNew) { ctx.mid = mid; ctx.mu = null; }
    if (e.isApiErrorMessage || e.error) {
      s.counts.errors++;
      if (run) run.err++;
      addFeed(s, t, 'error', trunc(oneLine(textOf(m.content)) || 'Error de API', 140), ctx.sub);
    }
    var blocks = Array.isArray(m.content) ? m.content : [];
    for (var i = 0; i < blocks.length; i++) {
      var b = blocks[i];
      if (!b) continue;
      if (b.type === 'tool_use' || b.type === 'server_tool_use') onToolUse(s, b, e, t, ctx, run);
      else if (b.type === 'text' && typeof b.text === 'string' && b.text.trim() && !ctx.sub && !e.isApiErrorMessage) {
        s.tail = 'text';
        if (run) run.res = trunc(oneLine(b.text), LIMITS.result);
        addFeed(s, t, 'text', oneLine(b.text));
      }
    }
    if (!ctx.sub) {
      if (m.stop_reason) s.stopReason = m.stop_reason;
      if (run && t > run.e) run.e = t;
      if (run && run.st === 'run' && m.stop_reason === 'end_turn') run.st = 'ok';
      else if (run && run.st === 'ok' && blocks.some(function (x) { return x && x.type === 'tool_use'; })) run.st = 'run';
    }
  }

  function onSystem(s, e, t, ctx) {
    if (e.subtype === 'compact_boundary') {
      if (!ctx.sub) { s.counts.compactions++; addFeed(s, t, 'compact', 'Contexto compactado'); }
      return;
    }
    if (e.level === 'error') {
      s.counts.errors++;
      addFeed(s, t, 'error', trunc(oneLine(typeof e.content === 'string' ? e.content : 'Error'), 140), ctx.sub);
    }
  }

  /**
   * Aplica una línea (ya parseada) de una transcripción al estado de la sesión.
   * ctx = { sub: bool (subagente), mid, mu } — se guarda por archivo.
   */
  function ingestEntry(s, e, ctx) {
    if (!e || typeof e !== 'object') return;
    ctx = ctx || {};
    var type = e.type;
    switch (type) {
      case 'ai-title': if (e.aiTitle) s.aiTitle = trunc(oneLine(String(e.aiTitle)), 200); return;
      case 'custom-title': if (e.customTitle) s.customTitle = trunc(oneLine(String(e.customTitle)), 200); return;
      case 'summary': if (e.summary && !ctx.sub) s.summary = trunc(oneLine(String(e.summary)), 200); return;
      case 'tag': s.tag = e.tag ? trunc(String(e.tag), 60) : null; return;
      case 'agent-name': if (e.agentName) s.agentName = trunc(String(e.agentName), 80); return;
      case 'last-prompt': if (e.lastPrompt && !ctx.sub) s.lastPrompt = trunc(cleanPrompt(e.lastPrompt), LIMITS.prompt); return;
      case 'pr-link': {
        if (!e.prUrl && !e.prNumber) return;
        var url = String(e.prUrl || '');
        for (var i = 0; i < s.prs.length; i++) if (s.prs[i].url === url && url) return;
        var pt = toMs(e.timestamp) || s.updatedAt;
        s.prs.push({ n: e.prNumber || null, url: url, repo: e.prRepository || null, t: pt });
        addFeed(s, pt, 'pr', 'PR #' + (e.prNumber || '?') + (e.prRepository ? ' · ' + e.prRepository : ''));
        return;
      }
      default: break;
    }
    if (type !== 'user' && type !== 'assistant' && type !== 'system' && type !== 'attachment') return;
    var t = toMs(e.timestamp);
    touch(s, t);
    if (!ctx.sub) {
      if (e.cwd) { s.cwd = String(e.cwd); if (!s.cwd0) s.cwd0 = s.cwd; }
      if (e.gitBranch) s.gitBranch = String(e.gitBranch);
      if (e.version) s.version = String(e.version);
      if (e.entrypoint) s.entrypoint = String(e.entrypoint);
      if (e.permissionMode) s.permissionMode = String(e.permissionMode);
      if (e.slug) s.slug = String(e.slug);
    }
    if (type === 'user') onUser(s, e, t, ctx);
    else if (type === 'assistant') onAssistant(s, e, t, ctx);
    else if (type === 'system') onSystem(s, e, t, ctx);
    else if (type === 'attachment' && !ctx.sub) {
      var a = e.attachment;
      if (a && typeof a.planFilePath === 'string' && !s.planFile) s.planFile = normPath(a.planFilePath);
    }
  }

  /** Copia pública (sin campos internos) de una sesión, apta para enviar a la UI. */
  function publicSession(s) {
    var o = {};
    for (var k in s) if (has(s, k) && k.charAt(0) !== '_') o[k] = s[k];
    o.pendingTools = Object.keys(s._pending || {}).length;
    return o;
  }

  // ───────────────────────────────────────────────────────────── colector (sistema de archivos)

  /**
   * adapter: {
   *   list(rel)                -> Promise<Array<{name, dir}>>  ([] si no existe)
   *   stat(rel)                -> Promise<{size, mtime}|null>
   *   read(rel, start, max)    -> Promise<Uint8Array>
   *   isAlive?(pid)            -> boolean|undefined            (solo Node)
   * }
   * Todas las rutas son relativas al directorio ~/.claude y usan '/'.
   */
  function Collector(adapter, opts) {
    this.fs = adapter;
    this.opts = opts || {};
    this.files = {};      // rel -> { size, mtime, off, sid, dir, sub, mid, mu }
    this.sessions = {};   // sid -> estado
    this.taskLists = {};  // listId -> { id, tasks: {id: task}, mtime, files: {name: mtime}, archived }
    this.plans = {};      // nombre -> { name, title, md, mtime, size, archived }
    this.live = {};       // sid -> registro vivo
    this.meta = { scans: 0, fullScans: 0, bytes: 0, lines: 0, badLines: 0, lastScan: 0, lastFull: 0 };
    this._decoder = typeof TextDecoder !== 'undefined' ? new TextDecoder('utf-8') : null;
  }

  Collector.prototype._session = function (sid, dir) {
    if (!has(this.sessions, sid)) this.sessions[sid] = createSessionState(sid);
    var s = this.sessions[sid];
    if (dir && !s.dir) s.dir = dir;
    return s;
  };

  Collector.prototype._decode = function (bytes) {
    if (this._decoder) return this._decoder.decode(bytes);
    return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString('utf8');
  };

  function lastNewline(bytes) {
    for (var i = bytes.length - 1; i >= 0; i--) if (bytes[i] === 10) return i;
    return -1;
  }

  function concatBytes(a, b) {
    if (!a || !a.length) return b;
    var out = new Uint8Array(a.length + b.length);
    out.set(a, 0);
    out.set(b, a.length);
    return out;
  }

  Collector.prototype._ingestText = function (rec, text) {
    // En el layout antiguo de subagentes (agent-*.jsonl junto a las sesiones) el
    // sessionId del padre sale de las propias líneas.
    var s = rec.sid ? this._session(rec.sid, rec.dir) : null;
    var lines = text.split('\n');
    for (var i = 0; i < lines.length; i++) {
      var line = lines[i];
      if (!line || line.length < 2) continue;
      var obj;
      try { obj = JSON.parse(line); } catch (err) { this.meta.badLines++; continue; }
      this.meta.lines++;
      if (!s) {
        if (!obj || !obj.sessionId) continue;
        rec.sid = String(obj.sessionId);
        s = this._session(rec.sid, rec.dir);
      }
      ingestEntry(s, obj, rec);
    }
    if (s) s.archived = false;
  };

  // Lee lo nuevo de un archivo JSONL desde rec.off (solo líneas completas).
  Collector.prototype._readTranscript = async function (rel, rec, size) {
    var carry = null;
    var pos = rec.off;
    while (pos < size) {
      var chunk = await this.fs.read(rel, pos, Math.min(LIMITS.chunk, size - pos));
      if (!chunk || !chunk.length) break;
      pos += chunk.length;
      this.meta.bytes += chunk.length;
      var buf = concatBytes(carry, chunk);
      var nl = lastNewline(buf);
      if (nl < 0) { carry = buf; continue; }
      var text = this._decode(buf.subarray(0, nl + 1));
      carry = nl + 1 < buf.length ? buf.slice(nl + 1) : null;
      this._ingestText(rec, text);
      rec.off = pos - (carry ? carry.length : 0);
      if (this.onProgress) this.onProgress(this.meta);
    }
  };

  Collector.prototype._resetSession = function (sid) {
    delete this.sessions[sid];
    for (var rel in this.files) {
      if (has(this.files, rel) && this.files[rel].sid === sid) {
        var r = this.files[rel];
        r.off = 0; r.size = -1; r.mtime = 0; r.mid = null; r.mu = null;
      }
    }
  };

  Collector.prototype._checkTranscript = async function (rel, info, changes) {
    var st = await this.fs.stat(rel);
    var rec = has(this.files, rel) ? this.files[rel] : null;
    if (!st) {
      if (rec) this._forgetFile(rel, changes);
      return null;
    }
    if (!rec) {
      rec = this.files[rel] = { size: -1, mtime: 0, off: 0, sid: info.sid || null, dir: info.dir || null, sub: !!info.sub, mid: null, mu: null };
    }
    if (st.size === rec.size && st.mtime === rec.mtime) return rec;
    if (st.size < rec.off) {
      // Archivo reescrito o truncado: reconstruimos la sesión completa.
      if (rec.sid) {
        this._resetSession(rec.sid);
        changes.sessions[rec.sid] = 1;
        changes.rebuild[rec.sid] = 1;
      }
      rec.off = 0;
    }
    if (st.size > rec.off) await this._readTranscript(rel, rec, st.size);
    rec.size = st.size;
    rec.mtime = st.mtime;
    if (rec.sid) {
      changes.sessions[rec.sid] = 1;
      var s = this.sessions[rec.sid];
      if (s && st.mtime > (s.fileMtime || 0)) s.fileMtime = st.mtime;
    }
    return rec;
  };

  Collector.prototype._forgetFile = function (rel, changes) {
    var rec = this.files[rel];
    delete this.files[rel];
    if (!rec || !rec.sid) return;
    var still = false;
    for (var k in this.files) if (has(this.files, k) && this.files[k].sid === rec.sid && !this.files[k].sub) { still = true; break; }
    if (!still && has(this.sessions, rec.sid)) {
      this.sessions[rec.sid].archived = true;
      changes.sessions[rec.sid] = 1;
    }
  };

  Collector.prototype._walkSubagents = async function (base, sid, dir, depth, changes, seen) {
    var entries = await this.fs.list(base);
    for (var i = 0; i < entries.length; i++) {
      var en = entries[i];
      var rel = base + '/' + en.name;
      if (en.dir) {
        if (depth < 3) await this._walkSubagents(rel, sid, dir, depth + 1, changes, seen);
      } else if (/^agent-.+\.jsonl$/.test(en.name)) {
        seen[rel] = 1;
        await this._checkTranscript(rel, { sid: sid, dir: dir, sub: true }, changes);
      }
    }
  };

  Collector.prototype._scanProjects = async function (full, hotCut, changes) {
    var seen = {};
    var dirs = await this.fs.list('projects');
    for (var i = 0; i < dirs.length; i++) {
      if (!dirs[i].dir) continue;
      var dir = dirs[i].name;
      var base = 'projects/' + dir;
      var entries = await this.fs.list(base);
      var subdirs = [];
      for (var j = 0; j < entries.length; j++) {
        var en = entries[j];
        var rel = base + '/' + en.name;
        if (en.dir) { subdirs.push(en.name); continue; }
        if (!/\.jsonl$/.test(en.name)) continue;
        seen[rel] = 1;
        var known = has(this.files, rel) ? this.files[rel] : null;
        if (!full && known && known.mtime && known.mtime < hotCut) continue;
        var isAgent = /^agent-/.test(en.name);
        await this._checkTranscript(rel, { dir: dir, sid: isAgent ? null : en.name.slice(0, -6), sub: isAgent }, changes);
      }
      for (var k = 0; k < subdirs.length; k++) {
        var sid = subdirs[k];
        var main = has(this.files, base + '/' + sid + '.jsonl') ? this.files[base + '/' + sid + '.jsonl'] : null;
        var hot = main && main.mtime >= hotCut;
        if (!full && !hot) {
          // Conservamos los subagentes conocidos de sesiones frías sin volver a mirarlos.
          var prefix = base + '/' + sid + '/';
          for (var r in this.files) if (has(this.files, r) && r.indexOf(prefix) === 0) seen[r] = 1;
          continue;
        }
        await this._walkSubagents(base + '/' + sid + '/subagents', sid, dir, 0, changes, seen);
      }
    }
    if (full) {
      for (var rel2 in this.files) if (has(this.files, rel2) && !has(seen, rel2)) this._forgetFile(rel2, changes);
    }
  };

  Collector.prototype._readJson = async function (rel, max) {
    try {
      var bytes = await this.fs.read(rel, 0, max);
      if (!bytes || !bytes.length) return null;
      return JSON.parse(this._decode(bytes));
    } catch (err) {
      return null;
    }
  };

  Collector.prototype._scanTasks = async function (full, hotCut, changes) {
    var lists = await this.fs.list('tasks');
    var seen = {};
    for (var i = 0; i < lists.length; i++) {
      if (!lists[i].dir) continue;
      var id = lists[i].name;
      seen[id] = 1;
      var known = has(this.taskLists, id) ? this.taskLists[id] : null;
      var sess = has(this.sessions, id) ? this.sessions[id] : null;
      var hot = !known || known.mtime >= hotCut || (sess && (sess.fileMtime || sess.updatedAt) >= hotCut);
      if (!full && !hot) continue;
      var base = 'tasks/' + id;
      var entries = await this.fs.list(base);
      var stamp = {};
      var changed = !known || known.archived;
      var maxM = 0;
      var names = [];
      for (var j = 0; j < entries.length; j++) {
        var en = entries[j];
        if (en.dir || !/\.json$/.test(en.name)) continue;
        var st = await this.fs.stat(base + '/' + en.name);
        if (!st) continue;
        names.push(en.name);
        stamp[en.name] = st.mtime + ':' + st.size;
        if (st.mtime > maxM) maxM = st.mtime;
        if (!known || known.files[en.name] !== stamp[en.name]) changed = true;
      }
      if (known && !changed && Object.keys(known.files).length !== names.length) changed = true;
      if (!changed) continue;
      var tasks = {};
      for (var q = 0; q < names.length; q++) {
        var o = await this._readJson(base + '/' + names[q], LIMITS.taskFile);
        if (!o || typeof o !== 'object' || o.id === undefined) continue;
        var mt = +String(stamp[names[q]]).split(':')[0] || 0;
        tasks[String(o.id)] = {
          id: String(o.id),
          subject: trunc(oneLine(String(o.subject || o.content || '')), 300),
          description: trunc(String(o.description || ''), 1200),
          activeForm: o.activeForm ? trunc(oneLine(String(o.activeForm)), 200) : null,
          status: normStatus(o.status),
          blocks: Array.isArray(o.blocks) ? o.blocks.map(String) : [],
          blockedBy: Array.isArray(o.blockedBy) ? o.blockedBy.map(String) : [],
          owner: o.owner ? trunc(String(o.owner), 80) : null,
          mtime: mt
        };
      }
      this.taskLists[id] = { id: id, tasks: tasks, mtime: maxM || (known && known.mtime) || 0, files: stamp, archived: false };
      changes.tasks = true;
      changes.taskIds[id] = 1;
    }
    if (full) {
      for (var lid in this.taskLists) {
        if (has(this.taskLists, lid) && !has(seen, lid) && !this.taskLists[lid].archived) {
          this.taskLists[lid].archived = true;
          changes.tasks = true;
          changes.taskIds[lid] = 1;
        }
      }
    }
  };

  Collector.prototype._scanPlans = async function (full, hotCut, changes) {
    var entries = await this.fs.list('plans');
    var seen = {};
    for (var i = 0; i < entries.length; i++) {
      var en = entries[i];
      if (en.dir || !/\.md$/.test(en.name)) continue;
      seen[en.name] = 1;
      var known = has(this.plans, en.name) ? this.plans[en.name] : null;
      if (!full && known && known.mtime < hotCut && !known.archived) continue;
      var st = await this.fs.stat('plans/' + en.name);
      if (!st) continue;
      if (known && known.mtime === st.mtime && known.size === st.size && !known.archived) continue;
      var bytes = await this.fs.read('plans/' + en.name, 0, LIMITS.planFile);
      var md = bytes ? this._decode(bytes) : '';
      this.plans[en.name] = { name: en.name, title: planTitle(md), md: trunc(md, LIMITS.planMd), mtime: st.mtime, size: st.size, archived: false };
      changes.plans = true;
      changes.planNames[en.name] = 1;
    }
    if (full) {
      for (var n in this.plans) {
        if (has(this.plans, n) && !has(seen, n) && !this.plans[n].archived) {
          this.plans[n].archived = true;
          changes.plans = true;
          changes.planNames[n] = 1;
        }
      }
    }
  };

  Collector.prototype._scanLive = async function (changes) {
    var entries = await this.fs.list('sessions');
    var next = {};
    for (var i = 0; i < entries.length; i++) {
      var en = entries[i];
      if (en.dir || !/^\d+\.json$/.test(en.name)) continue;
      var o = await this._readJson('sessions/' + en.name, LIMITS.liveFile);
      if (!o || !o.sessionId) continue;
      var pid = +o.pid || +en.name.replace(/\.json$/, '') || 0;
      var alive = typeof this.fs.isAlive === 'function' ? this.fs.isAlive(pid) : undefined;
      if (alive === false) continue;
      var rec = {
        pid: pid,
        sid: String(o.sessionId),
        cwd: o.cwd ? String(o.cwd) : null,
        status: o.status ? String(o.status) : 'idle',
        waitingFor: o.waitingFor ? String(o.waitingFor) : null,
        name: o.name ? String(o.name) : null,
        entrypoint: o.entrypoint ? String(o.entrypoint) : null,
        kind: o.kind ? String(o.kind) : null,
        version: o.version ? String(o.version) : null,
        startedAt: toMs(o.startedAt),
        updatedAt: toMs(o.updatedAt),
        statusAt: toMs(o.statusUpdatedAt),
        verified: alive === true,
        via: 'registry'
      };
      var prev = has(next, rec.sid) ? next[rec.sid] : null;
      if (!prev || rec.updatedAt > prev.updatedAt) next[rec.sid] = rec;
    }
    // Estados empujados por hooks (si están instalados) complementan al registro.
    var hooks = this.hookStates || {};
    for (var sid in hooks) {
      if (!has(hooks, sid) || has(next, sid)) continue;
      var h = hooks[sid];
      if (Date.now() - h.at > 6 * 60 * 60 * 1000 || h.ended) continue;
      next[sid] = { pid: 0, sid: sid, cwd: h.cwd || null, status: h.status, waitingFor: h.waitingFor || null, name: null, entrypoint: null, kind: null, version: null, startedAt: h.startedAt || h.at, updatedAt: h.at, statusAt: h.at, verified: false, via: 'hook' };
    }
    var before = JSON.stringify(this.live);
    this.live = next;
    if (JSON.stringify(next) !== before) changes.live = true;
  };

  function newChanges() {
    return { sessions: {}, rebuild: {}, tasks: false, taskIds: {}, plans: false, planNames: {}, live: false };
  }

  function finishChanges(changes, full) {
    return {
      sessions: Object.keys(changes.sessions),
      rebuild: Object.keys(changes.rebuild),
      tasks: changes.tasks,
      taskIds: Object.keys(changes.taskIds),
      plans: changes.plans,
      planNames: Object.keys(changes.planNames),
      live: changes.live,
      full: full
    };
  }

  /**
   * Una pasada del colector.
   * opts.full: revisa todo (si no, solo archivos "calientes" de las últimas horas).
   * Devuelve { sessions: [ids cambiadas], tasks, plans, live, rebuild: [ids] }.
   */
  Collector.prototype.scan = async function (opts) {
    opts = opts || {};
    var now = Date.now();
    var full = !!opts.full || !this.meta.lastFull;
    var hotCut = now - (opts.hotWindow || HOT_WINDOW);
    var changes = newChanges();
    await this._scanProjects(full, hotCut, changes);
    await this._scanTasks(full, hotCut, changes);
    await this._scanPlans(full, hotCut, changes);
    await this._scanLive(changes);
    this.meta.scans++;
    this.meta.lastScan = now;
    if (full) { this.meta.fullScans++; this.meta.lastFull = now; }
    return finishChanges(changes, full);
  };

  /** Relee solo los archivos indicados (p. ej. al recibir un evento de fs.watch o un hook). */
  Collector.prototype.scanPaths = async function (rels) {
    var changes = newChanges();
    var taskDirs = {};
    var plans = false;
    for (var i = 0; i < rels.length; i++) {
      var rel = String(rels[i]).replace(/\\/g, '/').replace(/^\/+/, '');
      var m;
      if ((m = /^projects\/([^/]+)\/([^/]+)\.jsonl$/.exec(rel))) {
        var isAgent = /^agent-/.test(m[2]);
        await this._checkTranscript(rel, { dir: m[1], sid: isAgent ? null : m[2], sub: isAgent }, changes);
      } else if ((m = /^projects\/([^/]+)\/([^/]+)\/subagents\/(?:.+\/)?agent-[^/]+\.jsonl$/.exec(rel))) {
        await this._checkTranscript(rel, { dir: m[1], sid: m[2], sub: true }, changes);
      } else if ((m = /^tasks\/([^/]+)(?:\/|$)/.exec(rel))) {
        taskDirs[m[1]] = 1;
      } else if (/^plans(\/|$)/.test(rel)) {
        plans = true;
      }
    }
    var ids = Object.keys(taskDirs);
    if (ids.length) {
      // Forzamos que esas listas se consideren calientes.
      for (var j = 0; j < ids.length; j++) if (has(this.taskLists, ids[j])) this.taskLists[ids[j]].mtime = Date.now();
      await this._scanTasks(false, Date.now() - HOT_WINDOW, changes);
    }
    if (plans) await this._scanPlans(false, 0, changes);
    await this._scanLive(changes);
    return finishChanges(changes, false);
  };

  Collector.prototype.snapshot = function () {
    var sessions = {};
    for (var sid in this.sessions) if (has(this.sessions, sid)) sessions[sid] = publicSession(this.sessions[sid]);
    return {
      version: VERSION,
      generatedAt: Date.now(),
      sessions: sessions,
      taskLists: this.publicTaskLists(),
      plans: this.plans,
      live: this.live,
      meta: this.publicMeta()
    };
  };

  Collector.prototype.publicTaskLists = function () {
    var out = {};
    for (var id in this.taskLists) {
      if (!has(this.taskLists, id)) continue;
      var l = this.taskLists[id];
      out[id] = { id: l.id, tasks: l.tasks, mtime: l.mtime, archived: l.archived };
    }
    return out;
  };

  Collector.prototype.publicMeta = function () {
    var m = {};
    for (var k in this.meta) if (has(this.meta, k)) m[k] = this.meta[k];
    m.files = Object.keys(this.files).length;
    m.sessions = Object.keys(this.sessions).length;
    return m;
  };

  /** Estado serializable para cachear en disco (el servidor lo guarda en ~/.claude-nexus). */
  Collector.prototype.exportIndex = function () {
    return { v: STATE_VERSION, files: this.files, taskLists: this.taskLists, plans: this.plans, meta: { bytes: this.meta.bytes, lines: this.meta.lines } };
  };

  Collector.prototype.importState = function (index, sessions) {
    if (!index || index.v !== STATE_VERSION) return false;
    this.files = index.files || {};
    this.taskLists = index.taskLists || {};
    this.plans = index.plans || {};
    this.sessions = {};
    for (var sid in sessions) {
      if (!has(sessions, sid)) continue;
      var s = sessions[sid];
      if (!s || s.v !== STATE_VERSION) {
        // Estado incompatible: forzamos a releer los archivos de esa sesión.
        this._resetSession(sid);
        continue;
      }
      if (!s._pending) s._pending = {};
      this.sessions[sid] = s;
    }
    // Archivos cuya sesión no está en caché: se releen desde cero.
    for (var rel in this.files) {
      if (!has(this.files, rel)) continue;
      var r = this.files[rel];
      if (r.sid && !has(this.sessions, r.sid)) { r.off = 0; r.size = -1; r.mtime = 0; r.mid = null; r.mu = null; }
    }
    return true;
  };

  // ───────────────────────────────────────────────────────────── configuración

  var CATEGORIES = [
    { id: 'dev', label: 'Desarrollo', short: 'DEV', glyph: '</>' },
    { id: 'video', label: 'Video / Canal', short: 'VIDEO', glyph: '▶' },
    { id: 'content', label: 'Contenido', short: 'CONTENIDO', glyph: '✎' },
    { id: 'research', label: 'Investigación', short: 'INVEST.', glyph: '◎' },
    { id: 'ops', label: 'Ops / Automatización', short: 'OPS', glyph: '⚙' },
    { id: 'other', label: 'Otros', short: 'OTROS', glyph: '◇' }
  ];

  var CATEGORY_IDS = {};
  CATEGORIES.forEach(function (c) { CATEGORY_IDS[c.id] = 1; });

  var STAGES = {
    video: ['Idea', 'Guion', 'Grabación', 'Edición', 'Miniatura', 'Publicado'],
    dev: ['Planificación', 'Desarrollo', 'Pruebas', 'Deploy', 'Mantenimiento'],
    content: ['Idea', 'Borrador', 'Revisión', 'Publicado'],
    research: ['Pregunta', 'Exploración', 'Síntesis', 'Conclusión'],
    ops: ['Diseño', 'Implementación', 'Operando'],
    other: ['Backlog', 'En curso', 'Revisión', 'Hecho']
  };

  function defaultConfig() {
    return { version: 1, projects: {}, aliases: {}, ui: {} };
  }

  function normalizeConfig(cfg) {
    var c = defaultConfig();
    if (cfg && typeof cfg === 'object') {
      if (cfg.projects && typeof cfg.projects === 'object') c.projects = cfg.projects;
      if (cfg.aliases && typeof cfg.aliases === 'object') c.aliases = cfg.aliases;
      if (cfg.ui && typeof cfg.ui === 'object') c.ui = cfg.ui;
    }
    return c;
  }

  var RE_VIDEO = /(video|vídeo|youtube|(^|[^a-z])yt([^a-z]|$)|canal|shorts?|reels?|tiktok|podcast|stream|edici[oó]n|gui[oó]n|thumbnail|miniatura|clips?|montaje|episod|capitulo|capítulo)/i;
  var RE_CONTENT = /(blog|docs?|notas|notes|writing|newsletter|curso|course|libro|book|posts?|art[ií]culo|contenido|content|marketing|copy|social)/i;
  var RE_RESEARCH = /(research|investiga|paper|study|estudio|an[aá]lisis|analysis|datos|dataset|notebook|benchmark)/i;
  var RE_OPS = /(infra|devops|(^|[^a-z])ops([^a-z]|$)|deploy|servidor|homelab|docker|k8s|kubernetes|ansible|terraform|dotfiles|automat|n8n|cron|backup)/i;

  function detectCategory(key, signals) {
    var tail = normPath(key).split('/').slice(-3).join('/');
    if (RE_VIDEO.test(tail) || (signals && signals.media >= 3)) return 'video';
    if (RE_OPS.test(tail)) return 'ops';
    if (RE_RESEARCH.test(tail)) return 'research';
    if (RE_CONTENT.test(tail)) return 'content';
    return 'dev';
  }

  // ───────────────────────────────────────────────────────────── agregador

  function pad2(n) { return (n < 10 ? '0' : '') + n; }

  function dayKey(ms) {
    var d = new Date(ms);
    return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
  }

  function startOfDay(ms) {
    var d = new Date(ms);
    d.setHours(0, 0, 0, 0);
    return d.getTime();
  }

  function liveState(lv) {
    switch (lv.status) {
      case 'busy': case 'shell': return 'working';
      case 'waiting': return 'waiting';
      default: return 'idle';
    }
  }

  /**
   * Estado de una sesión:
   *   working  → Claude está trabajando
   *   waiting  → necesita tu respuesta o aprobación
   *   idle     → abierta, esperando nuevo prompt
   *   ended    → cerrada / sin actividad reciente
   */
  function inferState(s, lv, now) {
    var upd = Math.max(s.updatedAt || 0, s.fileMtime || 0);
    if (lv) {
      var st = liveState(lv);
      // Registro sin verificación de PID (modo carpeta): si lleva horas sin moverse, lo damos por muerto.
      if (!lv.verified && lv.via === 'registry' && st === 'working' && now - Math.max(upd, lv.statusAt || 0, lv.updatedAt || 0) > 45 * 60 * 1000) return 'ended';
      return st;
    }
    var age = now - upd;
    if (age < 90 * 1000 && (s.tail === 'tool' || s.tail === 'result' || s.tail === 'prompt')) return 'working';
    if (age < 5 * 60 * 1000 && s.tail !== 'int') return 'idle';
    return 'ended';
  }

  function sessionTitle(s) {
    return s.customTitle || s.aiTitle || s.summary || s.firstPrompt || s.lastPrompt || ('Sesión ' + String(s.id).slice(0, 8));
  }

  function emptyStats() {
    return { pending: 0, in_progress: 0, completed: 0, blocked: 0, total: 0, stale: 0 };
  }

  function buildModel(data, cfgIn, now) {
    now = now || Date.now();
    var cfg = normalizeConfig(cfgIn);
    var sessionsIn = (data && data.sessions) || {};
    var live = (data && data.live) || {};
    var lists = (data && data.taskLists) || {};
    var planFiles = (data && data.plans) || {};
    var today0 = startOfDay(now);
    var DAYS = 182;
    var firstDay = today0 - (DAYS - 1) * 86400000;

    function alias(key) {
      var seen = 0;
      while (key && has(cfg.aliases, key) && cfg.aliases[key] && seen++ < 5) key = normPath(cfg.aliases[key]);
      return key;
    }

    // dir de ~/.claude/projects → clave de proyecto aprendida de cualquier sesión con cwd
    var dirKey = {};
    values(sessionsIn).forEach(function (s) { if (s.cwd0 && s.dir) dirKey[s.dir] = projectKeyFromCwd(s.cwd0); });

    // Sesiones vivas sin transcripción todavía (recién abiertas).
    var allSessions = {};
    for (var sid in sessionsIn) if (has(sessionsIn, sid)) allSessions[sid] = sessionsIn[sid];
    for (var lid in live) {
      if (!has(live, lid) || has(allSessions, lid)) continue;
      var lv0 = live[lid];
      var stub = createSessionState(lid);
      stub.cwd = stub.cwd0 = lv0.cwd;
      stub.entrypoint = lv0.entrypoint;
      stub.startedAt = lv0.startedAt || now;
      stub.updatedAt = lv0.updatedAt || lv0.startedAt || now;
      stub.aiTitle = lv0.name || null;
      stub.version = lv0.version;
      delete stub._pending;
      allSessions[lid] = stub;
    }

    var projects = {};
    function project(key) {
      if (!has(projects, key)) {
        var pc = cfg.projects[key] || {};
        projects[key] = {
          key: key,
          path: key.indexOf('lista:') === 0 ? null : key,
          name: pc.name || null,
          category: CATEGORY_IDS[pc.category] ? pc.category : null,
          stage: pc.stage || null,
          notes: pc.notes || '',
          pinned: !!pc.pinned,
          hidden: !!pc.hidden,
          sessions: [],
          active: 0, waiting: 0, working: 0, open: 0,
          startedAt: 0, lastActivity: 0,
          runs: 0, runs7: 0, runsToday: 0,
          tasks: emptyStats(),
          plans: 0,
          tokens: 0, out: 0, tools: 0, edits: 0, errors: 0,
          files: 0, prs: [],
          signals: { media: 0 },
          origins: {}, models: {}, branches: {},
          current: null,
          spark: new Array(14).fill(0)
        };
      }
      return projects[key];
    }

    var sessions = [];
    var sessionMap = {};
    var runs = [];
    var feed = [];
    var tasks = [];
    var plans = [];
    var daily = {};
    var hourly = new Array(24).fill(0).map(function (_, i) { return { t: 0, runs: 0, tools: 0, tokens: 0, i: i }; });
    var hour0 = Math.floor(now / 3600000) * 3600000 - 23 * 3600000;
    for (var h = 0; h < 24; h++) hourly[h].t = hour0 + h * 3600000;

    function dayRec(ms) {
      var k = dayKey(ms);
      if (!has(daily, k)) daily[k] = { day: k, t: startOfDay(ms), runs: 0, tools: 0, edits: 0, tokens: 0, done: 0, sessions: 0, prompts: 0 };
      return daily[k];
    }

    var ids = Object.keys(allSessions);
    for (var i = 0; i < ids.length; i++) {
      var s = allSessions[ids[i]];
      var rawKey = s.cwd0 ? projectKeyFromCwd(s.cwd0) : (s.dir && has(dirKey, s.dir) ? dirKey[s.dir] : (s.dir ? 'dir:' + s.dir : 'desconocido'));
      var key = alias(rawKey);
      var lv = has(live, s.id) ? live[s.id] : null;
      var state = inferState(s, lv, now);
      var tokTotal = (s.tokens ? s.tokens.in + s.tokens.out + s.tokens.cr + s.tokens.cw : 0);
      var view = {
        id: s.id,
        key: key,
        title: sessionTitle(s),
        state: state,
        waitingFor: lv && lv.status === 'waiting' ? (lv.waitingFor || 'tu respuesta') : null,
        live: lv ? { pid: lv.pid, status: lv.status, name: lv.name, verified: lv.verified, via: lv.via } : null,
        origin: originLabel((lv && lv.entrypoint) || s.entrypoint),
        entrypoint: (lv && lv.entrypoint) || s.entrypoint,
        cwd: s.cwd,
        branch: s.gitBranch,
        model: s.model,
        version: s.version,
        permissionMode: s.permissionMode,
        startedAt: s.startedAt || (lv && lv.startedAt) || 0,
        updatedAt: Math.max(s.updatedAt || 0, (lv && lv.statusAt) || 0),
        counts: s.counts,
        tokens: s.tokens,
        tokTotal: tokTotal,
        tools: s.tools,
        files: s.files,
        prs: s.prs,
        feed: s.feed,
        last: s.last,
        firstPrompt: s.firstPrompt,
        lastPrompt: s.lastPrompt,
        tag: s.tag,
        archived: !!s.archived,
        runs: s.runs || [],
        tasks: emptyStats(),
        current: null,
        plans: 0
      };
      sessions.push(view);
      sessionMap[s.id] = view;
      var p = project(key);
      p.sessions.push(s.id);
      if (!p.startedAt || (view.startedAt && view.startedAt < p.startedAt)) p.startedAt = view.startedAt;
      if (view.updatedAt > p.lastActivity) p.lastActivity = view.updatedAt;
      if (state === 'working') { p.working++; p.active++; }
      if (state === 'waiting') { p.waiting++; p.active++; }
      if (lv) p.open++;
      p.tokens += tokTotal;
      p.out += s.tokens ? s.tokens.out : 0;
      p.tools += s.counts ? s.counts.tools : 0;
      p.edits += s.counts ? s.counts.edits : 0;
      p.errors += s.counts ? s.counts.errors : 0;
      p.files += s.files ? s.files.length : 0;
      if (s.signals) p.signals.media += s.signals.media || 0;
      p.origins[view.origin] = (p.origins[view.origin] || 0) + 1;
      if (s.model) p.models[s.model] = (p.models[s.model] || 0) + 1;
      if (s.gitBranch) p.branches[s.gitBranch] = Math.max(p.branches[s.gitBranch] || 0, view.updatedAt);
      (s.prs || []).forEach(function (pr) { p.prs.push({ n: pr.n, url: pr.url, repo: pr.repo, t: pr.t, sessionId: s.id }); });

      // Actividad por hora registrada durante el parseo (si existe)
      var hasAct = !!(s.act && Object.keys(s.act).length);
      if (hasAct) {
        var h0 = Math.floor(hour0 / 3600000);
        for (var hk in s.act) {
          if (!has(s.act, hk)) continue;
          var idx = +hk - h0;
          if (idx >= 0 && idx < 24) { hourly[idx].tools += s.act[hk][0]; hourly[idx].tokens += s.act[hk][1]; }
        }
      }

      // Tandas (runs)
      var sr = s.runs || [];
      for (var r = 0; r < sr.length; r++) {
        var run = sr[r];
        if (run.src === 'command' && !run.msgs && !run.tools) continue; // comandos locales (/model, /clear…)
        var rv = {
          id: s.id + ':' + run.id,
          sessionId: s.id, key: key,
          t: run.t, e: run.e, p: run.p, src: run.src,
          st: run.st === 'run' && (r < sr.length - 1 || state === 'ended' || state === 'idle') ? 'ok' : run.st,
          tools: run.tools, ed: run.ed, bash: run.bash, err: run.err, sub: run.sub, msgs: run.msgs,
          out: run.out, tk: run.tk, files: run.files, res: run.res
        };
        if (rv.st === 'run' && state === 'waiting') rv.st = 'wait';
        runs.push(rv);
        p.runs++;
        if (run.t >= now - 7 * 86400000) p.runs7++;
        if (run.t >= today0) p.runsToday++;
        if (run.t >= firstDay) {
          var dr = dayRec(run.t);
          dr.runs++; dr.tools += run.tools; dr.edits += run.ed; dr.tokens += run.tk;
          if (run.src === 'human') dr.prompts++;
        }
        if (run.t >= hour0) {
          var hi = Math.floor((run.t - hour0) / 3600000);
          if (hi >= 0 && hi < 24) {
            hourly[hi].runs++;
            if (!hasAct) { hourly[hi].tools += run.tools; hourly[hi].tokens += run.tk; }
          }
        }
        var di = Math.floor((run.t - (today0 - 13 * 86400000)) / 86400000);
        if (di >= 0 && di < 14) p.spark[di]++;
      }
      if (view.startedAt >= firstDay) dayRec(view.startedAt).sessions++;

      // Feed
      var sf = s.feed || [];
      for (var f = 0; f < sf.length; f++) {
        feed.push({ t: sf[f].t, k: sf[f].k, x: sf[f].x, sub: sf[f].sub, sessionId: s.id, key: key });
      }

      // Planes propuestos en la sesión
      (s.plans || []).forEach(function (pl) {
        plans.push({
          id: s.id + ':' + pl.id, title: pl.title, md: pl.md, status: pl.st, t: pl.t, t1: pl.t1 || pl.t,
          sessionId: s.id, key: key, file: pl.fp ? baseName(pl.fp) : null, steps: planSteps(pl.md)
        });
      });
    }

    // Tareas: archivos de ~/.claude/tasks + eventos de la transcripción + TodoWrite.
    // Una tarea abierta en una sesión cerrada hace días se considera abandonada (stale):
    // se sigue mostrando, pero no cuenta como pendiente.
    var STALE_MS = 3 * 86400000;
    function pushTask(tk) {
      var sv = tk.sessionId && has(sessionMap, tk.sessionId) ? sessionMap[tk.sessionId] : null;
      tk.stale = tk.status !== 'completed' && (!!tk.archived ||
        (sv ? sv.state === 'ended' && now - tk.updated > STALE_MS : now - tk.updated > 10 * STALE_MS));
      tasks.push(tk);
      var p = project(tk.key);
      if (tk.stale) {
        p.tasks.stale = (p.tasks.stale || 0) + 1;
        if (sv) sv.tasks.stale = (sv.tasks.stale || 0) + 1;
      } else {
        p.tasks.total++;
        p.tasks[tk.status]++;
        if (tk.blocked) p.tasks.blocked++;
        if (sv) {
          sv.tasks.total++;
          sv.tasks[tk.status]++;
          if (tk.blocked) sv.tasks.blocked++;
        }
      }
      if (sv && tk.status === 'in_progress' && !tk.stale && (!sv.current || tk.updated > sv.current.t)) sv.current = { x: tk.activeForm || tk.subject, t: tk.updated };
      if (tk.completedAt && tk.completedAt >= firstDay) dayRec(tk.completedAt).done++;
    }

    var listUsed = {};
    for (var si = 0; si < ids.length; si++) {
      var ss = allSessions[ids[si]];
      var sv2 = sessionMap[ss.id];
      var list = has(lists, ss.id) ? lists[ss.id] : null;
      if (list) listUsed[ss.id] = 1;
      var ev = ss.tasks || {};
      var tids = {};
      if (list) for (var a in list.tasks) if (has(list.tasks, a)) tids[a] = 1;
      for (var b in ev) if (has(ev, b)) tids[b] = 1;
      var fileTasks = list ? list.tasks : {};
      var openIds = {};
      for (var tid in tids) {
        if (!has(tids, tid)) continue;
        var ft = has(fileTasks, tid) ? fileTasks[tid] : null;
        var e2 = has(ev, tid) ? ev[tid] : null;
        if (!ft && list && !list.archived) continue; // borrada en disco
        if (!ft && e2 && e2.del) continue;
        var status = ft ? ft.status : (e2 ? e2.st : 'pending');
        if (status !== 'completed') openIds[tid] = 1;
      }
      for (var tid2 in tids) {
        if (!has(tids, tid2)) continue;
        var ft2 = has(fileTasks, tid2) ? fileTasks[tid2] : null;
        var e3 = has(ev, tid2) ? ev[tid2] : null;
        if (!ft2 && list && !list.archived) continue;
        if (!ft2 && e3 && e3.del) continue;
        var st2 = ft2 ? ft2.status : (e3 ? e3.st : 'pending');
        var blockedBy = ft2 ? ft2.blockedBy : [];
        var openBlockers = blockedBy.filter(function (x) { return has(openIds, x); });
        var created = (e3 && e3.t0) || (ft2 && ft2.mtime) || ss.startedAt || 0;
        var updated = Math.max((e3 && e3.t1) || 0, (ft2 && ft2.mtime) || 0) || created;
        pushTask({
          uid: ss.id + ':t:' + tid2,
          id: tid2,
          subject: (ft2 && ft2.subject) || (e3 && e3.sub) || ('Tarea #' + tid2),
          description: (ft2 && ft2.description) || (e3 && e3.desc) || '',
          activeForm: (ft2 && ft2.activeForm) || (e3 && e3.af) || null,
          status: st2,
          blocked: st2 !== 'completed' && openBlockers.length > 0,
          blockedBy: blockedBy,
          owner: (ft2 && ft2.owner) || (e3 && e3.own) || null,
          source: 'task',
          sessionId: ss.id,
          key: sv2.key,
          created: created,
          updated: updated,
          startedAt: e3 && e3.ts ? e3.ts : null,
          completedAt: st2 === 'completed' ? ((e3 && e3.tc) || (ft2 && ft2.mtime) || updated) : null,
          archived: !!(list && list.archived) || (!list && !!ss.archived)
        });
      }
      var todos = ss.todos || [];
      for (var ti = 0; ti < todos.length; ti++) {
        var td = todos[ti];
        pushTask({
          uid: ss.id + ':todo:' + ti,
          id: String(ti + 1),
          subject: td.c,
          description: '',
          activeForm: td.a || null,
          status: td.s,
          blocked: false,
          blockedBy: [],
          owner: null,
          source: 'todo',
          sessionId: ss.id,
          key: sv2.key,
          created: td.t0 || ss.startedAt,
          updated: td.t1 || td.t0 || ss.updatedAt,
          startedAt: td.ts || null,
          completedAt: td.s === 'completed' ? (td.done || td.t1) : null,
          archived: !!ss.archived
        });
      }
    }
    // Listas compartidas (CLAUDE_CODE_TASK_LIST_ID) que no son de ninguna sesión.
    for (var lk in lists) {
      if (!has(lists, lk) || has(listUsed, lk)) continue;
      var L = lists[lk];
      var pkey = 'lista:' + lk;
      var pl0 = project(pkey);
      if (!pl0.name) pl0.name = 'Lista · ' + lk;
      if (!pl0.category) pl0.category = 'other';
      var open2 = {};
      for (var q in L.tasks) if (has(L.tasks, q) && L.tasks[q].status !== 'completed') open2[q] = 1;
      for (var q2 in L.tasks) {
        if (!has(L.tasks, q2)) continue;
        var T = L.tasks[q2];
        var ob = (T.blockedBy || []).filter(function (x) { return has(open2, x); });
        if (T.mtime > pl0.lastActivity) pl0.lastActivity = T.mtime;
        pushTask({
          uid: 'lista:' + lk + ':' + q2, id: q2, subject: T.subject || ('Tarea #' + q2), description: T.description || '',
          activeForm: T.activeForm, status: T.status, blocked: T.status !== 'completed' && ob.length > 0, blockedBy: T.blockedBy || [],
          owner: T.owner, source: 'task', sessionId: null, key: pkey, created: T.mtime, updated: T.mtime, startedAt: null,
          completedAt: T.status === 'completed' ? T.mtime : null, archived: !!L.archived
        });
      }
    }

    // Planes guardados como archivo (~/.claude/plans)
    var planByFile = {};
    plans.forEach(function (pl) { if (pl.file) planByFile[pl.file] = pl; });
    var slugSession = {};
    values(allSessions).forEach(function (s) {
      if (s.slug) slugSession[s.slug + '.md'] = s.id;
      if (s.planFile) slugSession[baseName(s.planFile)] = s.id;
    });
    for (var pn in planFiles) {
      if (!has(planFiles, pn)) continue;
      var PF = planFiles[pn];
      if (has(planByFile, pn)) {
        var linked = planByFile[pn];
        if (PF.md && PF.mtime >= (linked.t1 || 0)) { linked.md = PF.md; linked.title = PF.title || linked.title; linked.steps = planSteps(PF.md); }
        linked.fileMtime = PF.mtime;
        continue;
      }
      var psid = has(slugSession, pn) ? slugSession[pn] : null;
      var pview = psid && has(sessionMap, psid) ? sessionMap[psid] : null;
      plans.push({
        id: 'file:' + pn, title: PF.title || pn, md: PF.md, status: 'draft', t: PF.mtime, t1: PF.mtime,
        sessionId: pview ? pview.id : null, key: pview ? pview.key : null, file: pn, steps: planSteps(PF.md), archived: !!PF.archived
      });
    }
    plans.forEach(function (pl) {
      if (pl.key && has(projects, pl.key)) projects[pl.key].plans++;
      if (pl.sessionId && has(sessionMap, pl.sessionId)) sessionMap[pl.sessionId].plans++;
    });

    // Proyectos: nombre, categoría y actividad actual
    var list2 = values(projects);
    var nameCount = {};
    list2.forEach(function (p) {
      if (!p.name) p.name = p.key.indexOf('dir:') === 0 ? p.key.slice(4).replace(/^-+/, '') : (baseName(p.key) || p.key);
      nameCount[p.name] = (nameCount[p.name] || 0) + 1;
    });
    list2.forEach(function (p) {
      if (nameCount[p.name] > 1 && p.path && !(cfg.projects[p.key] && cfg.projects[p.key].name)) {
        var segs = normPath(p.path).split('/').filter(Boolean);
        if (segs.length > 1) p.name = segs[segs.length - 1] + ' · ' + segs[segs.length - 2];
      }
      p.autoCategory = detectCategory(p.key, p.signals);
      if (!p.category) p.category = p.autoCategory;
      p.progress = p.tasks.total ? p.tasks.completed / p.tasks.total : null;
      var cur = null;
      p.sessions.forEach(function (id) {
        var sv3 = sessionMap[id];
        if (!sv3) return;
        if ((sv3.state === 'working' || sv3.state === 'waiting') && (!cur || sv3.updatedAt > cur.t)) {
          cur = {
            t: sv3.updatedAt,
            x: sv3.state === 'waiting' ? waitPhrase(sv3.waitingFor) : (sv3.current ? sv3.current.x : (sv3.last ? sv3.last.x : sv3.title)),
            sessionId: id, state: sv3.state
          };
        }
      });
      p.current = cur;
      p.status = p.waiting ? 'waiting' : p.working ? 'working' : p.open ? 'idle' : (now - p.lastActivity < 86400000 ? 'recent' : 'dormant');
      p.prs.sort(function (x, y) { return (y.t || 0) - (x.t || 0); });
    });
    sessions.forEach(function (sv4) {
      var p = projects[sv4.key];
      sv4.project = p ? p.name : sv4.key;
      sv4.category = p ? p.category : 'dev';
    });

    // Series diarias continuas
    var series = [];
    for (var d = 0; d < DAYS; d++) {
      var ms = firstDay + d * 86400000 + 12 * 3600000; // mediodía: inmune a cambios de horario
      var k2 = dayKey(ms);
      series.push(has(daily, k2) ? daily[k2] : { day: k2, t: startOfDay(ms), runs: 0, tools: 0, edits: 0, tokens: 0, done: 0, sessions: 0, prompts: 0 });
    }

    runs.sort(function (x, y) { return y.t - x.t; });
    feed.sort(function (x, y) { return y.t - x.t; });
    if (feed.length > 250) feed.length = 250;
    sessions.sort(function (x, y) { return y.updatedAt - x.updatedAt; });
    tasks.sort(function (x, y) { return y.updated - x.updated; });
    plans.sort(function (x, y) { return (y.t1 || y.t) - (x.t1 || x.t); });
    list2.sort(function (x, y) {
      if (x.pinned !== y.pinned) return x.pinned ? -1 : 1;
      return y.lastActivity - x.lastActivity;
    });

    var todayRec = has(daily, dayKey(now)) ? daily[dayKey(now)] : null;
    var kpis = {
      working: 0, waiting: 0, open: 0, idle: 0,
      tasksOpen: 0, tasksActive: 0, tasksBlocked: 0, tasksDone: 0, tasksStale: 0,
      doneToday: todayRec ? todayRec.done : 0,
      runsToday: todayRec ? todayRec.runs : 0,
      tokensToday: todayRec ? todayRec.tokens : 0,
      editsToday: todayRec ? todayRec.edits : 0,
      toolsToday: todayRec ? todayRec.tools : 0,
      projects: list2.filter(function (p) { return !p.hidden; }).length,
      projectsToday: list2.filter(function (p) { return p.lastActivity >= today0; }).length,
      sessions: sessions.length,
      plansPending: plans.filter(function (p) { return p.status === 'pending'; }).length,
      plans: plans.length,
      runs: runs.length
    };
    sessions.forEach(function (sv5) {
      if (sv5.state === 'working') kpis.working++;
      else if (sv5.state === 'waiting') kpis.waiting++;
      else if (sv5.state === 'idle') kpis.idle++;
      if (sv5.live) kpis.open++;
    });
    tasks.forEach(function (tk) {
      if (tk.stale) { kpis.tasksStale = (kpis.tasksStale || 0) + 1; return; }
      if (tk.status === 'completed') kpis.tasksDone++;
      else {
        kpis.tasksOpen++;
        if (tk.status === 'in_progress') kpis.tasksActive++;
        if (tk.blocked) kpis.tasksBlocked++;
      }
    });

    return {
      now: now,
      sessions: sessions,
      sessionMap: sessionMap,
      projects: list2,
      projectMap: projects,
      tasks: tasks,
      plans: plans,
      runs: runs,
      feed: feed,
      daily: series,
      hourly: hourly,
      kpis: kpis
    };
  }

  // ───────────────────────────────────────────────────────────── formato

  var NF = null;
  function fmtNum(n) {
    n = +n || 0;
    try {
      if (!NF) NF = new Intl.NumberFormat('es-ES');
      return NF.format(n);
    } catch (e) { return String(n); }
  }

  // 950 · 12,4K · 3,21M · 1,1B (coma decimal, como en español)
  function fmtTok(n) {
    n = Math.round(+n || 0);
    if (Math.abs(n) < 1000) return String(n);
    var units = [['K', 1e3], ['M', 1e6], ['B', 1e9], ['T', 1e12]];
    for (var i = 0; i < units.length; i++) {
      var v = n / units[i][1];
      var s = Math.abs(v) >= 100 ? String(Math.round(v)) : Math.abs(v) >= 10 ? v.toFixed(1) : v.toFixed(2);
      if (+s >= 1000 && i < units.length - 1) continue; // 999.950 → 1M, no «1000K»
      if (s.indexOf('.') >= 0) s = s.replace(/0+$/, '').replace(/\.$/, '');
      return s.replace('.', ',') + units[i][0];
    }
    return String(n);
  }

  function fmtDur(ms) {
    ms = Math.max(0, +ms || 0);
    var s = Math.round(ms / 1000);
    if (s < 60) return s + ' s';
    var m = Math.floor(s / 60);
    if (m < 60) return m + ' min';
    var h = Math.floor(m / 60);
    if (h < 24) return h + ' h' + (m % 60 ? ' ' + (m % 60) + ' min' : '');
    var d = Math.floor(h / 24);
    return d + ' d' + (h % 24 ? ' ' + (h % 24) + ' h' : '');
  }

  var MONTHS = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];

  function fmtAgo(ms, now) {
    if (!ms) return '—';
    now = now || Date.now();
    var d = now - ms;
    if (d < 10000) return 'ahora';
    if (d < 60000) return 'hace ' + Math.floor(d / 1000) + ' s';
    if (d < 3600000) return 'hace ' + Math.floor(d / 60000) + ' min';
    if (d < 86400000) return 'hace ' + Math.floor(d / 3600000) + ' h';
    if (d < 2 * 86400000) return 'ayer';
    if (d < 30 * 86400000) return 'hace ' + Math.floor(d / 86400000) + ' d';
    return fmtDate(ms, now);
  }

  function fmtDate(ms, now) {
    if (!ms) return '—';
    var dt = new Date(ms);
    var y = new Date(now || Date.now()).getFullYear();
    return dt.getDate() + ' ' + MONTHS[dt.getMonth()] + (dt.getFullYear() !== y ? ' ' + dt.getFullYear() : '');
  }

  function fmtTime(ms) {
    if (!ms) return '--:--';
    var d = new Date(ms);
    return pad2(d.getHours()) + ':' + pad2(d.getMinutes()) + ':' + pad2(d.getSeconds());
  }

  // ───────────────────────────────────────────────────────────── markdown seguro

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function mdInline(s) {
    // s ya viene escapado
    var codes = [];
    s = s.replace(/`([^`]+)`/g, function (_, c) { codes.push(c); return '\u0000' + (codes.length - 1) + '\u0000'; });
    s = s.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, function (_, t, u) {
      var ok = /^(https?:\/\/|#|\/|\.\/)/i.test(u.replace(/&amp;/g, '&'));
      return ok ? '<a href="' + u + '" target="_blank" rel="noopener noreferrer">' + t + '</a>' : t;
    });
    s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
      .replace(/__([^_]+)__/g, '<strong>$1</strong>')
      .replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>')
      .replace(/(^|[\s(])_([^_\n]+)_(?=[\s).,;:!?]|$)/g, '$1<em>$2</em>')
      .replace(/~~([^~]+)~~/g, '<del>$1</del>');
    s = s.replace(/\u0000(\d+)\u0000/g, function (_, i) { return '<code>' + codes[+i] + '</code>'; });
    return s;
  }

  function renderMarkdown(src) {
    var lines = String(src || '').replace(/\r\n?/g, '\n').split('\n');
    var out = [];
    var i = 0;
    var listStack = [];
    function closeLists(level) {
      while (listStack.length > level) out.push('</' + listStack.pop().tag + '>');
    }
    var para = [];
    function flushPara() {
      if (para.length) { out.push('<p>' + mdInline(para.join(' ')) + '</p>'); para = []; }
    }
    while (i < lines.length) {
      var raw = lines[i];
      var line = esc(raw);
      var fence = /^\s*(```|~~~)\s*([\w+-]*)/.exec(raw);
      if (fence) {
        flushPara(); closeLists(0);
        var buf = [];
        i++;
        while (i < lines.length && !new RegExp('^\\s*' + fence[1]).test(lines[i])) { buf.push(esc(lines[i])); i++; }
        i++;
        out.push('<pre><code' + (fence[2] ? ' data-lang="' + esc(fence[2]) + '"' : '') + '>' + buf.join('\n') + '</code></pre>');
        continue;
      }
      if (!raw.trim()) { flushPara(); closeLists(0); i++; continue; }
      var hm = /^(#{1,6})\s+(.*)$/.exec(raw);
      if (hm) {
        flushPara(); closeLists(0);
        var lvl = hm[1].length;
        out.push('<h' + lvl + '>' + mdInline(esc(hm[2].replace(/\s#+\s*$/, ''))) + '</h' + lvl + '>');
        i++; continue;
      }
      if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(raw)) { flushPara(); closeLists(0); out.push('<hr>'); i++; continue; }
      if (/^\s*>/.test(raw)) {
        flushPara(); closeLists(0);
        var q = [];
        while (i < lines.length && /^\s*>/.test(lines[i])) { q.push(esc(lines[i].replace(/^\s*>\s?/, ''))); i++; }
        out.push('<blockquote>' + mdInline(q.join(' ')) + '</blockquote>');
        continue;
      }
      if (/^\s*\|.*\|\s*$/.test(raw) && i + 1 < lines.length && /^\s*\|?\s*:?-{2,}/.test(lines[i + 1])) {
        flushPara(); closeLists(0);
        var cells = function (l) { return l.trim().replace(/^\||\|$/g, '').split('|').map(function (c) { return mdInline(esc(c.trim())); }); };
        var head = cells(raw);
        i += 2;
        var rows = [];
        while (i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i])) { rows.push(cells(lines[i])); i++; }
        out.push('<div class="md-table"><table><thead><tr>' + head.map(function (c) { return '<th>' + c + '</th>'; }).join('') + '</tr></thead><tbody>' +
          rows.map(function (r) { return '<tr>' + r.map(function (c) { return '<td>' + c + '</td>'; }).join('') + '</tr>'; }).join('') + '</tbody></table></div>');
        continue;
      }
      var lm = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/.exec(raw);
      if (lm) {
        flushPara();
        var indent = lm[1].replace(/\t/g, '  ').length;
        var level = Math.min(5, Math.floor(indent / 2)) + 1;
        var tag = /\d/.test(lm[2]) ? 'ol' : 'ul';
        if (listStack.length < level) {
          while (listStack.length < level) { out.push('<' + tag + '>'); listStack.push({ tag: tag }); }
        } else {
          closeLists(level);
          if (listStack[level - 1].tag !== tag) { out.push('</' + listStack.pop().tag + '>'); out.push('<' + tag + '>'); listStack.push({ tag: tag }); }
        }
        var body = lm[3];
        var cb = /^\[( |x|X)\]\s+(.*)$/.exec(body);
        if (cb) {
          var done = cb[1] !== ' ';
          out.push('<li class="task' + (done ? ' done' : '') + '"><span class="box">' + (done ? '■' : '□') + '</span> ' + mdInline(esc(cb[2])) + '</li>');
        } else out.push('<li>' + mdInline(esc(body)) + '</li>');
        i++; continue;
      }
      closeLists(0);
      para.push(line.trim());
      i++;
    }
    flushPara(); closeLists(0);
    return out.join('\n');
  }

  return {
    VERSION: VERSION,
    STATE_VERSION: STATE_VERSION,
    LIMITS: LIMITS,
    HOT_WINDOW: HOT_WINDOW,
    CATEGORIES: CATEGORIES,
    STAGES: STAGES,
    // utilidades
    toMs: toMs, trunc: trunc, normPath: normPath, baseName: baseName, shortPath: shortPath,
    projectKeyFromCwd: projectKeyFromCwd, originLabel: originLabel, describeTool: describeTool, waitPhrase: waitPhrase,
    cleanPrompt: cleanPrompt, planTitle: planTitle, planSteps: planSteps, detectCategory: detectCategory,
    dayKey: dayKey, startOfDay: startOfDay,
    // parser
    createSessionState: createSessionState, ingestEntry: ingestEntry, publicSession: publicSession,
    // colector
    Collector: Collector,
    // modelo
    defaultConfig: defaultConfig, normalizeConfig: normalizeConfig, buildModel: buildModel,
    inferState: inferState, sessionTitle: sessionTitle,
    // formato
    fmtNum: fmtNum, fmtTok: fmtTok, fmtDur: fmtDur, fmtAgo: fmtAgo, fmtDate: fmtDate, fmtTime: fmtTime,
    esc: esc, renderMarkdown: renderMarkdown
  };
});
