/*!
 * NEXUS — interfaz del centro de mando.
 * Sin dependencias: plantillas de texto + un "morph" mínimo del DOM para que las
 * actualizaciones en vivo no reinicien animaciones, scroll ni foco.
 */
(function () {
  'use strict';

  var C = window.NexusCore;
  var FS = window.NexusFS;
  var DEMO = window.NexusDemo;
  var esc = C.esc;

  function $(sel, root) { return (root || document).querySelector(sel); }
  function $$(sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); }

  // ───────────────────────────────────────────────────────────── preferencias

  var PREF_KEY = 'nexus.prefs.v1';
  var DEFAULT_PREFS = {
    fx: true, calm: false, toasts: true, notify: false, sound: false,
    metric: 'tools', pcat: 'all', psort: 'activity', phidden: false,
    tview: 'board', trange: 'all', tsrc: 'all', tstale: false,
    rsrc: 'all', rst: 'all', rrange: '7',
    sst: 'all', ssort: 'updatedAt', sdir: -1,
    plst: 'all', heatTable: false, actTable: false
  };

  function loadPrefs() {
    var p = {};
    try { p = JSON.parse(localStorage.getItem(PREF_KEY) || '{}') || {}; } catch (e) { p = {}; }
    var out = {};
    for (var k in DEFAULT_PREFS) out[k] = Object.prototype.hasOwnProperty.call(p, k) ? p[k] : DEFAULT_PREFS[k];
    return out;
  }

  function savePrefs() {
    try { localStorage.setItem(PREF_KEY, JSON.stringify(S.p)); } catch (e) { /* almacenamiento bloqueado */ }
  }

  function cfgKey() { return S.source === 'demo' ? 'nexus.config.demo' : 'nexus.config.v1'; }

  function loadLocalConfig() {
    try { return C.normalizeConfig(JSON.parse(localStorage.getItem(cfgKey()) || 'null')); } catch (e) { return C.defaultConfig(); }
  }

  // ───────────────────────────────────────────────────────────── estado

  var VIEWS_OK = { overview: 1, projects: 1, project: 1, tasks: 1, plans: 1, runs: 1, sessions: 1, session: 1, settings: 1 };

  var S = {
    source: null,
    data: { sessions: {}, taskLists: {}, plans: {}, live: {}, meta: {} },
    config: C.defaultConfig(),
    model: null,
    seq: 0,
    ready: false,
    link: 'none',
    route: parseRoute(),
    p: loadPrefs(),
    t: { q: {}, proj: {} },
    more: {},
    expanded: {},
    prev: {},
    primed: false,
    fresh: true,
    buffer: [],
    loading: false,
    lastFeed: 0,
    claudeDir: null,
    server: null,
    progress: null,
    embedded: (function () { try { return window.top !== window.self; } catch (e) { return true; } })()
  };

  // ───────────────────────────────────────────────────────────── constantes de texto

  var STATE_TXT = { working: 'Trabajando', waiting: 'Te espera', idle: 'Abierta', ended: 'Cerrada', recent: 'Hoy', dormant: 'En pausa' };
  var PSTATE_TXT = { working: 'Trabajando', waiting: 'Te espera', idle: 'Abierto', recent: 'Activo hoy', dormant: 'En pausa' };
  var STATUS_TXT = { pending: 'Pendiente', in_progress: 'En curso', completed: 'Completada', blocked: 'Bloqueada' };
  var PLAN_TXT = { pending: 'Pendiente', approved: 'Aprobado', rejected: 'Rechazado', draft: 'Borrador' };
  var RUN_TXT = { run: 'En curso', wait: 'Te espera', ok: 'Completada', int: 'Interrumpida', err: 'Con errores' };
  var SRC_TXT = { human: 'Prompt', command: 'Comando', auto: 'Automática' };
  var KIND_GLYPH = { prompt: '»', tool: '▸', text: '◦', task: '✓', plan: '◆', error: '✕', int: '‖', pr: '↑', compact: '≡', shell: '!' };
  var CAT = {};
  C.CATEGORIES.forEach(function (c) { CAT[c.id] = c; });

  var waitText = C.waitPhrase;

  function plural(n, one, many) { return C.fmtNum(n) + ' ' + (n === 1 ? one : many); }

  // ───────────────────────────────────────────────────────────── utilidades de vista

  function ago(t) { return C.fmtAgo(t, S.model ? S.model.now : Date.now()); }
  function hrefProject(key) { return '#/project/' + encodeURIComponent(key); }
  function hrefSession(id) { return '#/session/' + encodeURIComponent(id); }
  function hrefPlan(id) { return '#/plans/' + encodeURIComponent(id); }
  function projName(key) { var p = key && S.model.projectMap[key]; return p ? p.name : (key ? C.baseName(key) : 'Sin proyecto'); }
  function projCat(key) { var p = key && S.model.projectMap[key]; return p ? p.category : 'other'; }

  function shortHome(p) {
    if (!p) return '';
    var x = C.normPath(p).replace(/^\/(Users|home)\/[^/]+/, '~').replace(/^[a-z]:\/users\/[^/]+/i, '~');
    return x.length > 46 ? '…' + x.slice(-45) : x;
  }

  function relTo(file, base) {
    var f = C.normPath(file);
    var b = C.normPath(base || '');
    if (b && f.indexOf(b + '/') === 0) return f.slice(b.length + 1);
    return shortHome(f);
  }

  function hm(t) {
    var d = new Date(t);
    return (d.getHours() < 10 ? '0' : '') + d.getHours() + ':' + (d.getMinutes() < 10 ? '0' : '') + d.getMinutes();
  }

  var DOW = ['dom', 'lun', 'mar', 'mié', 'jue', 'vie', 'sáb'];
  var MONTHS = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];
  function fmtDay(t) { var d = new Date(t); return DOW[d.getDay()] + ' ' + d.getDate() + ' ' + MONTHS[d.getMonth()]; }

  function dayLabel(t, now) {
    var d0 = C.startOfDay(now);
    if (t >= d0) return 'Hoy';
    if (t >= d0 - 86400000) return 'Ayer';
    return fmtDay(t);
  }

  function fmtBytes(n) {
    n = +n || 0;
    if (n < 1024) return n + ' B';
    if (n < 1048576) return (n / 1024).toFixed(0) + ' KB';
    if (n < 1073741824) return (n / 1048576).toFixed(1).replace('.', ',') + ' MB';
    return (n / 1073741824).toFixed(2).replace('.', ',') + ' GB';
  }

  function safeUrl(u) { return /^https?:\/\//i.test(String(u || '')) ? String(u) : '#'; }

  function orb(st) { return '<span class="orb ' + esc(st) + '" aria-hidden="true"></span>'; }
  function stateTag(st, label) { return '<span class="state ' + esc(st) + '">' + orb(st) + esc(label || STATE_TXT[st] || st) + '</span>'; }

  function chip(cat, label) {
    var c = CAT[cat] || CAT.other;
    return '<span class="chip cat-' + c.id + '"><span class="g" aria-hidden="true">' + esc(c.glyph) + '</span>' + esc(label || c.short) + '</span>';
  }

  function projChip(key) {
    return '<a class="chip cat-' + esc(projCat(key)) + '" href="' + hrefProject(key) + '"><span class="g" aria-hidden="true">' + esc((CAT[projCat(key)] || CAT.other).glyph) + '</span>' + esc(projName(key)) + '</a>';
  }

  function progress(done, total) {
    if (!total) return '';
    var pct = Math.round((done / total) * 100);
    return '<div class="prog"><div class="bar"><i style="width:' + pct + '%"></i></div><span class="num">' + done + '/' + total + '</span></div>';
  }

  function ring(done, total, size) {
    size = size || 56;
    var r = size / 2 - 5;
    var c = 2 * Math.PI * r;
    var pct = total ? done / total : 0;
    var cx = size / 2;
    return '<svg class="ring" width="' + size + '" height="' + size + '" viewBox="0 0 ' + size + ' ' + size + '" role="img" aria-label="' +
      (total ? done + ' de ' + total + ' tareas completadas' : 'Sin tareas') + '">' +
      '<circle class="track" cx="' + cx + '" cy="' + cx + '" r="' + r + '" fill="none" stroke-width="4"/>' +
      (total ? '<circle class="fill" cx="' + cx + '" cy="' + cx + '" r="' + r + '" fill="none" stroke-width="4" stroke-dasharray="' + c.toFixed(2) + '" stroke-dashoffset="' + (c * (1 - pct)).toFixed(2) + '" transform="rotate(-90 ' + cx + ' ' + cx + ')"/>' : '') +
      '<text x="' + cx + '" y="' + (cx + 1) + '" text-anchor="middle" dominant-baseline="middle" font-size="' + Math.round(size * (pct >= 0.995 ? 0.2 : 0.24)) + '">' + (total ? Math.round(pct * 100) + '%' : '—') + '</text></svg>';
  }

  var ICONS = {
    pending: '<svg class="st pending" viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="6" fill="none" stroke="currentColor" stroke-width="1.5"/></svg>',
    in_progress: '<svg class="st in_progress" viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="6" fill="none" stroke="currentColor" stroke-width="1.5"/><path d="M8 2a6 6 0 0 1 0 12z" fill="currentColor"/></svg>',
    completed: '<svg class="st completed" viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="6.5" fill="currentColor" opacity=".16"/><path d="M4.8 8.3l2.1 2.1 4.3-4.6" fill="none" stroke="currentColor" stroke-width="1.8"/></svg>',
    blocked: '<svg class="st blocked" viewBox="0 0 16 16" aria-hidden="true"><path d="M8 1.6L14.4 8 8 14.4 1.6 8z" fill="none" stroke="currentColor" stroke-width="1.5"/><path d="M8 5v3.6M8 10.6v.6" stroke="currentColor" stroke-width="1.6"/></svg>',
    warn: '<svg class="ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M12 3l10 18H2L12 3z"/><path d="M12 10v5M12 18v.5"/></svg>',
    pin: '<svg class="pin" viewBox="0 0 16 16" aria-hidden="true"><path d="M5 1.5h6l-1 4 2.5 2.5v1.5h-4v5l-.5.5-.5-.5v-5H3.5V8L6 5.5z" fill="currentColor"/></svg>'
  };

  function taskIcon(t) { return ICONS[t.blocked ? 'blocked' : t.status] || ICONS.pending; }

  // Máximo "redondo" y par para conteos: la marca intermedia del eje siempre es un entero.
  function niceMaxInt(v) {
    if (v <= 2) return 2;
    var p = Math.pow(10, Math.floor(Math.log10(v)));
    var steps = [1, 2, 4, 5, 10];
    for (var i = 0; i < steps.length; i++) {
      var c = steps[i] * p;
      if (c >= v && c % 2 === 0) return c;
    }
    return 10 * p;
  }

  function niceMax(v) {
    if (v <= 0) return 1;
    var p = Math.pow(10, Math.floor(Math.log10(v)));
    var f = v / p;
    var n = f <= 1 ? 1 : f <= 2 ? 2 : f <= 2.5 ? 2.5 : f <= 5 ? 5 : 10;
    return n * p;
  }

  function seg(pref, options, value, label) {
    return '<div class="seg" role="group" aria-label="' + esc(label || '') + '">' + options.map(function (o) {
      return '<button type="button" data-act="seg" data-pref="' + pref + '" data-val="' + esc(o[0]) + '" aria-pressed="' + (String(value) === String(o[0])) + '">' +
        esc(o[1]) + (o[2] !== undefined ? '<span class="n">' + esc(o[2]) + '</span>' : '') + '</button>';
    }).join('') + '</div>';
  }

  function projectSelect(bindKey, value, label) {
    var opts = S.model.projects.filter(function (p) { return !p.hidden || p.key === value; })
      .slice().sort(function (a, b) { return a.name.localeCompare(b.name, 'es'); });
    return '<select class="select" id="sel-' + esc(bindKey) + '" data-bind="proj.' + esc(bindKey) + '" aria-label="' + esc(label || 'Proyecto') + '">' +
      '<option value="">Todos los proyectos</option>' +
      opts.map(function (p) { return '<option value="' + esc(p.key) + '"' + (p.key === value ? ' selected' : '') + '>' + esc(p.name) + '</option>'; }).join('') +
      '</select>';
  }

  function searchBox(bindKey, placeholder) {
    return '<input class="input" type="search" id="q-' + esc(bindKey) + '" data-bind="q.' + esc(bindKey) + '" value="' + esc(S.t.q[bindKey] || '') + '" placeholder="' + esc(placeholder) + '" aria-label="' + esc(placeholder) + '" style="width:min(280px,100%)">';
  }

  function moreBtn(key, shown, total, step) {
    if (shown >= total) return '';
    return '<button class="more" type="button" data-act="more" data-more="' + esc(key) + '" data-step="' + (step || 60) + '">Mostrar ' + Math.min(step || 60, total - shown) + ' más · quedan ' + C.fmtNum(total - shown) + '</button>';
  }

  function limit(key, base) { return S.more[key] || base; }

  function empty(text) { return '<div class="empty">' + text + '</div>'; }

  function hashStr(s) {
    var h = 0;
    for (var i = 0; i < s.length; i++) h = ((h << 5) - h + s.charCodeAt(i)) | 0;
    return (h >>> 0).toString(36);
  }

  function since(range, now) {
    if (range === 'today') return C.startOfDay(now);
    if (range === '7') return now - 7 * 86400000;
    if (range === '30') return now - 30 * 86400000;
    return 0;
  }

  // ───────────────────────────────────────────────────────────── gráficos

  var widths = {};
  var ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(function (entries) {
    var dirty = false;
    entries.forEach(function (e) {
      var id = e.target.getAttribute('data-chart');
      var w = Math.round(e.contentRect.width);
      if (w > 0 && Math.abs((widths[id] || 0) - w) > 3) { widths[id] = w; dirty = true; }
    });
    if (dirty) requestRender();
  }) : null;

  function observeCharts() {
    if (!ro) return;
    $$('[data-chart]').forEach(function (el) {
      if (el.__nx) return;
      el.__nx = true;
      ro.observe(el);
    });
  }

  function cw(id, fallback) { return widths[id] || fallback; }

  function barPath(x, y, w, h, r) {
    r = Math.min(r, w / 2, h);
    return 'M' + x.toFixed(1) + ',' + (y + h).toFixed(1) + 'V' + (y + r).toFixed(1) +
      'Q' + x.toFixed(1) + ',' + y.toFixed(1) + ' ' + (x + r).toFixed(1) + ',' + y.toFixed(1) +
      'H' + (x + w - r).toFixed(1) + 'Q' + (x + w).toFixed(1) + ',' + y.toFixed(1) + ' ' + (x + w).toFixed(1) + ',' + (y + r).toFixed(1) +
      'V' + (y + h).toFixed(1) + 'Z';
  }

  // Serie de una sola línea: área al 12 %, línea de 2 px, punto final.
  function spark(id, vals, h, tips) {
    var w = cw(id, 200);
    h = h || 30;
    var n = vals.length;
    if (!n) return '<div data-chart="' + esc(id) + '"></div>';
    var max = Math.max.apply(null, vals.concat([1]));
    var pad = 4;
    var x = function (i) { return n === 1 ? w / 2 : pad + (i * (w - 2 * pad)) / (n - 1); };
    var y = function (v) { return h - pad - (v / max) * (h - 2 * pad); };
    var d = '';
    for (var i = 0; i < n; i++) d += (i ? 'L' : 'M') + x(i).toFixed(1) + ',' + y(vals[i]).toFixed(1);
    var area = d + 'L' + x(n - 1).toFixed(1) + ',' + h + 'L' + x(0).toFixed(1) + ',' + h + 'Z';
    var hits = '';
    if (tips) {
      var slot = w / n;
      for (var j = 0; j < n; j++) {
        hits += '<rect class="hit" x="' + (j * slot).toFixed(1) + '" y="0" width="' + slot.toFixed(1) + '" height="' + h + '" data-tv="' + esc(tips[j][0]) + '" data-tl="' + esc(tips[j][1]) + '"/>';
      }
    }
    return '<div class="chart" data-chart="' + esc(id) + '"><svg viewBox="0 0 ' + w + ' ' + h + '" aria-hidden="true">' +
      '<path class="spark-area" d="' + area + '"/><path class="spark-line" d="' + d + '"/>' +
      '<circle class="spark-dot" cx="' + x(n - 1).toFixed(1) + '" cy="' + y(vals[n - 1]).toFixed(1) + '" r="4"/>' + hits + '</svg></div>';
  }

  // Columnas con una sola escala; la última (actual) en el color de acento.
  function columns(id, data, opts) {
    var w = cw(id, opts.w || 520);
    var h = opts.h || 160;
    var padL = 40, padR = 4, padT = 10, padB = 22;
    var iw = Math.max(40, w - padL - padR);
    var ih = h - padT - padB;
    var top = Math.max.apply(null, data.map(function (d) { return d.v; }).concat([1]));
    var max = opts.integer ? niceMaxInt(top) : niceMax(top);
    var n = data.length;
    var slot = iw / n;
    var bw = Math.max(2, Math.min(24, slot - Math.max(2, slot * 0.3)));
    var g = '';
    [0, 0.5, 1].forEach(function (f) {
      var yy = (padT + ih - f * ih).toFixed(1);
      g += '<line class="grid-l" x1="' + padL + '" x2="' + (w - padR) + '" y1="' + yy + '" y2="' + yy + '"/>' +
        '<text class="axis" x="' + (padL - 7) + '" y="' + (+yy + 3) + '" text-anchor="end">' + esc(opts.fmt(max * f)) + '</text>';
    });
    var every = Math.max(1, Math.ceil(n / Math.max(4, Math.floor(iw / 46))));
    data.forEach(function (d, i) {
      var x = padL + i * slot + (slot - bw) / 2;
      var bh = d.v ? Math.max(2, (d.v / max) * ih) : 0;
      var y = padT + ih - bh;
      g += '<rect class="hit" x="' + (padL + i * slot).toFixed(1) + '" y="' + padT + '" width="' + slot.toFixed(1) + '" height="' + ih + '" tabindex="0" data-tv="' + esc(opts.tip(d.v)) + '" data-tl="' + esc(d.tip) + '"/>';
      if (bh) g += '<path class="bar-m' + (d.cur ? ' cur' : '') + '" d="' + barPath(x, y, bw, bh, 4) + '"/>';
      if (d.label && (i % every === 0 || i === n - 1) && (i === n - 1 || n - 1 - i >= every / 2)) {
        g += '<text class="axis" x="' + (x + bw / 2).toFixed(1) + '" y="' + (h - 6) + '" text-anchor="middle">' + esc(d.label) + '</text>';
      }
    });
    return '<div class="chart" data-chart="' + esc(id) + '"><svg viewBox="0 0 ' + w + ' ' + h + '" role="img" aria-label="' + esc(opts.aria) + '">' + g + '</svg></div>';
  }

  function heatmap(id, days) {
    var w = cw(id, 460);
    var weeks = 26;
    var labelW = 24;
    var top = 16;
    var gap = 3;
    var cell = Math.max(7, Math.min(16, Math.floor((w - labelW) / weeks) - gap));
    var step = cell + gap;
    var span = days.slice(-weeks * 7);
    var lastDate = new Date(span[span.length - 1].t);
    var lastRow = (lastDate.getDay() + 6) % 7; // lunes = 0
    var endIdx = (weeks - 1) * 7 + lastRow;
    var nz = span.map(function (d) { return d.runs; }).filter(function (v) { return v > 0; }).sort(function (a, b) { return a - b; });
    var q = function (k) { return nz.length ? nz[Math.min(nz.length - 1, Math.floor(nz.length * k))] : 0; };
    var th = [q(0.2), q(0.45), q(0.7), q(0.9)];
    var level = function (v) { return v <= 0 ? 0 : v <= th[0] ? 1 : v <= th[1] ? 2 : v <= th[2] ? 3 : v <= th[3] ? 4 : 5; };
    var g = '';
    var monthSeen = {};
    for (var i = span.length - 1; i >= 0; i--) {
      var idx = endIdx - (span.length - 1 - i);
      if (idx < 0) break;
      var col = Math.floor(idx / 7);
      var row = idx % 7;
      var d = span[i];
      var dt = new Date(d.t);
      g += '<rect class="cell h' + level(d.runs) + '" x="' + (labelW + col * step) + '" y="' + (top + row * step) + '" width="' + cell + '" height="' + cell + '" rx="2" data-tv="' +
        esc(d.runs + (d.runs === 1 ? ' tanda' : ' tandas')) + '" data-tl="' + esc(fmtDay(d.t) + ' · ' + C.fmtNum(d.tools) + ' herramientas · ' + d.done + ' tareas completadas') + '"/>';
      if (dt.getDate() <= 7 && row === 0) monthSeen[col] = MONTHS[dt.getMonth()];
    }
    for (var c in monthSeen) g += '<text class="lbl" x="' + (labelW + c * step) + '" y="10">' + monthSeen[c] + '</text>';
    [['L', 0], ['X', 2], ['V', 4]].forEach(function (l) { g += '<text class="lbl" x="2" y="' + (top + l[1] * step + cell - 2) + '">' + l[0] + '</text>'; });
    var vw = labelW + weeks * step;
    var vh = top + 7 * step;
    return '<div class="heat" data-chart="' + esc(id) + '"><svg viewBox="0 0 ' + vw + ' ' + vh + '" width="' + vw + '" height="' + vh + '" role="img" aria-label="Tandas por día en las últimas 26 semanas">' + g + '</svg>' +
      '<div class="heat-legend" aria-hidden="true">Menos <i style="background:var(--heat-0)"></i><i style="background:var(--heat-1)"></i><i style="background:var(--heat-2)"></i><i style="background:var(--heat-3)"></i><i style="background:var(--heat-4)"></i><i style="background:var(--heat-5)"></i> Más</div></div>';
  }

  function hbars(items) {
    var max = Math.max.apply(null, items.map(function (i) { return i.v; }).concat([1]));
    return '<div class="hbars">' + items.map(function (i) {
      return '<div class="hbar"><span class="l" title="' + esc(i.l) + '">' + esc(i.l) + '</span><span class="b"><i style="width:' + ((i.v / max) * 100).toFixed(1) + '%"></i></span><span class="v">' + C.fmtNum(i.v) + '</span></div>';
    }).join('') + '</div>';
  }

  var mdCache = new Map();
  function md(src) {
    src = src || '';
    if (mdCache.has(src)) return mdCache.get(src);
    var out = C.renderMarkdown(src);
    mdCache.set(src, out);
    if (mdCache.size > 40) mdCache.delete(mdCache.keys().next().value);
    return out;
  }

  // ───────────────────────────────────────────────────────────── piezas compartidas

  function pageHead(title, lede, extra, crumbs) {
    return '<div class="page-head"><div>' + (crumbs ? '<div class="crumbs">' + crumbs + '</div>' : '') + '<h1>' + title + '</h1>' +
      (lede ? '<p class="lede">' + lede + '</p>' : '') + '</div>' + (extra ? '<div class="toolbar">' + extra + '</div>' : '') + '</div>';
  }

  function sessionNow(s) {
    if (s.state === 'waiting') return waitText(s.waitingFor);
    if (s.current) return s.current.x;
    if (s.last) return s.last.x;
    return s.lastPrompt || s.title;
  }

  function opRow(s) {
    return '<a class="op ' + esc(s.state) + '" href="' + hrefSession(s.id) + '" data-key="op-' + esc(s.id) + '">' + orb(s.state) +
      '<div class="op-top"><span class="op-name">' + esc(s.project) + '</span>' + chip(s.category) + '<span class="tag">' + esc(s.origin) + '</span><span class="op-title">' + esc(s.title) + '</span></div>' +
      '<div class="op-side">' + stateTag(s.state) + '<span class="t">' + esc(ago(s.updatedAt)) + '</span></div>' +
      '<div class="op-now' + (s.state === 'working' ? ' cursor' : '') + '">' + esc(sessionNow(s)) + '</div>' +
      (s.tasks.total ? progress(s.tasks.completed, s.tasks.total) : '') + '</a>';
  }

  function runStatus(r) { return r.st === 'ok' && r.err ? 'err' : r.st; }

  function runBadge(st) {
    return '<span class="badge s-' + esc(st) + '">' + esc(RUN_TXT[st] || st) + '</span>';
  }

  function planBadge(st) {
    return '<span class="badge s-' + esc(st) + '">' + esc(PLAN_TXT[st] || st) + '</span>';
  }

  function runOrb(st) { return st === 'run' ? 'working' : st === 'wait' ? 'waiting' : st === 'ok' ? 'done' : 'error'; }

  function runRow(r, withProject) {
    var st = runStatus(r);
    var open = !!S.expanded[r.id];
    var dur = Math.max(0, (r.e || r.t) - r.t);
    var head = (withProject ? projChip(r.key) : '') + runBadge(st) +
      (r.src !== 'human' ? '<span class="tag">' + esc(SRC_TXT[r.src] || r.src) + '</span>' : '') +
      '<a class="sess-link" href="' + hrefSession(r.sessionId) + '">sesión ›</a>';
    var details = '';
    if (open) {
      if (r.res) details += '<div class="res">' + esc(r.res) + '</div>';
      if (r.files && r.files.length) {
        var base = S.model.sessionMap[r.sessionId] ? S.model.sessionMap[r.sessionId].cwd : null;
        details += '<div class="files">' + r.files.slice(-16).map(function (f) { return '<span class="file" title="' + esc(f) + '">' + esc(relTo(f, base)) + '</span>'; }).join('') + '</div>';
      }
      if (!details) details = '<div class="res dim">Sin detalles adicionales.</div>';
    }
    return '<article class="run' + (open ? ' open' : '') + '" data-key="run-' + esc(r.id) + '">' +
      '<div class="time">' + hm(r.t) + '</div><div class="rail-line">' + orb(runOrb(st)) + '</div><div style="min-width:0">' +
      '<div class="head">' + head + '</div>' +
      '<div class="prompt' + (r.src === 'command' ? ' cmd' : '') + '">' + esc(r.p) + '</div>' +
      '<div class="metrics"><span><b>' + esc(C.fmtDur(dur)) + '</b></span><span><b>' + r.tools + '</b> herramientas</span><span><b>' + r.ed + '</b> ediciones</span>' +
      (r.sub ? '<span><b>' + r.sub + '</b> subagentes</span>' : '') + '<span><b>' + esc(C.fmtTok(r.tk)) + '</b> tokens</span>' +
      (r.err ? '<span class="err">' + r.err + (r.err === 1 ? ' error' : ' errores') + '</span>' : '') +
      '<button class="toggle" type="button" data-act="run" data-id="' + esc(r.id) + '" aria-expanded="' + open + '">' + (open ? 'Ocultar' : 'Detalles') + '</button></div>' +
      details + '</div></article>';
  }

  function taskCard(t) {
    var col = t.status === 'completed' ? 'completed' : t.blocked ? 'blocked' : t.status;
    var href = t.sessionId ? hrefSession(t.sessionId) : hrefProject(t.key);
    var when = t.status === 'completed' && t.completedAt ? t.completedAt : t.updated;
    return '<a class="tcard' + (t.status === 'completed' ? ' done' : '') + '" href="' + href + '" data-key="tk-' + esc(t.uid) + '">' +
      '<div class="subj">' + esc(t.subject) + '</div>' +
      (t.status === 'in_progress' && t.activeForm ? '<div class="af">▸ ' + esc(t.activeForm) + '</div>' : '') +
      (t.blocked ? '<div class="blk">Espera a ' + esc(t.blockedBy.map(function (x) { return '#' + x; }).join(', ')) + '</div>' : '') +
      '<div class="foot">' + chip(projCat(t.key), projName(t.key)) + (t.source === 'todo' ? '<span class="tag">TODO</span>' : '<span class="tag">#' + esc(t.id) + '</span>') +
      (t.stale ? '<span class="tag">abandonada</span>' : '') + '<span class="t">' + esc(ago(when)) + '</span></div></a>';
  }

  function taskItem(t) {
    var href = t.sessionId ? hrefSession(t.sessionId) : hrefProject(t.key);
    return '<a class="titem" href="' + href + '" data-key="ti-' + esc(t.uid) + '">' + taskIcon(t) +
      '<div class="grow"><div>' + esc(t.subject) + '</div>' +
      (t.status === 'in_progress' && t.activeForm ? '<small class="mono" style="color:var(--cyan)">▸ ' + esc(t.activeForm) + '</small>' : '') +
      (t.blocked ? '<small style="color:var(--amber)">Espera a ' + esc(t.blockedBy.map(function (x) { return '#' + x; }).join(', ')) + '</small>' : '') +
      '</div><small class="nowrap">' + esc(t.status === 'completed' && t.completedAt ? ago(t.completedAt) : STATUS_TXT[t.blocked ? 'blocked' : t.status]) + '</small></a>';
  }

  function feedLines(items, withProject) {
    var html = items.map(function (f) {
      var fresh = S.lastFeed && f.t > S.lastFeed ? ' fresh' : '';
      return '<a class="tl k-' + esc(f.k) + (f.sub ? ' sub' : '') + fresh + '" href="' + hrefSession(f.sessionId) + '" data-key="f-' + esc(f.sessionId.slice(0, 8)) + '-' + f.t + '-' + hashStr(f.x) + '">' +
        '<span class="ts">' + C.fmtTime(f.t) + '</span>' + (withProject ? '<span class="pj">' + esc(projName(f.key)) + '</span>' : '<span class="pj">' + esc(f.sub ? 'subagente' : 'principal') + '</span>') +
        '<span class="k" aria-hidden="true">' + (KIND_GLYPH[f.k] || '·') + '</span><span class="x">' + esc(f.x) + '</span></a>';
    }).join('');
    return html;
  }

  function demoStrip() {
    return '<div class="panel" style="--c:10px;--edge:var(--line-3)"><div class="panel-b" style="display:flex;gap:14px;align-items:center;flex-wrap:wrap">' +
      '<span class="badge s-draft">Demo</span><span class="steel" style="flex:1;min-width:220px">Datos de ejemplo que se mueven solos. Para ver tus proyectos reales ejecuta el servidor local o conecta tu carpeta <span class="mono">~/.claude</span>.</span>' +
      '<button class="btn small" type="button" data-act="show-connect">Conectar datos reales</button></div></div>';
  }

  // ───────────────────────────────────────────────────────────── vista: centro de mando

  function vOverview(m) {
    var k = m.kpis;
    var now = m.now;
    var today0 = C.startOfDay(now);
    var rank = { waiting: 0, working: 1, idle: 2 };
    var live = m.sessions.filter(function (s) { return s.state === 'working' || s.state === 'waiting' || (s.state === 'idle' && s.live); });
    live.sort(function (a, b) { return (rank[a.state] - rank[b.state]) || (b.updatedAt - a.updatedAt); });
    var waiting = live.filter(function (s) { return s.state === 'waiting'; });
    var d14 = m.daily.slice(-14);
    var d7 = m.daily.slice(-7);
    var sum = function (arr, f) { return arr.reduce(function (a, d) { return a + d[f]; }, 0); };
    var tips = function (f, unit) { return d14.map(function (d) { return [C.fmtNum(d[f]) + ' ' + unit, fmtDay(d.t)]; }); };
    var tipsTok = d14.map(function (d) { return [C.fmtTok(d.tokens) + ' tokens', fmtDay(d.t)]; });
    var workingProjects = {};
    m.sessions.forEach(function (s) { if (s.state === 'working') workingProjects[s.key] = 1; });
    var nWP = Object.keys(workingProjects).length;

    var lede = (k.working ? '<b>' + k.working + '</b> ' + (k.working === 1 ? 'sesión trabajando' : 'sesiones trabajando') + ' en <b>' + nWP + '</b> ' + (nWP === 1 ? 'proyecto' : 'proyectos') : 'Ninguna sesión trabajando ahora') +
      ' · <b>' + k.tasksOpen + '</b> tareas abiertas · ' + (m.feed.length ? 'última actividad ' + esc(ago(m.feed[0].t)) : 'sin actividad registrada');

    var alert = waiting.length ? '<div class="panel alert" style="--c:10px">' + ICONS.warn + '<div><strong>' + waiting.length + (waiting.length === 1 ? ' sesión te espera' : ' sesiones te esperan') + '</strong><div class="items">' +
      waiting.map(function (s) { return '<a href="' + hrefSession(s.id) + '">' + esc(s.project) + '<small>' + esc(waitText(s.waitingFor)) + '</small></a>'; }).join('') + '</div></div></div>' : '';

    var tiles = [
      '<a class="panel kpi' + (k.working ? ' hot' : '') + '" href="#/sessions" data-act="goto-state" data-state="working"><div class="kpi-label">' + orb(k.working ? 'working' : 'ended') + 'En ejecución</div><div class="kpi-value">' + k.working + '</div><div class="kpi-sub"><b>' + k.open + '</b> ' + (k.open === 1 ? 'abierta' : 'abiertas') + ' · <b>' + k.idle + '</b> en espera</div></a>',
      '<a class="panel kpi' + (k.waiting ? ' warn' : '') + '" href="#/sessions" data-act="goto-state" data-state="waiting"><div class="kpi-label">' + orb(k.waiting ? 'waiting' : 'ended') + 'Te esperan</div><div class="kpi-value">' + k.waiting + '</div><div class="kpi-sub">' + (k.waiting ? esc(waiting.map(function (s) { return s.project; }).join(', ')) : 'Nada pendiente de ti') + '</div></a>',
      '<a class="panel kpi" href="#/tasks"><div class="kpi-label">Tareas abiertas</div><div class="kpi-value">' + k.tasksOpen + '</div><div class="kpi-sub"><b>' + k.tasksActive + '</b> en curso · <b>' + k.tasksBlocked + '</b> bloqueadas</div></a>',
      '<a class="panel kpi" href="#/tasks" data-act="goto-done"><div class="kpi-label">Completadas hoy</div><div class="kpi-value">' + k.doneToday + '</div><div class="kpi-sub"><b>' + sum(d7, 'done') + '</b> en 7 días</div><div class="kpi-spark">' + spark('ks-done', d14.map(function (d) { return d.done; }), 30, tips('done', 'completadas')) + '</div></a>',
      '<a class="panel kpi" href="#/runs"><div class="kpi-label">Tandas hoy</div><div class="kpi-value">' + k.runsToday + '</div><div class="kpi-sub"><b>' + k.editsToday + '</b> ediciones · <b>' + C.fmtNum(k.toolsToday) + '</b> herr.</div><div class="kpi-spark">' + spark('ks-runs', d14.map(function (d) { return d.runs; }), 30, tips('runs', 'tandas')) + '</div></a>',
      '<div class="panel kpi"><div class="kpi-label">Tokens hoy</div><div class="kpi-value">' + esc(C.fmtTok(k.tokensToday)) + '</div><div class="kpi-sub"><b>' + esc(C.fmtTok(sum(d7, 'tokens'))) + '</b> en 7 días</div><div class="kpi-spark">' + spark('ks-tok', d14.map(function (d) { return d.tokens; }), 30, tipsTok) + '</div></div>'
    ].join('');

    // Actividad de las últimas 24 h
    var metric = S.p.metric;
    var fmtM = metric === 'tokens' ? C.fmtTok : function (v) { return C.fmtNum(Math.round(v)); };
    var unit = metric === 'tokens' ? 'tokens' : metric === 'runs' ? 'tandas' : 'herramientas';
    var hourly = m.hourly.map(function (hr, i) {
      var d = new Date(hr.t);
      return { v: hr[metric], cur: i === m.hourly.length - 1, label: (d.getHours() < 10 ? '0' : '') + d.getHours() + 'h', tip: hm(hr.t) + '–' + hm(hr.t + 3600000) };
    });
    var actBody = S.p.actTable
      ? '<div class="tablewrap" style="max-height:240px"><table class="grid plain"><thead><tr><th>Hora</th><th class="n">' + unit + '</th></tr></thead><tbody>' +
        hourly.slice().reverse().map(function (d) { return '<tr><td>' + esc(d.tip) + '</td><td class="n">' + esc(fmtM(d.v)) + '</td></tr>'; }).join('') + '</tbody></table></div>'
      : columns('act24', hourly, { h: 170, integer: metric !== 'tokens', fmt: fmtM, tip: function (v) { return fmtM(v) + ' ' + unit; }, aria: unit + ' por hora en las últimas 24 horas' });

    // Completado hoy
    var doneToday = m.tasks.filter(function (t) { return t.completedAt && t.completedAt >= today0; }).sort(function (a, b) { return b.completedAt - a.completedAt; });
    var prsToday = [];
    m.projects.forEach(function (p) { p.prs.forEach(function (pr) { if (pr.t >= today0) prsToday.push({ pr: pr, key: p.key }); }); });
    var doneRows = prsToday.map(function (x) {
      return '<a class="row" href="' + esc(safeUrl(x.pr.url)) + '" target="_blank" rel="noopener noreferrer" data-key="pr-' + esc(x.pr.url) + '"><span class="badge s-run">PR #' + esc(x.pr.n || '?') + '</span><div class="grow"><div class="line1">' + esc(x.pr.repo || x.pr.url) + '</div></div>' + chip(projCat(x.key), projName(x.key)) + '<span class="dim mono">' + hm(x.pr.t) + '</span></a>';
    }).concat(doneToday.slice(0, 8).map(function (t) {
      return '<a class="row" href="' + (t.sessionId ? hrefSession(t.sessionId) : hrefProject(t.key)) + '" data-key="dt-' + esc(t.uid) + '">' + ICONS.completed + '<div class="grow"><div class="line1">' + esc(t.subject) + '</div></div>' + chip(projCat(t.key), projName(t.key)) + '<span class="dim mono">' + hm(t.completedAt) + '</span></a>';
    })).join('');

    // Proyectos
    var projs = m.projects.filter(function (p) { return !p.hidden; }).slice(0, 6);
    var projRows = projs.map(function (p) {
      var line2 = p.current ? '▸ ' + p.current.x : (p.tasks.in_progress ? p.tasks.in_progress + ' en curso' : 'Última actividad ' + ago(p.lastActivity));
      return '<a class="row" href="' + hrefProject(p.key) + '" data-key="ovp-' + esc(p.key) + '">' + ring(p.tasks.completed, p.tasks.total, 46) +
        '<div class="grow"><div class="line1" style="display:flex;gap:8px;align-items:center"><b style="font-weight:600">' + esc(p.name) + '</b>' + chip(p.category) + (p.status === 'working' || p.status === 'waiting' ? orb(p.status) : '') + '</div>' +
        '<div class="line2" style="' + (p.current ? 'color:var(--cyan);font-family:var(--font-mono);font-size:12px' : '') + '">' + esc(line2) + '</div></div>' +
        '<div style="width:96px;flex:none" class="hide-sm">' + spark('ovs-' + hashStr(p.key), p.spark, 26) + '</div>' +
        '<div class="dim mono nowrap" style="font-size:11.5px;width:74px;text-align:right">' + esc(ago(p.lastActivity)) + '</div></a>';
    }).join('');

    // Mapa de actividad
    var heatTotal = sum(m.daily.slice(-182), 'runs');
    var heatBody = S.p.heatTable
      ? '<div class="tablewrap" style="max-height:260px"><table class="grid plain"><thead><tr><th>Día</th><th class="n">Tandas</th><th class="n">Herr.</th><th class="n">Completadas</th></tr></thead><tbody>' +
        m.daily.filter(function (d) { return d.runs || d.done; }).slice(-60).reverse().map(function (d) { return '<tr><td>' + esc(fmtDay(d.t)) + '</td><td class="n">' + d.runs + '</td><td class="n">' + C.fmtNum(d.tools) + '</td><td class="n">' + d.done + '</td></tr>'; }).join('') + '</tbody></table></div>'
      : heatmap('heat', m.daily);

    var feed = m.feed.slice(0, 90);

    var PROJECTS_PANEL = '<section class="panel"><div class="panel-h"><h2>Proyectos</h2><div class="meta">' + k.projectsToday + ' con actividad hoy</div></div><div class="panel-b flush rows">' + (projRows || empty('Todavía no hay proyectos.')) + '</div>' +
      '<div class="panel-f"><span class="dim">' + plural(m.projects.length, 'proyecto', 'proyectos') + ' en total</span><a href="#/projects">Ver todos ›</a></div></section>';

    return '<div class="page power-on">' +
      pageHead('Centro de <span class="accent">mando</span>', lede) +
      (S.source === 'demo' ? demoStrip() : '') + alert +
      '<div class="kpis">' + tiles + '</div>' +
      '<div class="g-over">' +
      '<div class="stack span-7">' +
      '<section class="panel' + (k.working ? ' hot' : '') + '"><div class="panel-h"><h2>Operaciones en vivo</h2><div class="meta">' + live.length + (live.length === 1 ? ' sesión abierta' : ' sesiones abiertas') + '</div></div>' +
      '<div class="panel-b flush ops">' + (live.length ? live.map(opRow).join('') : empty('No hay sesiones abiertas. Abre Claude Code en cualquier proyecto y aparecerá aquí al instante.' + (m.sessions[0] ? '<br><span class="dim">Última: <b>' + esc(m.sessions[0].project) + '</b>, ' + esc(ago(m.sessions[0].updatedAt)) + '.</span>' : ''))) + '</div></section>' +
      PROJECTS_PANEL +
      '</div>' +
      '<div class="stack span-5">' +
      '<section class="panel"><div class="panel-h"><h2>Actividad 24 h</h2><div class="meta">' + seg('metric', [['tools', 'Herr.'], ['runs', 'Tandas'], ['tokens', 'Tokens']], metric, 'Métrica') + '</div></div>' +
      '<div class="panel-b">' + actBody + '<div style="margin-top:8px;display:flex;justify-content:flex-end"><button class="tbl-toggle" type="button" data-act="tbl" data-pref="actTable">' + (S.p.actTable ? 'Ver gráfico' : 'Ver tabla') + '</button></div></div></section>' +
      '<section class="panel"><div class="panel-h"><h2>Completado hoy</h2><div class="meta">' + plural(doneToday.length, 'tarea', 'tareas') + (prsToday.length ? ' · ' + prsToday.length + ' PR' : '') + '</div></div>' +
      '<div class="panel-b flush rows" style="max-height:330px;overflow:auto">' + (doneRows || empty('Aún no se ha completado nada hoy.')) + '</div></section>' +
      '<section class="panel"><div class="panel-h"><h2>Mapa de actividad</h2><div class="meta">' + plural(heatTotal, 'tanda', 'tandas') + ' · 26 semanas</div></div><div class="panel-b">' + heatBody +
      '<div style="margin-top:8px;display:flex;justify-content:flex-end"><button class="tbl-toggle" type="button" data-act="tbl" data-pref="heatTable">' + (S.p.heatTable ? 'Ver mapa' : 'Ver tabla') + '</button></div></div></section>' +
      '</div>' +
      '<section class="panel span-12"><div class="panel-h"><h2>Registro</h2><div class="meta">' + orb(k.working ? 'working' : 'ended') + (k.working ? 'transmitiendo' : 'en reposo') + '</div></div><div class="term" id="term">' + (feed.length ? feedLines(feed, true) : empty('Sin eventos todavía.')) + '</div></section>' +
      '</div></div>';
  }

  // ───────────────────────────────────────────────────────────── vista: proyectos

  function vProjects(m) {
    var q = (S.t.q.projects || '').toLowerCase().trim();
    var all = m.projects.filter(function (p) { return S.p.phidden || !p.hidden; });
    var counts = {};
    all.forEach(function (p) { counts[p.category] = (counts[p.category] || 0) + 1; });
    var list = all.filter(function (p) {
      if (S.p.pcat !== 'all' && p.category !== S.p.pcat) return false;
      if (q && (p.name + ' ' + (p.path || '') + ' ' + (p.notes || '')).toLowerCase().indexOf(q) < 0) return false;
      return true;
    });
    var sorters = {
      activity: function (a, b) { return (b.pinned - a.pinned) || (b.lastActivity - a.lastActivity); },
      name: function (a, b) { return a.name.localeCompare(b.name, 'es'); },
      open: function (a, b) { return (b.tasks.pending + b.tasks.in_progress) - (a.tasks.pending + a.tasks.in_progress) || b.lastActivity - a.lastActivity; },
      tokens: function (a, b) { return b.tokens - a.tokens; }
    };
    list = list.slice().sort(sorters[S.p.psort] || sorters.activity);
    var catOpts = [['all', 'Todos', all.length]].concat(C.CATEGORIES.filter(function (c) { return counts[c.id]; }).map(function (c) { return [c.id, c.short, counts[c.id]]; }));
    var active = m.projects.filter(function (p) { return p.status === 'working' || p.status === 'waiting'; }).length;
    var toolbar = searchBox('projects', 'Filtrar por nombre o ruta') + seg('pcat', catOpts, S.p.pcat, 'Categoría') +
      '<select class="select" id="p-sort" data-bind="p.psort" aria-label="Ordenar"><option value="activity"' + (S.p.psort === 'activity' ? ' selected' : '') + '>Actividad reciente</option><option value="open"' + (S.p.psort === 'open' ? ' selected' : '') + '>Más tareas abiertas</option><option value="tokens"' + (S.p.psort === 'tokens' ? ' selected' : '') + '>Más tokens</option><option value="name"' + (S.p.psort === 'name' ? ' selected' : '') + '>Nombre</option></select>' +
      '<label class="switch"><input type="checkbox" id="p-hidden" data-bind="p.phidden"' + (S.p.phidden ? ' checked' : '') + '><span>Ocultos</span></label>';
    var n = limit('projects', 60);
    return '<div class="page power-on">' +
      pageHead('Proye<span class="accent">ctos</span>', '<b>' + m.projects.length + '</b> proyectos · <b>' + active + '</b> con Claude trabajando ahora · la categoría y la etapa se editan en cada proyecto.') +
      '<div class="toolbar">' + toolbar + '</div>' +
      (list.length ? '<div class="cards">' + list.slice(0, n).map(projectCard).join('') + '</div>' + moreBtn('projects', n, list.length, 60) : '<div class="panel">' + empty('Ningún proyecto coincide con el filtro.') + '</div>') +
      '</div>';
  }

  function projectCard(p) {
    var open = p.tasks.pending + p.tasks.in_progress;
    var now = p.current ? '▸ ' + esc(p.current.x) : '<span class="dim">' + esc(p.lastActivity ? 'Última actividad ' + ago(p.lastActivity) : 'Sin actividad') + '</span>';
    return '<a class="panel pcard ' + esc(p.status) + (p.hidden ? ' hidden-p' : '') + '" href="' + hrefProject(p.key) + '" data-key="pc-' + esc(p.key) + '">' +
      '<div class="pcard-top">' + chip(p.category) + (p.stage ? '<span class="tag">' + esc(p.stage) + '</span>' : '') + (p.pinned ? ICONS.pin : '') + '<span style="margin-left:auto">' + stateTag(p.status, PSTATE_TXT[p.status]) + '</span></div>' +
      '<div class="pcard-main"><div style="min-width:0"><h3>' + esc(p.name) + '</h3><div class="path" title="' + esc(p.path || '') + '">' + esc(shortHome(p.path)) + '</div></div>' + ring(p.tasks.completed, p.tasks.total, 58) + '</div>' +
      '<div class="now">' + now + '</div>' +
      '<div class="spark">' + spark('pcs-' + hashStr(p.key), p.spark, 26) + '</div>' +
      '<div class="stats"><span><b>' + p.sessions.length + '</b> sesiones</span><span><b>' + p.runs7 + '</b> tandas 7 d</span><span><b>' + open + '</b> abiertas</span><span><b>' + esc(C.fmtTok(p.tokens)) + '</b> tokens</span></div></a>';
  }

  // ───────────────────────────────────────────────────────────── vista: detalle de proyecto

  function vProject(m, key) {
    var p = m.projectMap[key];
    if (!p) return notFound('Proyecto no encontrado', '#/projects', 'Volver a proyectos');
    var sessions = p.sessions.map(function (id) { return m.sessionMap[id]; }).filter(Boolean).sort(function (a, b) { return b.updatedAt - a.updatedAt; });
    var tasks = m.tasks.filter(function (t) { return t.key === key; });
    var open = tasks.filter(function (t) { return t.status !== 'completed' && !t.stale; });
    open.sort(function (a, b) { return (b.status === 'in_progress') - (a.status === 'in_progress') || a.blocked - b.blocked || b.updated - a.updated; });
    var runs = m.runs.filter(function (r) { return r.key === key; });
    var plans = m.plans.filter(function (pl) { return pl.key === key; });
    var cfg = S.config.projects[key] || {};
    var stages = C.STAGES[p.category] || C.STAGES.other;
    var curStage = stages.indexOf(p.stage);
    var now = m.now;
    var day0 = C.startOfDay(now);
    var days = [];
    for (var i = 29; i >= 0; i--) days.push({ t: day0 - i * 86400000, v: 0 });
    runs.forEach(function (r) {
      var idx = 29 - Math.floor((day0 - C.startOfDay(r.t)) / 86400000 + 0.5);
      if (idx >= 0 && idx < 30) days[idx].v++;
    });
    var chart = columns('pd30-' + hashStr(key), days.map(function (d, i) {
      var dt = new Date(d.t);
      return { v: d.v, cur: i === 29, label: dt.getDate() + '/' + (dt.getMonth() + 1), tip: fmtDay(d.t) };
    }), { h: 150, integer: true, fmt: function (v) { return C.fmtNum(Math.round(v)); }, tip: function (v) { return v + (v === 1 ? ' tanda' : ' tandas'); }, aria: 'Tandas por día en los últimos 30 días' });

    var fileCount = {};
    sessions.forEach(function (s) { (s.files || []).forEach(function (f) { fileCount[f] = (fileCount[f] || 0) + 1; }); });
    var files = Object.keys(fileCount).sort(function (a, b) { return fileCount[b] - fileCount[a]; }).slice(0, 12);

    var aliasOpts = m.projects.filter(function (x) { return x.key !== key && !(S.config.aliases[x.key]); }).sort(function (a, b) { return a.name.localeCompare(b.name, 'es'); });

    var catSelect = '<select class="select" id="pf-cat" data-cfg="category" data-key="' + esc(key) + '">' + C.CATEGORIES.map(function (c) {
      return '<option value="' + c.id + '"' + (p.category === c.id ? ' selected' : '') + '>' + esc(c.label) + (c.id === p.autoCategory && !cfg.category ? ' (auto)' : '') + '</option>';
    }).join('') + '</select>';

    var actions = '<button class="btn small" type="button" data-act="pin" data-key="' + esc(key) + '">' + (p.pinned ? 'Desfijar' : 'Fijar arriba') + '</button>' +
      '<button class="btn small ghost" type="button" data-act="hide" data-key="' + esc(key) + '">' + (p.hidden ? 'Mostrar' : 'Ocultar') + '</button>';

    var facts = [
      ['Estado', stateTag(p.status, PSTATE_TXT[p.status])],
      ['Sesiones', p.sessions.length + (p.open ? '<small>' + plural(p.open, 'abierta', 'abiertas') + '</small>' : '')],
      ['Tandas', C.fmtNum(p.runs) + '<small>' + p.runs7 + ' en 7 d</small>'],
      ['Tareas', p.tasks.completed + '/' + p.tasks.total + (p.tasks.stale ? '<small>' + plural(p.tasks.stale, 'abandonada', 'abandonadas') + '</small>' : '')],
      ['Planes', String(p.plans)],
      ['Tokens', esc(C.fmtTok(p.tokens))],
      ['Ediciones', C.fmtNum(p.edits)],
      ['Desde', esc(C.fmtDate(p.startedAt, now))]
    ].map(function (f) { return '<div class="fact"><div class="l">' + f[0] + '</div><div class="v">' + f[1] + '</div></div>'; }).join('');

    return '<div class="page power-on">' +
      pageHead(esc(p.name), '<span class="mono dim">' + esc(p.path || p.key) + '</span>', actions, '<a href="#/projects">Proyectos</a> / ' + esc((CAT[p.category] || CAT.other).label)) +
      '<section class="panel"><div class="panel-h"><h2>Ficha</h2><div class="meta">' + chip(p.category) + (p.current ? stateTag(p.current.state) : '') + '</div></div><div class="panel-b" style="display:flex;flex-direction:column;gap:14px">' +
      '<div class="field"><label>Etapa</label><div class="stages">' + stages.map(function (st, i) {
        return '<button type="button" class="stage' + (i < curStage ? ' past' : i === curStage ? ' cur' : '') + '" data-act="stage" data-key="' + esc(key) + '" data-stage="' + esc(st) + '" aria-pressed="' + (i === curStage) + '"><i></i>' + esc(st) + '</button>';
      }).join('') + '</div></div>' +
      '<div class="edit-row"><div class="field"><label for="pf-name">Nombre</label><input class="input" id="pf-name" data-cfg="name" data-key="' + esc(key) + '" value="' + esc(cfg.name || '') + '" placeholder="' + esc(C.baseName(key)) + '"></div>' +
      '<div class="field"><label for="pf-cat">Categoría</label>' + catSelect + '</div>' +
      '<div class="field"><label for="pf-alias">Unir con otro proyecto</label><select class="select" id="pf-alias" data-cfg="alias" data-key="' + esc(key) + '"><option value="">No unir</option>' +
      aliasOpts.map(function (x) { return '<option value="' + esc(x.key) + '">' + esc(x.name) + '</option>'; }).join('') + '</select></div></div>' +
      '<div class="field"><label for="pf-notes">Notas</label><textarea class="input" id="pf-notes" rows="2" data-cfg="notes" data-key="' + esc(key) + '" placeholder="Objetivo, enlaces, próximos pasos…">' + esc(cfg.notes || '') + '</textarea></div>' +
      '</div></section>' +
      '<div class="facts">' + facts + '</div>' +
      '<div class="detail-grid">' +
      '<div class="stack">' +
      '<section class="panel"><div class="panel-h"><h2>Tareas abiertas</h2><div class="meta">' + plural(open.length, 'abierta', 'abiertas') + ' · ' + plural(p.tasks.completed, 'completada', 'completadas') + '</div></div><div class="panel-b flush">' +
      (open.length ? open.slice(0, limit('pd-tasks', 30)).map(taskItem).join('') + moreBtn('pd-tasks', limit('pd-tasks', 30), open.length, 30) : empty('Sin tareas abiertas en este proyecto.')) + '</div></section>' +
      '<section class="panel"><div class="panel-h"><h2>Tandas recientes</h2><div class="meta"><a href="#/runs" data-act="goto-proj" data-view="runs" data-key="' + esc(key) + '">Ver todas ›</a></div></div><div class="panel-b flush">' +
      (runs.length ? runs.slice(0, 12).map(function (r) { return runRow(r, false); }).join('') : empty('Sin tandas registradas.')) + '</div></section>' +
      '</div>' +
      '<div class="stack">' +
      '<section class="panel"><div class="panel-h"><h2>Actividad 30 días</h2><div class="meta">' + plural(runs.filter(function (r) { return r.t >= day0 - 29 * 86400000; }).length, 'tanda', 'tandas') + '</div></div><div class="panel-b">' + chart + '</div></section>' +
      '<section class="panel"><div class="panel-h"><h2>Sesiones</h2><div class="meta">' + sessions.length + '</div></div><div class="panel-b flush rows" style="max-height:360px;overflow:auto">' +
      sessions.slice(0, 40).map(function (s) {
        return '<a class="row" href="' + hrefSession(s.id) + '" data-key="ps-' + esc(s.id) + '">' + orb(s.state) + '<div class="grow"><div class="line1">' + esc(s.title) + '</div><div class="line2">' + esc(s.origin) + ' · ' + s.runs.length + ' tandas · ' + esc(C.fmtTok(s.tokTotal)) + ' tokens</div></div><span class="dim mono nowrap" style="font-size:11.5px">' + esc(ago(s.updatedAt)) + '</span></a>';
      }).join('') + '</div></section>' +
      (plans.length ? '<section class="panel"><div class="panel-h"><h2>Planes</h2><div class="meta">' + plans.length + '</div></div><div class="panel-b flush rows">' +
        plans.slice(0, 10).map(function (pl) { return '<a class="row" href="' + hrefPlan(pl.id) + '" data-key="pp-' + esc(pl.id) + '">' + planBadge(pl.status) + '<div class="grow"><div class="line1">' + esc(pl.title) + '</div></div><span class="dim mono nowrap" style="font-size:11.5px">' + esc(ago(pl.t1 || pl.t)) + '</span></a>'; }).join('') + '</div></section>' : '') +
      (p.prs.length ? '<section class="panel"><div class="panel-h"><h2>Pull requests</h2><div class="meta">' + p.prs.length + '</div></div><div class="panel-b flush rows">' +
        p.prs.slice(0, 10).map(function (pr) { return '<a class="row" href="' + esc(safeUrl(pr.url)) + '" target="_blank" rel="noopener noreferrer" data-key="ppr-' + esc(pr.url) + '"><span class="badge s-run">#' + esc(pr.n || '?') + '</span><div class="grow"><div class="line1">' + esc(pr.repo || pr.url) + '</div></div><span class="dim mono nowrap" style="font-size:11.5px">' + esc(ago(pr.t)) + '</span></a>'; }).join('') + '</div></section>' : '') +
      (files.length ? '<section class="panel"><div class="panel-h"><h2>Archivos más tocados</h2></div><div class="panel-b">' + hbars(files.map(function (f) { return { l: relTo(f, p.path), v: fileCount[f] }; })) + '<p class="dim" style="font-size:12px;margin:10px 0 0">Número de sesiones que editaron cada archivo.</p></div></section>' : '') +
      '</div></div></div>';
  }

  // ───────────────────────────────────────────────────────────── vista: tareas

  function vTasks(m) {
    var q = (S.t.q.tasks || '').toLowerCase().trim();
    var proj = S.t.proj.tasks || '';
    var from = since(S.p.trange, m.now);
    var list = m.tasks.filter(function (t) {
      if (!S.p.tstale && t.stale) return false;
      if (proj && t.key !== proj) return false;
      if (S.p.tsrc !== 'all' && t.source !== S.p.tsrc) return false;
      if (from && (t.status === 'completed' ? (t.completedAt || t.updated) : t.updated) < from) return false;
      if (q && (t.subject + ' ' + (t.description || '') + ' ' + projName(t.key)).toLowerCase().indexOf(q) < 0) return false;
      return true;
    });
    var cols = { in_progress: [], pending: [], blocked: [], completed: [] };
    list.forEach(function (t) { cols[t.status === 'completed' ? 'completed' : t.blocked ? 'blocked' : t.status].push(t); });
    cols.completed.sort(function (a, b) { return (b.completedAt || b.updated) - (a.completedAt || a.updated); });
    var k = m.kpis;
    var toolbar = searchBox('tasks', 'Buscar tareas') + projectSelect('tasks', proj) +
      seg('tview', [['board', 'Tablero'], ['projects', 'Por proyecto']], S.p.tview, 'Vista') +
      seg('trange', [['all', 'Siempre'], ['today', 'Hoy'], ['7', '7 días'], ['30', '30 días']], S.p.trange, 'Periodo') +
      seg('tsrc', [['all', 'Todas'], ['task', 'Tareas'], ['todo', 'Listas TODO']], S.p.tsrc, 'Origen') +
      '<label class="switch"><input type="checkbox" id="t-stale" data-bind="p.tstale"' + (S.p.tstale ? ' checked' : '') + '><span>Abandonadas' + (k.tasksStale ? ' (' + k.tasksStale + ')' : '') + '</span></label>';
    var body;
    if (S.p.tview === 'projects') {
      var groups = {};
      list.forEach(function (t) { (groups[t.key] = groups[t.key] || []).push(t); });
      var keys = Object.keys(groups).sort(function (a, b) {
        var oa = groups[a].filter(function (t) { return t.status !== 'completed'; }).length;
        var ob = groups[b].filter(function (t) { return t.status !== 'completed'; }).length;
        return ob - oa || projName(a).localeCompare(projName(b), 'es');
      });
      body = keys.length ? keys.map(function (key) {
        var ts = groups[key].slice().sort(function (a, b) {
          var o = { in_progress: 0, pending: 1, completed: 2 };
          return (o[a.status] - o[b.status]) || (a.blocked - b.blocked) || (b.updated - a.updated);
        });
        var done = ts.filter(function (t) { return t.status === 'completed'; }).length;
        var lim = limit('tg-' + key, 12);
        return '<section class="panel"><div class="group-h">' + chip(projCat(key)) + '<h3><a href="' + hrefProject(key) + '" style="color:inherit">' + esc(projName(key)) + '</a></h3>' + progress(done, ts.length) + '</div>' +
          ts.slice(0, lim).map(taskItem).join('') + (ts.length > lim ? '<div style="padding:10px 18px">' + moreBtn('tg-' + key, lim, ts.length, 20) + '</div>' : '') + '</section>';
      }).join('') : '<div class="panel">' + empty('No hay tareas con estos filtros.') + '</div>';
      body = '<div class="stack">' + body + '</div>';
    } else {
      var defs = [['in_progress', 'En curso'], ['pending', 'Pendientes'], ['blocked', 'Bloqueadas'], ['completed', 'Completadas']];
      body = '<div class="kanban">' + defs.map(function (d) {
        var items = cols[d[0]];
        var lim = limit('col-' + d[0], 40);
        return '<section class="panel col ' + d[0] + '"><div class="panel-h"><h2>' + d[1] + '</h2><div class="meta">' + items.length + '</div></div>' +
          '<div class="tcards">' + (items.length ? items.slice(0, lim).map(taskCard).join('') + moreBtn('col-' + d[0], lim, items.length, 40) : '<div class="empty" style="padding:14px 6px">Nada aquí.</div>') + '</div></section>';
      }).join('') + '</div>';
    }
    return '<div class="page power-on">' +
      pageHead('Ta<span class="accent">reas</span>', '<b>' + k.tasksOpen + '</b> abiertas · <b>' + k.tasksActive + '</b> en curso · <b>' + k.tasksBlocked + '</b> bloqueadas · <b>' + k.doneToday + '</b> completadas hoy. Salen de TaskCreate/TaskUpdate y de las listas TODO de cada sesión.') +
      '<div class="toolbar">' + toolbar + '</div>' + body + '</div>';
  }

  // ───────────────────────────────────────────────────────────── vista: planes

  function vPlans(m, id) {
    var q = (S.t.q.plans || '').toLowerCase().trim();
    var proj = S.t.proj.plans || '';
    var counts = { all: 0, pending: 0, approved: 0, rejected: 0, draft: 0 };
    var base = m.plans.filter(function (p) {
      if (proj && p.key !== proj) return false;
      if (q && (p.title + ' ' + (p.md || '')).toLowerCase().indexOf(q) < 0) return false;
      return true;
    });
    base.forEach(function (p) { counts.all++; counts[p.status] = (counts[p.status] || 0) + 1; });
    var list = base.filter(function (p) { return S.p.plst === 'all' || p.status === S.p.plst; });
    var sel = id ? m.plans.filter(function (p) { return p.id === id; })[0] : list[0];
    var toolbar = searchBox('plans', 'Buscar en los planes') + projectSelect('plans', proj) +
      seg('plst', [['all', 'Todos', counts.all], ['pending', 'Pendientes', counts.pending], ['approved', 'Aprobados', counts.approved], ['rejected', 'Rechazados', counts.rejected], ['draft', 'Borradores', counts.draft]], S.p.plst, 'Estado');
    var lim = limit('plans', 80);
    var items = list.slice(0, lim).map(function (p) {
      return '<a class="plan-item' + (sel && sel.id === p.id ? ' sel' : '') + '" href="' + hrefPlan(p.id) + '" data-key="pl-' + esc(p.id) + '">' +
        '<div class="t">' + esc(p.title) + '</div><div class="m">' + planBadge(p.status) + '' +
        (p.key ? chip(projCat(p.key), projName(p.key)) : '<span class="tag">sin proyecto</span>') + (p.steps ? '<span class="mono">' + p.steps.done + '/' + p.steps.total + '</span>' : '') + '<span class="mono">' + esc(ago(p.t1 || p.t)) + '</span></div></a>';
    }).join('');
    var doc = sel ? '<section class="panel plan-doc"><div class="panel-h"><h2>Plan</h2><div class="meta">' + planBadge(sel.status) + '</div></div>' +
      '<div class="panel-b"><div style="display:flex;gap:10px;flex-wrap:wrap;align-items:center;margin-bottom:14px">' + (sel.key ? projChip(sel.key) : '') +
      (sel.sessionId ? '<a class="tag" href="' + hrefSession(sel.sessionId) + '">sesión ›</a>' : '') + (sel.file ? '<span class="tag">' + esc(sel.file) + '</span>' : '') +
      '<span class="dim mono" style="font-size:11.5px">' + esc(C.fmtDate(sel.t, m.now) + ' · ' + hm(sel.t)) + '</span></div>' +
      (sel.steps ? '<div style="margin-bottom:16px">' + progress(sel.steps.done, sel.steps.total) + '</div>' : '') +
      '<div class="md">' + (sel.md ? md(sel.md) : '<p class="dim">Este plan no guardó texto en la transcripción.</p>') + '</div></div></section>'
      : '<section class="panel plan-doc">' + empty('Elige un plan de la lista.') + '</section>';
    return '<div class="page power-on">' +
      pageHead('Pla<span class="accent">nes</span>', 'Planes propuestos en modo plan (ExitPlanMode) y guardados en <span class="mono">~/.claude/plans</span>, con su estado de aprobación.') +
      '<div class="toolbar">' + toolbar + '</div>' +
      (m.plans.length ? '<div class="plans"><section class="panel"><div class="panel-h"><h2>Lista</h2><div class="meta">' + list.length + '</div></div><div class="panel-b flush plan-list">' + (items || empty('Ningún plan coincide.')) + (list.length > lim ? '<div style="padding:10px">' + moreBtn('plans', lim, list.length, 80) + '</div>' : '') + '</div></section>' + doc + '</div>'
        : '<div class="panel">' + empty('Todavía no hay planes. Aparecen cuando Claude usa el modo plan (Shift+Tab dos veces en Claude Code).') + '</div>') +
      '</div>';
  }

  // ───────────────────────────────────────────────────────────── vista: tandas

  function vRuns(m) {
    var q = (S.t.q.runs || '').toLowerCase().trim();
    var proj = S.t.proj.runs || '';
    var from = since(S.p.rrange, m.now);
    var list = m.runs.filter(function (r) {
      if (from && r.t < from) return false;
      if (proj && r.key !== proj) return false;
      if (S.p.rsrc !== 'all' && r.src !== S.p.rsrc) return false;
      if (S.p.rst !== 'all') {
        var st = runStatus(r);
        if (S.p.rst === 'run' ? (st !== 'run' && st !== 'wait') : st !== S.p.rst) return false;
      }
      if (q && (r.p + ' ' + (r.res || '')).toLowerCase().indexOf(q) < 0) return false;
      return true;
    });
    var lim = limit('runs', 120);
    var shown = list.slice(0, lim);
    var groups = [];
    shown.forEach(function (r) {
      var dk = C.dayKey(r.t);
      if (!groups.length || groups[groups.length - 1].k !== dk) groups.push({ k: dk, t: r.t, items: [] });
      groups[groups.length - 1].items.push(r);
    });
    var tot = list.reduce(function (a, r) { a.tools += r.tools; a.tk += r.tk; a.ed += r.ed; return a; }, { tools: 0, tk: 0, ed: 0 });
    var toolbar = searchBox('runs', 'Buscar en prompts y resultados') + projectSelect('runs', proj) +
      seg('rrange', [['today', 'Hoy'], ['7', '7 días'], ['30', '30 días'], ['all', 'Siempre']], S.p.rrange, 'Periodo') +
      seg('rst', [['all', 'Todas'], ['run', 'En curso'], ['ok', 'Completadas'], ['int', 'Interrumpidas'], ['err', 'Con errores']], S.p.rst, 'Estado') +
      seg('rsrc', [['all', 'Cualquiera'], ['human', 'Prompts'], ['command', 'Comandos'], ['auto', 'Auto']], S.p.rsrc, 'Origen');
    return '<div class="page power-on">' +
      pageHead('Tan<span class="accent">das</span>', 'Cada tanda es una instrucción tuya y todo lo que Claude hizo para cumplirla. <b>' + C.fmtNum(list.length) + '</b> tandas · <b>' + C.fmtNum(tot.tools) + '</b> herramientas · <b>' + C.fmtNum(tot.ed) + '</b> ediciones · <b>' + esc(C.fmtTok(tot.tk)) + '</b> tokens.') +
      '<div class="toolbar">' + toolbar + '</div>' +
      (groups.length ? groups.map(function (g) {
        return '<div class="day-h">' + esc(dayLabel(g.t, m.now)) + ' <small>' + g.items.length + '</small></div><section class="panel" data-key="rg-' + g.k + '"><div class="panel-b flush">' + g.items.map(function (r) { return runRow(r, true); }).join('') + '</div></section>';
      }).join('') + moreBtn('runs', lim, list.length, 120) : '<div class="panel">' + empty('No hay tandas con estos filtros.') + '</div>') +
      '</div>';
  }

  // ───────────────────────────────────────────────────────────── vista: sesiones

  function vSessions(m) {
    var q = (S.t.q.sessions || '').toLowerCase().trim();
    var proj = S.t.proj.sessions || '';
    var counts = { all: m.sessions.length, working: 0, waiting: 0, idle: 0, ended: 0 };
    m.sessions.forEach(function (s) { counts[s.state]++; });
    var list = m.sessions.filter(function (s) {
      if (S.p.sst !== 'all' && s.state !== S.p.sst) return false;
      if (proj && s.key !== proj) return false;
      if (q && (s.title + ' ' + s.project + ' ' + s.id + ' ' + (s.lastPrompt || '') + ' ' + (s.branch || '')).toLowerCase().indexOf(q) < 0) return false;
      return true;
    });
    var key = S.p.ssort;
    var dir = S.p.sdir;
    var val = {
      state: function (s) { return { waiting: 0, working: 1, idle: 2, ended: 3 }[s.state]; },
      title: function (s) { return s.title.toLowerCase(); },
      project: function (s) { return s.project.toLowerCase(); },
      origin: function (s) { return s.origin; },
      updatedAt: function (s) { return s.updatedAt; },
      dur: function (s) { return s.updatedAt - s.startedAt; },
      runs: function (s) { return s.runs.length; },
      tools: function (s) { return s.counts.tools; },
      tokens: function (s) { return s.tokTotal; },
      tasks: function (s) { return s.tasks.total; }
    }[key] || function (s) { return s.updatedAt; };
    list = list.slice().sort(function (a, b) {
      var x = val(a), y = val(b);
      return (x < y ? -1 : x > y ? 1 : 0) * dir;
    });
    var th = function (k2, label, num) {
      return '<th' + (num ? ' class="n' + (key === k2 ? ' sorted' : '') + '"' : (key === k2 ? ' class="sorted"' : '')) + ' data-act="sort" data-sort="' + k2 + '" aria-sort="' + (key === k2 ? (dir > 0 ? 'ascending' : 'descending') : 'none') + '">' + label + (key === k2 ? (dir > 0 ? ' ↑' : ' ↓') : '') + '</th>';
    };
    var lim = limit('sessions', 150);
    var rows = list.slice(0, lim).map(function (s) {
      return '<tr data-href="' + hrefSession(s.id) + '" data-key="sr-' + esc(s.id) + '"><td>' + stateTag(s.state) + '</td>' +
        '<td class="ttl"><div><a href="' + hrefSession(s.id) + '" style="color:var(--ice)">' + esc(s.title) + '</a></div><small>' + esc(s.id.slice(0, 8)) + (s.branch ? ' · ' + esc(s.branch) : '') + (s.archived ? ' · archivada' : '') + '</small></td>' +
        '<td>' + chip(s.category, s.project) + '</td><td><span class="tag">' + esc(s.origin) + '</span></td>' +
        '<td class="n">' + esc(ago(s.updatedAt)) + '</td><td class="n">' + esc(C.fmtDur(s.updatedAt - s.startedAt)) + '</td>' +
        '<td class="n">' + s.runs.length + '</td><td class="n">' + C.fmtNum(s.counts.tools) + '</td><td class="n">' + esc(C.fmtTok(s.tokTotal)) + '</td>' +
        '<td class="n">' + (s.tasks.total ? s.tasks.completed + '/' + s.tasks.total : '—') + '</td></tr>';
    }).join('');
    var toolbar = searchBox('sessions', 'Buscar por título, prompt, rama o id') + projectSelect('sessions', proj) +
      seg('sst', [['all', 'Todas', counts.all], ['working', 'Trabajando', counts.working], ['waiting', 'Te esperan', counts.waiting], ['idle', 'Abiertas', counts.idle], ['ended', 'Cerradas', counts.ended]], S.p.sst, 'Estado');
    return '<div class="page power-on">' +
      pageHead('Sesio<span class="accent">nes</span>', 'Cada conversación de Claude Code (Desktop, CLI, VS Code…). El estado en vivo sale de <span class="mono">~/.claude/sessions</span>.') +
      '<div class="toolbar">' + toolbar + '</div>' +
      '<section class="panel"><div class="panel-b flush tablewrap"><table class="grid"><thead><tr>' +
      th('state', 'Estado') + th('title', 'Sesión') + th('project', 'Proyecto') + th('origin', 'Origen') + th('updatedAt', 'Actividad', true) + th('dur', 'Duración', true) +
      th('runs', 'Tandas', true) + th('tools', 'Herr.', true) + th('tokens', 'Tokens', true) + th('tasks', 'Tareas', true) +
      '</tr></thead><tbody>' + (rows || '<tr><td colspan="10">' + empty('Ninguna sesión coincide.') + '</td></tr>') + '</tbody></table></div></section>' +
      moreBtn('sessions', lim, list.length, 150) + '</div>';
  }

  // ───────────────────────────────────────────────────────────── vista: detalle de sesión

  function vSession(m, id) {
    var s = m.sessionMap[id];
    if (!s) return notFound('Sesión no encontrada', '#/sessions', 'Volver a sesiones');
    var tasks = m.tasks.filter(function (t) { return t.sessionId === id; });
    tasks.sort(function (a, b) { return (+a.id || 0) - (+b.id || 0); });
    var plans = m.plans.filter(function (p) { return p.sessionId === id; });
    var runs = m.runs.filter(function (r) { return r.sessionId === id; });
    var tools = Object.keys(s.tools || {}).map(function (k) { return { l: k.indexOf('mcp__') === 0 ? 'MCP ' + k.split('__').slice(1).join(' · ') : k, v: s.tools[k] }; })
      .sort(function (a, b) { return b.v - a.v; }).slice(0, 12);
    var feed = (s.feed || []).slice().reverse().map(function (f) { return { t: f.t, k: f.k, x: f.x, sub: f.sub, sessionId: id, key: s.key }; });
    var resume = 'claude --resume ' + s.id;
    var dur = s.updatedAt - s.startedAt;
    var facts = [
      ['Estado', stateTag(s.state) + (s.state === 'waiting' ? '<small>' + esc(waitText(s.waitingFor)) + '</small>' : '')],
      ['Tandas', String(runs.length)],
      ['Herramientas', C.fmtNum(s.counts.tools)],
      ['Ediciones', C.fmtNum(s.counts.edits)],
      ['Errores', String(s.counts.errors) + (s.counts.rejections ? '<small>' + s.counts.rejections + ' rechazos</small>' : '')],
      ['Subagentes', String(s.counts.subagents)],
      ['Tokens', esc(C.fmtTok(s.tokTotal)) + '<small>' + esc(C.fmtTok(s.tokens.out)) + ' de salida</small>'],
      ['Duración', esc(C.fmtDur(dur))]
    ].map(function (f) { return '<div class="fact"><div class="l">' + f[0] + '</div><div class="v">' + f[1] + '</div></div>'; }).join('');
    var kv = [
      ['Id', '<span class="mono">' + esc(s.id) + '</span>'],
      ['Carpeta', '<span class="mono">' + esc(s.cwd || '—') + '</span>'],
      ['Rama', s.branch ? '<span class="mono">' + esc(s.branch) + '</span>' : '—'],
      ['Modelo', esc(s.model || '—')],
      ['Origen', esc(s.origin) + (s.live && s.live.pid ? ' · PID ' + esc(s.live.pid) : '')],
      ['Permisos', esc(s.permissionMode || '—')],
      ['Versión', esc(s.version || '—')],
      ['Inicio', esc(C.fmtDate(s.startedAt, m.now) + ' ' + hm(s.startedAt))],
      ['Actividad', esc(ago(s.updatedAt))]
    ];
    if (s.archived) kv.push(['Historial', 'Claude Code ya borró esta transcripción; NEXUS conserva el resumen.']);
    return '<div class="page power-on">' +
      pageHead(esc(s.title), projChip(s.key) + ' <span class="tag">' + esc(s.origin) + '</span>' + (s.tag ? ' <span class="tag">' + esc(s.tag) + '</span>' : ''), '', '<a href="#/sessions">Sesiones</a> / ' + esc(s.id.slice(0, 8))) +
      '<div class="copy"><code>' + esc(resume) + '</code><button class="btn small" type="button" data-act="copy" data-copy="' + esc(resume) + '">Copiar</button></div>' +
      '<div class="facts">' + facts + '</div>' +
      '<div class="detail-grid"><div class="stack">' +
      (tasks.length ? '<section class="panel"><div class="panel-h"><h2>Tareas</h2><div class="meta">' + s.tasks.completed + '/' + s.tasks.total + '</div></div><div class="panel-b" style="padding-bottom:6px">' + progress(s.tasks.completed, s.tasks.total) + '</div><div class="panel-b flush">' + tasks.map(taskItem).join('') + '</div></section>' : '') +
      '<section class="panel"><div class="panel-h"><h2>Tandas</h2><div class="meta">' + runs.length + '</div></div><div class="panel-b flush">' + (runs.length ? runs.slice(0, limit('sd-runs', 40)).map(function (r) { return runRow(r, false); }).join('') + moreBtn('sd-runs', limit('sd-runs', 40), runs.length, 40) : empty('Sin tandas.')) + '</div></section>' +
      '<section class="panel"><div class="panel-h"><h2>Registro</h2><div class="meta">últimos ' + feed.length + ' eventos</div></div><div class="term">' + (feed.length ? feedLines(feed, false) : empty('Sin eventos.')) + '</div></section>' +
      '</div><div class="stack">' +
      (plans.length ? '<section class="panel"><div class="panel-h"><h2>Planes</h2></div><div class="panel-b flush rows">' + plans.map(function (p) { return '<a class="row" href="' + hrefPlan(p.id) + '" data-key="sp-' + esc(p.id) + '">' + planBadge(p.status) + '<div class="grow"><div class="line1">' + esc(p.title) + '</div></div></a>'; }).join('') + '</div></section>' : '') +
      (tools.length ? '<section class="panel"><div class="panel-h"><h2>Herramientas</h2><div class="meta">' + C.fmtNum(s.counts.tools) + ' usos</div></div><div class="panel-b">' + hbars(tools) + '</div></section>' : '') +
      (s.files && s.files.length ? '<section class="panel"><div class="panel-h"><h2>Archivos editados</h2><div class="meta">' + s.files.length + '</div></div><div class="panel-b" style="display:flex;flex-wrap:wrap;gap:6px;max-height:260px;overflow:auto">' + s.files.slice().reverse().slice(0, 80).map(function (f) { return '<span class="file" title="' + esc(f) + '">' + esc(relTo(f, s.cwd)) + '</span>'; }).join('') + '</div></section>' : '') +
      (s.prs && s.prs.length ? '<section class="panel"><div class="panel-h"><h2>Pull requests</h2></div><div class="panel-b flush rows">' + s.prs.map(function (pr) { return '<a class="row" href="' + esc(safeUrl(pr.url)) + '" target="_blank" rel="noopener noreferrer"><span class="badge s-run">#' + esc(pr.n || '?') + '</span><div class="grow"><div class="line1">' + esc(pr.repo || pr.url) + '</div></div></a>'; }).join('') + '</div></section>' : '') +
      '<section class="panel"><div class="panel-h"><h2>Datos técnicos</h2></div><div class="panel-b"><dl class="kv">' + kv.map(function (x) { return '<dt>' + x[0] + '</dt><dd>' + x[1] + '</dd>'; }).join('') + '</dl></div></section>' +
      '</div></div></div>';
  }

  // ───────────────────────────────────────────────────────────── vista: ajustes

  function vSettings(m) {
    var meta = S.data.meta || {};
    var src = S.source === 'server' ? 'Servidor local' + (S.server ? ' · v' + esc(S.server.version) : '') : S.source === 'folder' ? 'Carpeta en el navegador' : 'Demo';
    var kv = [['Modo', src]];
    if (S.source !== 'demo') {
      kv.push(['Carpeta', '<span class="mono">' + esc(S.claudeDir || '—') + '</span>']);
      if (S.server && S.server.home) kv.push(['Historial propio', '<span class="mono">' + esc(S.server.home) + '</span>']);
      kv.push(['Sesiones', C.fmtNum(m.sessions.length)]);
      kv.push(['Archivos vigilados', C.fmtNum(meta.files || 0)]);
      kv.push(['Líneas leídas', C.fmtNum(meta.lines || 0) + (meta.badLines ? ' · ' + meta.badLines + ' ilegibles' : '')]);
      kv.push(['Datos procesados', fmtBytes(meta.bytes)]);
      kv.push(['Último escaneo', esc(ago(meta.lastScan)) + (meta.lastFull ? ' · completo ' + esc(ago(meta.lastFull)) : '')]);
    }
    var srcActions = S.source === 'demo'
      ? '<button class="btn primary" type="button" data-act="show-connect">Conectar datos reales</button>'
      : '<button class="btn" type="button" data-act="rescan">Reescanear todo</button>' + (S.source === 'folder' ? '<button class="btn ghost" type="button" data-act="show-connect">Cambiar fuente</button>' : '');
    var projRows = m.projects.slice().sort(function (a, b) { return a.name.localeCompare(b.name, 'es'); }).map(function (p) {
      var cfg = S.config.projects[p.key] || {};
      var stages = C.STAGES[p.category] || C.STAGES.other;
      return '<tr data-key="cfg-' + esc(p.key) + '"><td class="ttl"><div><a href="' + hrefProject(p.key) + '" style="color:var(--ice)">' + esc(p.name) + '</a></div><small>' + esc(shortHome(p.path || p.key)) + '</small></td>' +
        '<td><select class="select" id="cfgc-' + hashStr(p.key) + '" data-cfg="category" data-key="' + esc(p.key) + '" aria-label="Categoría de ' + esc(p.name) + '">' + C.CATEGORIES.map(function (c) { return '<option value="' + c.id + '"' + (p.category === c.id ? ' selected' : '') + '>' + esc(c.label) + (c.id === p.autoCategory && !cfg.category ? ' (auto)' : '') + '</option>'; }).join('') + '</select></td>' +
        '<td><select class="select" id="cfgs-' + hashStr(p.key) + '" data-cfg="stage" data-key="' + esc(p.key) + '" aria-label="Etapa de ' + esc(p.name) + '"><option value="">—</option>' + stages.map(function (st) { return '<option' + (p.stage === st ? ' selected' : '') + '>' + esc(st) + '</option>'; }).join('') + '</select></td>' +
        '<td style="text-align:center"><input type="checkbox" id="cfgh-' + hashStr(p.key) + '" data-cfg="hidden" data-key="' + esc(p.key) + '" aria-label="Ocultar ' + esc(p.name) + '"' + (p.hidden ? ' checked' : '') + '></td></tr>';
    }).join('');
    var aliases = Object.keys(S.config.aliases || {});
    var sw = function (pref, title, sub) {
      return '<label class="switch"><input type="checkbox" id="pref-' + pref + '" data-bind="p.' + pref + '"' + (S.p[pref] ? ' checked' : '') + '><span>' + title + (sub ? '<small>' + sub + '</small>' : '') + '</span></label>';
    };
    var install = 'node nexus/bin/nexus.mjs install';
    return '<div class="page power-on">' +
      pageHead('Aju<span class="accent">stes</span>', 'Fuente de datos, apariencia, avisos y la ficha de cada proyecto.') +
      '<div class="detail-grid"><div class="stack">' +
      '<section class="panel"><div class="panel-h"><h2>Fuente de datos</h2></div><div class="panel-b" style="display:flex;flex-direction:column;gap:14px"><dl class="kv">' + kv.map(function (x) { return '<dt>' + x[0] + '</dt><dd>' + x[1] + '</dd>'; }).join('') + '</dl><div class="toolbar">' + srcActions + '</div></div></section>' +
      '<section class="panel"><div class="panel-h"><h2>Proyectos</h2><div class="meta">' + m.projects.length + '</div></div><div class="panel-b flush tablewrap" style="max-height:520px"><table class="grid plain"><thead><tr><th>Proyecto</th><th>Categoría</th><th>Etapa</th><th>Oculto</th></tr></thead><tbody>' + projRows + '</tbody></table></div>' +
      (aliases.length ? '<div class="panel-f"><span class="dim">' + aliases.length + (aliases.length === 1 ? ' carpeta unida' : ' carpetas unidas') + ' a otro proyecto</span><button class="btn small ghost" type="button" data-act="clear-aliases">Separar todas</button></div>' : '') + '</section>' +
      '</div><div class="stack">' +
      '<section class="panel"><div class="panel-h"><h2>Avisos</h2></div><div class="panel-b">' +
      sw('toasts', 'Avisos dentro de NEXUS', 'Cuando una sesión te necesita o termina una tanda.') +
      sw('notify', 'Notificaciones del sistema', 'Solo si la pestaña está en segundo plano.') +
      sw('sound', 'Sonido cuando Claude te espera', '') + '</div></section>' +
      '<section class="panel"><div class="panel-h"><h2>Apariencia</h2></div><div class="panel-b">' +
      sw('fx', 'Efectos de pantalla', 'Rejilla y líneas de escaneo.') +
      sw('calm', 'Modo sereno', 'Sin pulsos ni animaciones.') + '</div></section>' +
      '<section class="panel"><div class="panel-h"><h2>Integración con Claude Code</h2></div><div class="panel-b" style="display:flex;flex-direction:column;gap:12px;font-size:14px">' +
      '<p style="margin:0" class="steel">Instala la skill <span class="mono">/nexus</span> para abrir el panel o preguntarle a Claude por el estado de todos tus proyectos, y los hooks opcionales para avisos instantáneos:</p>' +
      '<div class="copy"><code>' + esc(install) + '</code><button class="btn small" type="button" data-act="copy" data-copy="' + esc(install) + '">Copiar</button></div>' +
      '<p style="margin:0" class="dim">Atajos: <span class="mono">/</span> buscar · <span class="mono">1–7</span> secciones · <span class="mono">Esc</span> cerrar.</p></div></section>' +
      '</div></div></div>';
  }

  function notFound(title, back, label) {
    return '<div class="page power-on">' + pageHead(esc(title), 'Puede que se haya borrado o que el enlace sea de otra fuente de datos.') + '<div><a class="btn" href="' + back + '">' + esc(label) + '</a></div></div>';
  }

  var VIEWS = { overview: vOverview, projects: vProjects, project: vProject, tasks: vTasks, plans: vPlans, runs: vRuns, sessions: vSessions, session: vSession, settings: vSettings };

  // ───────────────────────────────────────────────────────────── morph del DOM

  function morph(target, html) {
    var tpl = document.createElement('template');
    tpl.innerHTML = html;
    patchChildren(target, tpl.content);
  }

  function keyOf(n) { return n.nodeType === 1 ? n.getAttribute('data-key') : null; }
  function sameType(a, b) { return a.nodeType === b.nodeType && (a.nodeType !== 1 || a.tagName === b.tagName); }

  function patchChildren(parent, next) {
    var newNodes = Array.prototype.slice.call(next.childNodes);
    var byKey = {};
    Array.prototype.forEach.call(parent.childNodes, function (n) { var k = keyOf(n); if (k) byKey[k] = n; });
    for (var i = 0; i < newNodes.length; i++) {
      var nn = newNodes[i];
      var k = keyOf(nn);
      var cur = parent.childNodes[i] || null;
      var match = null;
      if (k && byKey[k]) { match = byKey[k]; delete byKey[k]; }
      else if (cur && !keyOf(cur) && !k && sameType(cur, nn)) match = cur;
      if (match) {
        if (match !== cur) parent.insertBefore(match, cur);
        patchNode(match, nn);
      } else {
        parent.insertBefore(nn, cur);
      }
    }
    while (parent.childNodes.length > newNodes.length) parent.removeChild(parent.lastChild);
  }

  function patchNode(a, b) {
    if (a.nodeType === 3 || a.nodeType === 8) {
      if (a.nodeValue !== b.nodeValue) a.nodeValue = b.nodeValue;
      return;
    }
    var i;
    var attrs = a.attributes;
    for (i = attrs.length - 1; i >= 0; i--) if (!b.hasAttribute(attrs[i].name)) a.removeAttribute(attrs[i].name);
    var battrs = b.attributes;
    for (i = 0; i < battrs.length; i++) if (a.getAttribute(battrs[i].name) !== battrs[i].value) a.setAttribute(battrs[i].name, battrs[i].value);
    var tag = a.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') {
      if (document.activeElement !== a) {
        if (tag === 'SELECT') { patchChildren(a, b); a.value = b.value; }
        else if (a.type === 'checkbox' || a.type === 'radio') a.checked = b.checked;
        else if (a.value !== b.value) a.value = tag === 'TEXTAREA' ? b.textContent : b.value;
      }
      return;
    }
    patchChildren(a, b);
  }

  // ───────────────────────────────────────────────────────────── render

  var rq = false;
  function requestRender() {
    if (rq) return;
    rq = true;
    requestAnimationFrame(function () { rq = false; render(); });
  }

  function render() {
    if (!S.model) return;
    var view = $('#view');
    var fn = VIEWS[S.route.view] || vOverview;
    var html;
    try {
      html = fn(S.model, S.route.id);
    } catch (err) {
      console.error(err);
      html = '<div class="page">' + pageHead('Error al dibujar la vista', esc(String(err && err.message || err))) + '</div>';
    }
    if (S.fresh) {
      if (ro) ro.disconnect();
      $$('[data-chart]').forEach(function (el) { el.__nx = false; });
      view.innerHTML = html;
      S.fresh = false;
    } else {
      morph(view, html);
    }
    if (S.model.feed.length) S.lastFeed = Math.max(S.lastFeed, S.model.feed[0].t);
    observeCharts();
    updateChrome();
  }

  var modelTimer = null;
  var buildCost = 0;
  function scheduleModel(immediate) {
    if (modelTimer) {
      if (!immediate) return;
      clearTimeout(modelTimer);
    }
    var wait = immediate ? 0 : Math.max(200, Math.min(4000, buildCost * 5));
    modelTimer = setTimeout(function () { modelTimer = null; rebuild(); }, wait);
  }

  function rebuild() {
    var t0 = performance.now();
    S.model = C.buildModel(S.data, S.config, Date.now());
    buildCost = performance.now() - t0;
    transitions(S.model);
    render();
  }

  // ───────────────────────────────────────────────────────────── avisos

  function transitions(m) {
    var next = {};
    m.sessions.forEach(function (s) {
      next[s.id] = s.state;
      if (!S.primed) return;
      var was = S.prev[s.id];
      if (was === s.state) return;
      if (s.state === 'waiting') {
        alertUser('warn', s.project, waitText(s.waitingFor) + '.', hrefSession(s.id));
      } else if (was === 'working' && (s.state === 'idle' || s.state === 'ended')) {
        var last = s.runs[s.runs.length - 1];
        alertUser('done', s.project, 'Tanda completada' + (last && last.res ? ': ' + C.trunc(last.res, 120) : '.'), hrefSession(s.id));
      }
    });
    S.prev = next;
    S.primed = true;
  }

  function alertUser(kind, title, text, href) {
    if (S.p.toasts) toast(kind, title, text, href);
    if (kind === 'warn' && S.p.sound) beep();
    if (S.p.notify && typeof Notification !== 'undefined' && Notification.permission === 'granted' && document.hidden) {
      try {
        var n = new Notification('NEXUS · ' + title, { body: text, tag: href });
        n.onclick = function () { window.focus(); location.hash = href; };
      } catch (e) { /* sin notificaciones */ }
    }
  }

  function toast(kind, title, text, href) {
    var box = $('#toasts');
    var el = document.createElement('div');
    el.className = 'panel toast ' + kind;
    el.innerHTML = orb(kind === 'warn' ? 'waiting' : kind === 'done' ? 'done' : 'idle') + '<div><b></b><span></span></div>';
    el.querySelector('b').textContent = title;
    el.querySelector('span').textContent = text;
    if (href) el.addEventListener('click', function () { location.hash = href; el.remove(); });
    else el.addEventListener('click', function () { el.remove(); });
    box.appendChild(el);
    setTimeout(function () { el.remove(); }, kind === 'warn' ? 12000 : 6500);
    while (box.children.length > 4) box.removeChild(box.firstChild);
  }

  function beep() {
    try {
      var Ctx = window.AudioContext || window.webkitAudioContext;
      var ctx = S.audio || (S.audio = new Ctx());
      var o = ctx.createOscillator();
      var g = ctx.createGain();
      o.type = 'square';
      o.frequency.value = 880;
      g.gain.value = 0.035;
      o.connect(g);
      g.connect(ctx.destination);
      o.start();
      o.frequency.setValueAtTime(660, ctx.currentTime + 0.09);
      o.stop(ctx.currentTime + 0.2);
    } catch (e) { /* sin audio */ }
  }

  // ───────────────────────────────────────────────────────────── cromo (barra superior, navegación)

  function setCount(id, n) {
    var el = document.getElementById(id);
    if (!el) return;
    el.hidden = !n;
    el.textContent = n > 99 ? '99+' : String(n);
  }

  function updateChrome() {
    var m = S.model;
    var v = S.route.view;
    $$('.nav').forEach(function (a) {
      var nv = a.getAttribute('data-view');
      var cur = nv === v || (nv === 'projects' && v === 'project') || (nv === 'sessions' && v === 'session');
      if (cur) a.setAttribute('aria-current', 'page');
      else a.removeAttribute('aria-current');
    });
    if (!m) return;
    setCount('n-sessions', m.kpis.waiting);
    setCount('n-plans', m.kpis.plansPending);
    setCount('n-tasks', 0);
    var ab = $('#alert-btn');
    ab.hidden = !m.kpis.waiting;
    $('#alert-n').textContent = m.kpis.waiting;
    $('#alert-btn .lbl').textContent = m.kpis.waiting === 1 ? 'te espera' : 'te esperan';
    var pill = $('#link-pill');
    var txt;
    var st;
    if (S.source === 'server') { txt = S.link === 'lost' ? 'Reconectando…' : 'En vivo · ' + location.host; st = S.link === 'lost' ? 'error' : 'working'; }
    else if (S.source === 'folder') { txt = 'Carpeta · ' + (S.claudeDir || '.claude'); st = 'idle'; }
    else if (S.source === 'demo') { txt = 'Demo'; st = 'recent'; }
    else { txt = 'Sin enlace'; st = 'ended'; }
    var html = orb(st) + '<b>' + esc(txt) + '</b>';
    if (pill.innerHTML !== html) pill.innerHTML = html;
    pill.className = 'link-pill' + (S.source === 'server' && S.link !== 'lost' ? ' live' : S.link === 'lost' ? ' lost' : '');
    var title = (m.kpis.waiting ? '(' + m.kpis.waiting + ') ' : '') + 'NEXUS Mission Control';
    if (document.title !== title) document.title = title;
    document.body.classList.toggle('fx-off', !S.p.fx);
    document.body.classList.toggle('calm', !!S.p.calm);
  }

  function tickClock() {
    var d = new Date();
    var el = $('#clock');
    if (el) el.innerHTML = '<b>' + C.fmtTime(d.getTime()) + '</b> · ' + DOW[d.getDay()] + ' ' + d.getDate() + ' ' + MONTHS[d.getMonth()];
  }

  function glitch() {
    var logo = $('#logo');
    if (!logo || S.p.calm) return;
    if (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    logo.classList.remove('glitch');
    void logo.offsetWidth;
    logo.classList.add('glitch');
  }

  // ───────────────────────────────────────────────────────────── rutas

  function parseRoute() {
    var h = location.hash.replace(/^#\/?/, '');
    var parts = h.split('/');
    var view = parts[0] || 'overview';
    var id = parts.length > 1 ? decodeURIComponent(parts.slice(1).join('/')) : null;
    if (!VIEWS_OK[view]) view = 'overview';
    return { view: view, id: id };
  }

  window.addEventListener('hashchange', function () {
    var r = parseRoute();
    var changedView = r.view !== S.route.view;
    var changed = changedView || r.id !== S.route.id;
    S.route = r;
    if (!changed) return;
    // En planes solo cambia el documento seleccionado: no hace falta redibujar desde cero.
    var reset = changedView || r.view === 'project' || r.view === 'session';
    S.fresh = reset;
    closeSearch();
    render();
    if (reset) $('#view').scrollTop = 0;
  });

  // ───────────────────────────────────────────────────────────── búsqueda global

  var searchSel = -1;

  function searchResults(q) {
    var m = S.model;
    q = q.toLowerCase().trim();
    if (!q || !m) return [];
    var has = function (s) { return !!s && String(s).toLowerCase().indexOf(q) >= 0; };
    return [
      { h: 'Proyectos', items: m.projects.filter(function (p) { return has(p.name) || has(p.path); }).slice(0, 5).map(function (p) { return { href: hrefProject(p.key), t: p.name, s: (CAT[p.category] || CAT.other).short }; }) },
      { h: 'Sesiones', items: m.sessions.filter(function (s) { return has(s.title) || has(s.lastPrompt) || has(s.id) || has(s.branch); }).slice(0, 5).map(function (s) { return { href: hrefSession(s.id), t: s.title, s: s.project }; }) },
      { h: 'Tareas', items: m.tasks.filter(function (t) { return has(t.subject); }).slice(0, 6).map(function (t) { return { href: t.sessionId ? hrefSession(t.sessionId) : hrefProject(t.key), t: t.subject, s: STATUS_TXT[t.blocked ? 'blocked' : t.status] }; }) },
      { h: 'Planes', items: m.plans.filter(function (p) { return has(p.title) || has(p.md); }).slice(0, 5).map(function (p) { return { href: hrefPlan(p.id), t: p.title, s: PLAN_TXT[p.status] }; }) },
      { h: 'Tandas', items: m.runs.filter(function (r) { return has(r.p); }).slice(0, 5).map(function (r) { return { href: hrefSession(r.sessionId), t: r.p, s: projName(r.key) }; }) }
    ].filter(function (g) { return g.items.length; });
  }

  function renderSearch() {
    var pop = $('#search-pop');
    var q = $('#q').value;
    if (!q.trim()) { closeSearch(); return; }
    var groups = searchResults(q);
    var html = '';
    var idx = 0;
    groups.forEach(function (g) {
      html += '<h6>' + esc(g.h) + '</h6>';
      g.items.forEach(function (it) {
        html += '<a href="' + esc(it.href) + '" role="option" data-i="' + idx + '"' + (idx === searchSel ? ' class="sel" aria-selected="true"' : '') + '><span>' + esc(it.t) + '</span><small>' + esc(it.s || '') + '</small></a>';
        idx++;
      });
    });
    pop.innerHTML = html || '<div class="none">Sin resultados para «' + esc(q) + '».</div>';
    pop.hidden = false;
  }

  function closeSearch() {
    var pop = $('#search-pop');
    if (pop) pop.hidden = true;
    searchSel = -1;
  }

  // ───────────────────────────────────────────────────────────── configuración de proyectos

  function setProjectCfg(key, patch) {
    var cur = Object.assign({}, S.config.projects[key] || {}, patch);
    Object.keys(cur).forEach(function (k) { if (cur[k] === '' || cur[k] === null || cur[k] === false || cur[k] === undefined) delete cur[k]; });
    if (Object.keys(cur).length) S.config.projects[key] = cur;
    else delete S.config.projects[key];
    saveConfig();
    scheduleModel(true);
  }

  function saveConfig() {
    if (S.source === 'server') {
      fetch('api/config', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(S.config) })
        .then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); })
        .catch(function () { toast('warn', 'No se guardó', 'El servidor de NEXUS no respondió. Revisa que siga en marcha.'); });
    } else {
      try { localStorage.setItem(cfgKey(), JSON.stringify(S.config)); } catch (e) { /* sin almacenamiento */ }
    }
  }

  // ───────────────────────────────────────────────────────────── eventos

  function copyText(text) {
    var done = function () { toast('done', 'Copiado', text); };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(done, function () { fallbackCopy(text); done(); });
    } else { fallbackCopy(text); done(); }
  }

  function fallbackCopy(text) {
    var ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    try { document.execCommand('copy'); } catch (e) { /* nada */ }
    ta.remove();
  }

  function handleAct(el, ev) {
    var act = el.getAttribute('data-act');
    var key = el.getAttribute('data-key');
    switch (act) {
      case 'seg':
        S.p[el.getAttribute('data-pref')] = el.getAttribute('data-val');
        savePrefs();
        render();
        break;
      case 'more':
        S.more[el.getAttribute('data-more')] = limit(el.getAttribute('data-more'), 0) + (+el.getAttribute('data-step') || 60) + (S.more[el.getAttribute('data-more')] ? 0 : defaultLimit(el.getAttribute('data-more')));
        render();
        break;
      case 'run':
        var id = el.getAttribute('data-id');
        if (S.expanded[id]) delete S.expanded[id]; else S.expanded[id] = 1;
        render();
        break;
      case 'copy':
        copyText(el.getAttribute('data-copy'));
        break;
      case 'stage':
        var p = S.model.projectMap[key];
        var stg = el.getAttribute('data-stage');
        setProjectCfg(key, { stage: p && p.stage === stg ? '' : stg });
        break;
      case 'pin':
        setProjectCfg(key, { pinned: !(S.config.projects[key] || {}).pinned });
        break;
      case 'hide':
        setProjectCfg(key, { hidden: !(S.config.projects[key] || {}).hidden });
        break;
      case 'sort':
        var sk = el.getAttribute('data-sort');
        if (S.p.ssort === sk) S.p.sdir = -S.p.sdir; else { S.p.ssort = sk; S.p.sdir = sk === 'title' || sk === 'project' || sk === 'origin' || sk === 'state' ? 1 : -1; }
        savePrefs();
        render();
        break;
      case 'tbl':
        var tp = el.getAttribute('data-pref');
        S.p[tp] = !S.p[tp];
        savePrefs();
        render();
        break;
      case 'goto-state':
        ev.preventDefault();
        S.p.sst = el.getAttribute('data-state');
        savePrefs();
        go('#/sessions');
        break;
      case 'goto-done':
        ev.preventDefault();
        S.p.trange = 'today';
        S.p.tview = 'board';
        savePrefs();
        go('#/tasks');
        break;
      case 'goto-proj':
        ev.preventDefault();
        S.t.proj[el.getAttribute('data-view')] = key;
        go('#/' + el.getAttribute('data-view'));
        break;
      case 'rescan':
        if (S.source === 'server') fetch('api/rescan', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }).then(function () { toast('done', 'Reescaneo', 'Releyendo ~/.claude completo.'); });
        else if (S.source === 'folder' && S.collector) folderScan(true).then(function () { toast('done', 'Reescaneo', 'Carpeta releída.'); });
        break;
      case 'clear-aliases':
        S.config.aliases = {};
        saveConfig();
        scheduleModel(true);
        break;
      case 'show-connect':
        showConnect();
        break;
      case 'close-connect':
        hideConnect();
        break;
      case 'pick-folder':
        pickFolder();
        break;
      case 'reconnect-folder':
        reconnectFolder();
        break;
      case 'demo':
        stopSources();
        startDemo();
        break;
      default:
        break;
    }
  }

  // Navega; si ya estamos en esa ruta, al menos redibuja con los filtros nuevos.
  function go(hash) {
    if (location.hash === hash) render();
    else location.hash = hash;
  }

  function defaultLimit(k) {
    if (k === 'runs') return 120;
    if (k === 'sessions') return 150;
    if (k === 'plans') return 80;
    if (k === 'projects') return 60;
    if (k.indexOf('col-') === 0) return 40;
    if (k === 'sd-runs') return 40;
    if (k === 'pd-tasks') return 30;
    if (k.indexOf('tg-') === 0) return 12;
    return 60;
  }

  var bindTimer = null;
  function handleBind(el, immediate) {
    var bind = el.getAttribute('data-bind');
    var parts = bind.split('.');
    var val = el.type === 'checkbox' ? el.checked : el.value;
    if (parts[0] === 'p') {
      S.p[parts[1]] = val;
      savePrefs();
      if (parts[1] === 'notify' && val && typeof Notification !== 'undefined' && Notification.permission === 'default') Notification.requestPermission();
      updateChrome();
    } else if (parts[0] === 'q') {
      S.t.q[parts[1]] = val;
    } else if (parts[0] === 'proj') {
      S.t.proj[parts[1]] = val;
    }
    clearTimeout(bindTimer);
    if (immediate) render();
    else bindTimer = setTimeout(render, 140);
  }

  function handleCfg(el) {
    var key = el.getAttribute('data-key');
    var field = el.getAttribute('data-cfg');
    var val = el.type === 'checkbox' ? el.checked : el.value.trim();
    if (field === 'alias') {
      if (val) { S.config.aliases[key] = val; saveConfig(); scheduleModel(true); location.hash = hrefProject(val); }
      return;
    }
    var patch = {};
    patch[field] = val;
    if (field === 'category') {
      var p = S.model.projectMap[key];
      if (p && val === p.autoCategory) patch.category = '';
      patch.stage = ''; // las etapas dependen de la categoría
    }
    setProjectCfg(key, patch);
  }

  document.addEventListener('click', function (e) {
    var act = e.target.closest('[data-act]');
    if (act) {
      handleAct(act, e);
      return;
    }
    var tr = e.target.closest('tr[data-href]');
    if (tr && !e.target.closest('a,button,input,select')) location.hash = tr.getAttribute('data-href');
    if (!e.target.closest('#search')) closeSearch();
  });

  document.addEventListener('input', function (e) {
    if (e.target.id === 'q') { searchSel = -1; renderSearch(); return; }
    var el = e.target.closest('[data-bind]');
    if (el && (el.type === 'search' || el.type === 'text')) handleBind(el, false);
  });

  document.addEventListener('change', function (e) {
    var el = e.target.closest('[data-bind]');
    if (el && el.type !== 'search' && el.type !== 'text') { handleBind(el, true); return; }
    var cfg = e.target.closest('[data-cfg]');
    if (cfg) handleCfg(cfg);
  });

  document.addEventListener('keydown', function (e) {
    var typing = /^(INPUT|TEXTAREA|SELECT)$/.test((e.target && e.target.tagName) || '') || (e.target && e.target.isContentEditable);
    if (e.target && e.target.id === 'q') {
      var links = $$('#search-pop a');
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        if (!links.length) return;
        searchSel = e.key === 'ArrowDown' ? (searchSel + 1) % links.length : (searchSel - 1 + links.length) % links.length;
        renderSearch();
        return;
      }
      if (e.key === 'Enter') {
        var target = links[searchSel >= 0 ? searchSel : 0];
        if (target) { location.hash = target.getAttribute('href'); e.target.blur(); closeSearch(); }
        return;
      }
      if (e.key === 'Escape') { e.target.value = ''; closeSearch(); e.target.blur(); }
      return;
    }
    if (e.key === 'Escape' && !$('#connect').hidden && !$('#connect-close').hidden) { hideConnect(); return; }
    if (typing || e.metaKey || e.ctrlKey || e.altKey) return;
    if (e.key === '/') { e.preventDefault(); $('#q').focus(); return; }
    var map = { 1: 'overview', 2: 'projects', 3: 'tasks', 4: 'plans', 5: 'runs', 6: 'sessions', 7: 'settings' };
    if (map[e.key]) location.hash = '#/' + map[e.key];
  });

  $('#search-pop').addEventListener('click', function (e) {
    var a = e.target.closest('a');
    if (a) { closeSearch(); $('#q').value = ''; }
  });

  $('#alert-btn').addEventListener('click', function () {
    S.p.sst = 'waiting';
    savePrefs();
    go('#/sessions');
  });

  // Tooltips de los gráficos: texto con textContent (los datos no se interpretan como HTML).
  var tip = $('#tip');
  function showTip(el) {
    tip.textContent = '';
    var b = document.createElement('b');
    b.textContent = el.getAttribute('data-tv');
    tip.appendChild(b);
    var l = el.getAttribute('data-tl');
    if (l) { var sp = document.createElement('span'); sp.textContent = l; tip.appendChild(sp); }
    tip.hidden = false;
    var r = el.getBoundingClientRect();
    var tw = tip.offsetWidth;
    var th = tip.offsetHeight;
    var x = Math.max(tw / 2 + 8, Math.min(window.innerWidth - tw / 2 - 8, r.left + r.width / 2));
    var y = r.top;
    if (y - th - 14 < 0) y = r.bottom + th + 14;
    tip.style.left = x + 'px';
    tip.style.top = y + 'px';
  }
  function hideTip() { tip.hidden = true; }
  document.addEventListener('pointerover', function (e) {
    var t = e.target.closest && e.target.closest('[data-tv]');
    if (t) showTip(t); else hideTip();
  });
  document.addEventListener('focusin', function (e) {
    var t = e.target.closest && e.target.closest('[data-tv]');
    if (t) showTip(t);
  });
  document.addEventListener('focusout', hideTip);
  $('#view').addEventListener('scroll', hideTip, { passive: true });

  // ───────────────────────────────────────────────────────────── fuentes de datos

  function emptyData() { return { sessions: {}, taskLists: {}, plans: {}, live: {}, meta: {} }; }

  function applySnapshot(snap) {
    S.data = {
      sessions: snap.sessions || {},
      taskLists: snap.taskLists || {},
      plans: snap.plans || {},
      live: snap.live || {},
      meta: snap.meta || {}
    };
    S.seq = snap.seq || 0;
    S.ready = snap.ready !== false;
    if (snap.config) S.config = C.normalizeConfig(snap.config);
    if (snap.claudeDir) S.claudeDir = snap.claudeDir;
    if (snap.server) S.server = snap.server;
    scheduleModel(true);
  }

  function applyDelta(d) {
    var id;
    for (id in d.sessions || {}) { if (d.sessions[id]) S.data.sessions[id] = d.sessions[id]; else delete S.data.sessions[id]; }
    for (id in d.taskLists || {}) { if (d.taskLists[id]) S.data.taskLists[id] = d.taskLists[id]; else delete S.data.taskLists[id]; }
    for (id in d.plans || {}) { if (d.plans[id]) S.data.plans[id] = d.plans[id]; else delete S.data.plans[id]; }
    if (d.live) S.data.live = d.live;
    if (d.meta) S.data.meta = d.meta;
    scheduleModel(false);
  }

  function stopSources() {
    if (S.timer) { clearInterval(S.timer); S.timer = null; }
    if (S.es) { S.es.close(); S.es = null; }
    S.collector = null;
    S.primed = false;
    S.prev = {};
  }

  async function tryServer() {
    if (!/^https?:$/.test(location.protocol)) return false;
    try {
      var r = await fetch('api/health', { cache: 'no-store' });
      if (!r.ok) return false;
      var h = await r.json();
      if (!h || h.name !== 'nexus') return false;
    } catch (e) {
      return false;
    }
    S.source = 'server';
    await loadServerSnapshot();
    openStream();
    return true;
  }

  async function loadServerSnapshot() {
    S.loading = true;
    try {
      var r = await fetch('api/snapshot', { cache: 'no-store' });
      var snap = await r.json();
      applySnapshot(snap);
      if (!snap.ready) showBooting(); else hideConnect();
    } catch (e) {
      S.link = 'lost';
    } finally {
      S.loading = false;
    }
    var buf = S.buffer.sort(function (a, b) { return a.seq - b.seq; });
    S.buffer = [];
    buf.forEach(function (d) { if (d.seq === S.seq + 1) { S.seq = d.seq; applyDelta(d); } });
  }

  function openStream() {
    var es = new EventSource('api/stream');
    S.es = es;
    es.addEventListener('hello', function (e) {
      S.link = 'live';
      updateChrome();
      var h = JSON.parse(e.data);
      if (h.seq !== S.seq && !S.loading) loadServerSnapshot();
    });
    es.addEventListener('delta', function (e) {
      var d = JSON.parse(e.data);
      if (S.loading) { S.buffer.push(d); return; }
      if (d.seq <= S.seq) return;
      if (d.seq !== S.seq + 1) { loadServerSnapshot(); return; }
      S.seq = d.seq;
      applyDelta(d);
    });
    es.addEventListener('ready', function () { loadServerSnapshot(); });
    es.addEventListener('progress', function (e) { S.progress = JSON.parse(e.data); showBooting(); });
    es.addEventListener('config', function (e) { S.config = C.normalizeConfig(JSON.parse(e.data)); scheduleModel(true); });
    es.addEventListener('notify', function (e) {
      var n = JSON.parse(e.data);
      if (!n.message) return;
      var s = n.sessionId && S.model && S.model.sessionMap[n.sessionId];
      alertUser('warn', s ? s.project : 'Claude Code', n.message, n.sessionId ? hrefSession(n.sessionId) : null);
    });
    es.onerror = function () { S.link = 'lost'; updateChrome(); };
  }

  async function folderScan(full) {
    var col = S.collector;
    if (!col || S.scanning) return;
    S.scanning = true;
    try {
      var ch = await col.scan({ full: !!full });
      var d = { sessions: {}, taskLists: {}, plans: {}, live: ch.live ? col.live : null, meta: col.publicMeta() };
      ch.sessions.forEach(function (id) { d.sessions[id] = col.sessions[id] ? C.publicSession(col.sessions[id]) : null; });
      (ch.taskIds || []).forEach(function (id) { var l = col.taskLists[id]; d.taskLists[id] = l ? { id: l.id, tasks: l.tasks, mtime: l.mtime, archived: l.archived } : null; });
      (ch.planNames || []).forEach(function (n) { d.plans[n] = col.plans[n] || null; });
      applyDelta(d);
    } catch (e) {
      console.error(e);
    } finally {
      S.scanning = false;
    }
  }

  async function startFolder(handle) {
    var ok = await FS.ensurePermission(handle);
    if (!ok) throw new Error('No se concedió permiso de lectura.');
    if (!(await FS.looksLikeClaudeDir(handle))) throw new Error('Esa carpeta no parece ser ~/.claude: no contiene «projects». Elige la carpeta .claude de tu usuario.');
    await FS.saveHandle(handle);
    stopSources();
    S.source = 'folder';
    S.claudeDir = handle.name;
    S.config = loadLocalConfig();
    var col = new C.Collector(FS.createBrowserAdapter(handle));
    S.collector = col;
    col.onProgress = function (meta) { S.progress = { bytes: meta.bytes, lines: meta.lines }; showBooting(); };
    showBooting();
    await col.scan({ full: true });
    var snap = col.snapshot();
    snap.ready = true;
    applySnapshot(snap);
    hideConnect();
    var lastFull = Date.now();
    S.timer = setInterval(function () {
      var full = Date.now() - lastFull > 60000;
      if (full) lastFull = Date.now();
      folderScan(full);
    }, 2500);
  }

  async function pickFolder() {
    var err = $('#connect-err');
    err.hidden = true;
    try {
      var h = await FS.pick();
      await startFolder(h);
    } catch (e) {
      if (e && e.name === 'AbortError') return;
      err.textContent = (e && e.message) || String(e);
      err.hidden = false;
      showConnect();
    }
  }

  async function reconnectFolder() {
    var err = $('#connect-err');
    err.hidden = true;
    try {
      var h = await FS.loadHandle();
      if (!h) throw new Error('No hay ninguna carpeta guardada.');
      await startFolder(h);
    } catch (e) {
      err.textContent = (e && e.message) || String(e);
      err.hidden = false;
      showConnect();
    }
  }

  function startDemo() {
    stopSources();
    S.source = 'demo';
    S.config = loadLocalConfig();
    var demo = DEMO.create(Date.now());
    applySnapshot(demo.snapshot);
    hideConnect();
    S.timer = setInterval(function () {
      var d = demo.tick(Date.now());
      if (d) applyDelta(d);
    }, 1700);
  }

  // ───────────────────────────────────────────────────────────── pantalla de conexión

  function showConnect() {
    var c = $('#connect');
    c.classList.remove('booting');
    $('.opts', c).hidden = false;
    $('#opt-folder').hidden = !FS || !FS.supported || S.embedded;
    FS.loadHandle().then(function (h) { $('#btn-reconnect').hidden = !h; }).catch(function () {});
    $('#boot-log').innerHTML = S.source === 'demo' ? 'Ahora mismo ves la <b>demo</b>. Elige una fuente real:' : '';
    $('#connect-close').hidden = !S.model;
    c.hidden = false;
  }

  function showBooting() {
    var c = $('#connect');
    c.hidden = false;
    $('.opts', c).hidden = true;
    $('#connect-close').hidden = true;
    var p = S.progress;
    $('#boot-log').innerHTML = 'Leyendo el historial de Claude Code…<br>' +
      (p ? '<b>' + C.fmtNum(p.lines || 0) + '</b> líneas · <b>' + fmtBytes(p.bytes || 0) + '</b>' + (p.files ? ' · <b>' + C.fmtNum(p.files) + '</b> archivos' : '') : 'Preparando…') +
      '<div class="progress-line" style="margin-top:10px"></div>';
  }

  function hideConnect() {
    $('#connect').hidden = true;
    $('#connect-err').hidden = true;
  }

  // ───────────────────────────────────────────────────────────── arranque

  async function boot() {
    updateChrome();
    tickClock();
    setInterval(tickClock, 1000);
    setInterval(function () { if (S.model) scheduleModel(false); }, 5000);
    setTimeout(glitch, 900);
    setInterval(function () { if (Math.random() < 0.5) glitch(); }, 11000);
    var params;
    try { params = new URLSearchParams(location.search); } catch (e) { params = new URLSearchParams(''); }
    var wantDemo = params.has('demo');
    if (!wantDemo && await tryServer()) return;
    var local = location.protocol === 'file:' || /^(localhost|127\.0\.0\.1|\[::1\])$/.test(location.hostname);
    if (wantDemo || !local) { startDemo(); return; }
    // Abierto como archivo local sin servidor: se ofrece conectar la carpeta o ver la demo.
    startDemo();
    showConnect();
  }

  boot();
})();
