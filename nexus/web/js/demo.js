/*!
 * NEXUS — datos de demostración.
 * Genera un historial realista (proyectos de desarrollo y episodios de un canal de
 * YouTube) con el mismo formato que produce el colector, y lo mantiene "vivo".
 */
(function (root) {
  'use strict';

  var C = root.NexusCore;
  var HOME = '/Users/demo';
  var MIN = 60000;
  var HOUR = 60 * MIN;
  var DAY = 24 * HOUR;

  function mulberry32(a) {
    return function () {
      a |= 0;
      a = (a + 0x6d2b79f5) | 0;
      var t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  var PROJECTS = [
    {
      path: HOME + '/dev/app-finanzas', branch: 'feat/passkeys', win: [0, 120], hist: 24, entry: 'claude-desktop',
      prompts: ['Corrige el cálculo de interés compuesto en los préstamos', 'Escribe tests de integración para el módulo de presupuestos', 'Migra la base de datos de SQLite a Postgres con Drizzle', 'Haz que el dashboard cargue en menos de un segundo', 'Añade exportación a CSV de los movimientos', 'Revisa los avisos de accesibilidad del formulario de gastos', 'Crea la pantalla de metas de ahorro con gráfico de progreso'],
      files: ['src/app/login/page.tsx', 'src/lib/auth/passkeys.ts', 'src/app/api/auth/passkey/route.ts', 'src/lib/db/schema.ts', 'tests/e2e/login.spec.ts', 'src/lib/finance/interest.ts', 'src/components/BudgetChart.tsx', 'drizzle/0007_passkeys.sql', 'README.md'],
      cmds: ['npm test', 'npm run build', 'npx playwright test tests/e2e/login.spec.ts', 'git status', 'npx drizzle-kit generate', 'npm run lint -- --fix', 'git diff --stat'],
      greps: ['getServerSession', 'calcInterest', 'passkey', 'TODO'],
      results: ['Corregido: el interés se capitalizaba dos veces al mes. Añadí 6 tests.', 'Migración generada y aplicada; todos los tests en verde.', 'El dashboard baja de 2,4 s a 0,8 s con caché de consultas.', 'Exportación a CSV lista, con separador configurable.']
    },
    {
      path: HOME + '/dev/api-pagos', branch: 'fix/reembolsos', win: [0, 90], hist: 13, entry: 'cli',
      prompts: ['Implementa webhooks de Stripe con verificación de firma', 'Investiga por qué falla el test de reembolsos en CI', 'Documenta la API con OpenAPI 3.1', 'Añade límites de tasa por cliente', 'Agrega idempotencia a POST /pagos'],
      files: ['internal/webhooks/stripe.go', 'internal/payments/refund.go', 'internal/payments/refund_test.go', 'api/openapi.yaml', 'cmd/server/main.go', 'internal/ratelimit/limiter.go'],
      cmds: ['go test ./...', 'go test ./internal/payments -run TestRefund -v', 'golangci-lint run', 'docker compose up -d postgres', 'git log --oneline -5'],
      greps: ['RefundStatus', 'Idempotency-Key', 'func Test'],
      results: ['El test fallaba por la zona horaria del runner; ahora usa UTC.', 'Webhooks verificados con la firma de Stripe y reintentos idempotentes.', 'OpenAPI 3.1 completo: 14 endpoints documentados.']
    },
    {
      path: HOME + '/dev/portfolio-2077', branch: 'main', win: [10, 150], hist: 8, entry: 'claude-desktop',
      prompts: ['Rediseña el hero con estética cyberpunk', 'Optimiza las imágenes a AVIF y mide el LCP', 'Añade la sección de proyectos leyendo del CMS', 'Genera el sitemap y las etiquetas Open Graph'],
      files: ['src/pages/index.astro', 'src/components/Hero.astro', 'src/styles/global.css', 'astro.config.mjs', 'src/content/proyectos/nexus.md'],
      cmds: ['npm run build', 'npx astro check', 'npx lighthouse http://localhost:4321 --quiet'],
      results: ['LCP de 3,1 s a 1,2 s con imágenes AVIF y fuentes precargadas.', 'Hero rediseñado con rejilla en perspectiva y texto con glitch.']
    },
    {
      path: HOME + '/dev/bot-discord-comunidad', branch: 'main', win: [20, 170], hist: 7, entry: 'cli',
      prompts: ['Añade el comando /proximo-video que lea el calendario', 'Arregla el bug de roles duplicados al entrar', 'Publica un aviso automático cuando salga un vídeo nuevo'],
      files: ['src/commands/proximo-video.ts', 'src/events/guildMemberAdd.ts', 'src/services/youtube.ts', 'src/index.ts'],
      cmds: ['npm run dev', 'npm test', 'npx tsc --noEmit'],
      results: ['/proximo-video responde con fecha, título y cuenta atrás.', 'Los roles ya no se duplican: faltaba comprobar la caché.']
    },
    {
      path: HOME + '/youtube/ep-47-ia-local', branch: null, win: [28, 46], hist: 9, entry: 'claude-desktop', stage: 'Publicado',
      prompts: ['Escribe el guion del episodio 47 sobre IA local (10 min)', 'Genera los subtítulos .srt con whisper', 'Corta los silencios del crudo con auto-editor', 'Propón 5 títulos y 3 conceptos de miniatura', 'Arma la descripción con capítulos y enlaces'],
      files: ['guion/ep47-guion.md', 'subs/ep47.srt', 'edit/ep47-cortes.txt', 'publicacion/descripcion.md', 'thumbnails/ideas.md'],
      cmds: ['whisper audio/ep47-voz.wav --language es --output_format srt', 'auto-editor crudo/ep47.mp4 --margin 0.2s', 'ffprobe -v error -show_format crudo/ep47.mp4'],
      results: ['Guion listo: 1.620 palabras, unos 10 minutos.', 'Subtítulos generados: 388 líneas sincronizadas.', 'Descripción con 9 capítulos y enlaces.']
    },
    {
      path: HOME + '/youtube/ep-48-agentes-ia', branch: null, win: [0, 12], hist: 6, entry: 'claude-desktop', stage: 'Guion',
      prompts: ['Investiga las novedades de agentes de IA de las últimas dos semanas', 'Propón la estructura del episodio 48 con tres ganchos', 'Busca B-roll libre de derechos para cada bloque'],
      files: ['guion/ep48-guion.md', 'guion/fuentes.md', 'guion/estructura.md', 'broll/lista.md', 'thumbnails/ideas.md'],
      cmds: ['ls guion', 'wc -w guion/ep48-guion.md', 'python scripts/leer_rss.py --dias 14'],
      greps: ['gancho', 'CTA', 'fuente'],
      results: ['Estructura con gancho a los 5 s y tres bloques de 3 minutos.', '12 fuentes verificadas y resumidas.']
    },
    {
      path: HOME + '/youtube/shorts-automatizados', branch: 'main', win: [0, 60], hist: 10, entry: 'claude-desktop',
      prompts: ['Crea un script que pase clips horizontales a 9:16 con subtítulos quemados', 'Añade detección de caras para reencuadrar', 'Programa la subida con la API de YouTube', 'Normaliza el audio de todos los shorts a -14 LUFS'],
      files: ['pipeline/reframe.py', 'pipeline/subtitles.py', 'pipeline/upload.py', 'config/canal.yaml', 'README.md'],
      cmds: ['python pipeline/reframe.py clips/ep47 --out shorts/', 'ffmpeg -i clips/ep47_03.mp4 -vf "crop=ih*9/16:ih" -c:a copy shorts/s03.mp4', 'ffmpeg -i shorts/s03.mp4 -af loudnorm=I=-14 shorts/s03_norm.mp4', 'pytest -q'],
      results: ['Pipeline listo: 6 shorts exportados en 1080×1920 con subtítulos.', 'Audio normalizado a -14 LUFS en 18 clips.']
    },
    {
      path: HOME + '/youtube/miniaturas-lab', branch: null, win: [2, 100], hist: 7, entry: 'claude-desktop',
      prompts: ['Genera 3 variantes de miniatura con texto grande y mucho contraste', 'Redimensiona todas las miniaturas a 1280×720', 'Compara el CTR de las últimas 10 miniaturas'],
      files: ['plantillas/base.psd', 'scripts/export.py', 'datos/ctr.csv', 'variantes/ep48-a.png'],
      cmds: ['magick variantes/*.png -resize 1280x720 salida/', 'python scripts/export.py --ep 48'],
      results: ['3 variantes exportadas; la B tiene el texto más legible en móvil.', 'CTR medio del 6,8 %; los rostros con texto corto rinden mejor.']
    },
    {
      path: HOME + '/contenido/newsletter-semanal', branch: 'main', win: [0, 180], hist: 22, entry: 'claude-desktop', weekly: true,
      prompts: ['Redacta la newsletter de esta semana con las 5 noticias de IA', 'Resume estos 3 papers en lenguaje sencillo', 'Revisa el tono y acorta la intro a 60 palabras'],
      files: ['numeros/2026-39.md', 'numeros/2026-38.md', 'plantilla.md', 'fuentes.md'],
      cmds: ['wc -w numeros/2026-39.md', 'npx markdownlint numeros/'],
      results: ['Número 39 listo: 5 noticias, 820 palabras.', 'Resúmenes de los 3 papers en menos de 120 palabras cada uno.']
    },
    {
      path: HOME + '/contenido/curso-python-cero', branch: 'main', win: [15, 140], hist: 10, entry: 'cli', stage: 'Revisión',
      prompts: ['Crea los ejercicios del módulo 4 (diccionarios)', 'Revisa las soluciones y añade tests automáticos', 'Escribe el guion de la lección de comprensiones de listas'],
      files: ['modulo-4/ejercicios.md', 'modulo-4/soluciones.py', 'tests/test_modulo4.py', 'modulo-5/guion.md'],
      cmds: ['pytest tests/test_modulo4.py -q', 'python -m doctest modulo-4/soluciones.py'],
      results: ['12 ejercicios con dificultad progresiva y sus tests.', 'Todas las soluciones pasan; corregí 2 enunciados ambiguos.']
    },
    {
      path: HOME + '/infra/homelab-docker', branch: 'main', win: [0, 160], hist: 9, entry: 'cli',
      prompts: ['Configura Traefik con certificados automáticos', 'Haz backup diario de los volúmenes a un NAS', 'Actualiza las imágenes de Docker y revisa cambios incompatibles'],
      files: ['compose/traefik.yml', 'compose/servicios.yml', 'scripts/backup.sh', 'docs/red.md'],
      cmds: ['docker compose -f compose/traefik.yml config', 'docker compose pull', 'bash scripts/backup.sh --dry-run', 'docker ps --format "{{.Names}}"'],
      results: ['Traefik sirviendo 7 servicios con HTTPS automático.', 'Backup diario a las 03:30 con retención de 14 días.']
    },
    {
      path: HOME + '/research/benchmark-llms-locales', branch: 'main', win: [5, 70], hist: 6, entry: 'claude-desktop',
      prompts: ['Compara la velocidad de 4 modelos locales en mi GPU', 'Grafica tokens por segundo según modelo y cuantización', 'Resume los resultados en una tabla para el vídeo'],
      files: ['bench/run.py', 'bench/resultados.csv', 'notebooks/analisis.ipynb', 'informe.md'],
      cmds: ['python bench/run.py --modelos 4 --repeticiones 5', 'nvidia-smi --query-gpu=name,memory.used --format=csv'],
      results: ['Q4 rinde 2,3× más que FP16 con una pérdida mínima de calidad.', 'Tabla lista con 16 combinaciones modelo × cuantización.']
    }
  ];

  function byPath(path) {
    for (var i = 0; i < PROJECTS.length; i++) if (PROJECTS[i].path === path) return PROJECTS[i];
    return null;
  }

  // Escenario en vivo: quién está trabajando ahora mismo y en qué.
  var LIVE = [
    {
      path: HOME + '/dev/app-finanzas', status: 'busy', startedMin: 38, title: 'Login con passkeys',
      prompt: 'Agrega autenticación con passkeys al login sin romper las sesiones actuales',
      tasks: [
        ['Revisar el flujo actual de login y sesiones', 'Revisando el flujo de login', 'completed'],
        ['Instalar @simplewebauthn/server y /browser', 'Instalando dependencias', 'completed'],
        ['Crear tabla passkeys y migración', 'Creando la migración de passkeys', 'completed'],
        ['Endpoints de registro y verificación de passkeys', 'Creando los endpoints de passkeys', 'in_progress'],
        ['Botón «Entrar con passkey» en el formulario', 'Adaptando el formulario de login', 'pending', ['4']],
        ['Tests e2e con autenticador virtual de Chrome', 'Escribiendo tests e2e', 'pending', ['4', '5']]
      ],
      plan: '# Plan: login con passkeys\n\n## Contexto\nEl login actual usa email y contraseña con NextAuth. Añadimos passkeys (WebAuthn) sin romper las sesiones existentes.\n\n## Pasos\n- [x] Revisar el flujo actual de login y las sesiones\n- [x] Instalar `@simplewebauthn/server` y `@simplewebauthn/browser`\n- [x] Crear la tabla `passkeys` (credentialId, publicKey, counter, userId)\n- [ ] Endpoints `POST /api/auth/passkey/register` y `/verify`\n- [ ] Botón «Entrar con passkey» en el formulario\n- [ ] Tests e2e con el autenticador virtual de Chrome\n\n## Riesgos\n- Safari exige `userVerification: "preferred"`.\n- Los usuarios sin passkey siguen entrando con contraseña.\n\n## Verificación\n`npm test` y `npx playwright test tests/e2e/login.spec.ts` en verde.',
      planStatus: 'approved', waitChance: 0.035, waitReasons: ['dialog open', 'Claude necesita tu permiso para usar Bash: npx drizzle-kit push'],
      pr: null
    },
    {
      path: HOME + '/youtube/ep-48-agentes-ia', status: 'busy', startedMin: 21, title: 'Guion del episodio 48',
      prompt: 'Escribe el guion del episodio 48 sobre agentes de IA: 12 minutos, tono cercano y tres ganchos',
      tasks: [
        ['Leer fuentes.md y elegir las 5 noticias clave', 'Leyendo las fuentes', 'completed'],
        ['Escribir la estructura con tiempos por bloque', 'Escribiendo la estructura', 'completed'],
        ['Redactar el guion completo', 'Redactando el guion completo', 'in_progress'],
        ['Revisar ritmo, ganchos y llamada a la acción', 'Revisando el ritmo', 'pending'],
        ['Preparar la lista de B-roll por bloque', 'Preparando el B-roll', 'pending']
      ],
      plan: '# Plan: episodio 48 · Agentes de IA\n\n| Bloque | Tiempo | Objetivo |\n|---|---|---|\n| Gancho | 0:00–0:30 | «Este agente trabajó 6 horas solo» |\n| Qué es un agente | 0:30–3:00 | Explicación con analogía |\n| Demo en vivo | 3:00–8:00 | Claude Code resolviendo una tarea real |\n| Riesgos y límites | 8:00–11:00 | Qué no delegar |\n| Cierre | 11:00–12:00 | CTA al episodio 49 |\n\n## Checklist\n- [x] Fuentes verificadas\n- [x] Estructura con tiempos\n- [ ] Guion completo (≈1.900 palabras)\n- [ ] Lista de B-roll\n- [ ] 3 conceptos de miniatura',
      planStatus: 'approved', waitChance: 0.02, waitReasons: ['input needed']
    },
    {
      path: HOME + '/youtube/shorts-automatizados', status: 'waiting', waitingFor: 'goal proposal', startedMin: 9, title: 'Pipeline de shorts 9:16',
      prompt: 'Planifica cómo extraer 6 shorts verticales de cada episodio de forma automática',
      tasks: [],
      nextTasks: [
        ['Detectar los mejores momentos por energía de audio', 'Detectando los mejores momentos', 'in_progress'],
        ['Reencuadrar a 9:16 siguiendo la cara', 'Reencuadrando a 9:16', 'pending'],
        ['Quemar subtítulos con estilo del canal', 'Quemando subtítulos', 'pending'],
        ['Exportar y normalizar a -14 LUFS', 'Exportando los shorts', 'pending']
      ],
      plan: '# Plan: pipeline de shorts 9:16\n\n1. Analizar el audio del episodio y puntuar cada 20 s por energía y risas.\n2. Elegir los 6 fragmentos con mejor puntuación (30–55 s).\n3. Reencuadrar con detección de caras (`mediapipe`).\n4. Subtítulos palabra a palabra con `whisper` y quemado con `ffmpeg`.\n5. Normalizar audio a -14 LUFS y exportar a `shorts/`.\n\n## Preguntas\n- ¿Mantengo la marca de agua del canal?\n- ¿Subida automática o solo exportación?',
      planStatus: 'pending', waitChance: 0, approveAfter: 26000
    },
    {
      path: HOME + '/infra/homelab-docker', status: 'busy', startedMin: 14, title: 'Actualizar imágenes de Docker',
      prompt: 'Actualiza las imágenes de Docker y revisa cambios incompatibles antes de reiniciar',
      tasks: [
        ['Listar imágenes con versión nueva disponible', 'Listando imágenes', 'completed'],
        ['Leer notas de versión de Postgres, Traefik y Nextcloud', 'Leyendo notas de versión', 'in_progress'],
        ['Actualizar compose y reiniciar por servicio', 'Actualizando servicios', 'pending']
      ],
      subagents: true, waitChance: 0.02, waitReasons: ['Claude necesita tu permiso para usar Bash: docker compose up -d']
    },
    {
      path: HOME + '/dev/api-pagos', status: 'idle', startedMin: 64, endedMin: 6, title: 'Idempotencia en pagos',
      prompt: 'Agrega idempotencia a POST /pagos con Redis',
      tasks: [
        ['Middleware de Idempotency-Key', 'Creando el middleware', 'completed'],
        ['Guardar respuestas en Redis 24 h', 'Guardando respuestas', 'completed'],
        ['Tests de reintentos concurrentes', 'Escribiendo tests', 'completed'],
        ['Documentar el header en OpenAPI', 'Documentando', 'completed']
      ],
      plan: '# Plan: idempotencia en /pagos\n\n- Guardar la clave en Postgres con índice único.\n- Responder 409 si llega la misma clave con otro cuerpo.',
      planStatus: 'rejected', planNote: 'Rechazado: usar Redis en lugar de Postgres.',
      pr: { n: 17, url: 'https://github.com/demo/api-pagos/pull/17', repo: 'demo/api-pagos' }
    }
  ];

  function create(now) {
    now = now || Date.now();
    var R = mulberry32(2077);
    var pick = function (a) { return a[Math.floor(R() * a.length)]; };
    var rint = function (a, b) { return a + Math.floor(R() * (b - a + 1)); };
    var sessions = {};
    var taskLists = {};
    var plans = {};
    var live = {};
    var pidSeq = 41200;

    function uuid() {
      var hex = '';
      for (var i = 0; i < 32; i++) hex += '0123456789abcdef'[Math.floor(R() * 16)];
      return hex.slice(0, 8) + '-' + hex.slice(8, 12) + '-4' + hex.slice(13, 16) + '-a' + hex.slice(17, 20) + '-' + hex.slice(20, 32);
    }

    function sample(arr, n) {
      var copy = arr.slice();
      var out = [];
      while (copy.length && out.length < n) out.push(copy.splice(Math.floor(R() * copy.length), 1)[0]);
      return out;
    }

    function toolEvent(p, t, sub) {
      var r = R();
      var name;
      var input;
      if (r < 0.26) { name = 'Read'; input = { file_path: p.path + '/' + pick(p.files) }; }
      else if (r < 0.46) { name = 'Edit'; input = { file_path: p.path + '/' + pick(p.files) }; }
      else if (r < 0.68) { name = 'Bash'; input = { command: pick(p.cmds) }; }
      else if (r < 0.8) { name = 'Grep'; input = { pattern: pick(p.greps || ['TODO', 'export', 'import']) }; }
      else if (r < 0.86) { name = 'Glob'; input = { pattern: pick(['**/*.md', 'src/**/*', '**/*.py', '**/*.ts']) }; }
      else if (r < 0.93) { name = 'Write'; input = { file_path: p.path + '/' + pick(p.files) }; }
      else if (r < 0.97) { name = 'WebSearch'; input = { query: pick(['novedades ' + C.baseName(p.path), 'documentación oficial', 'mejores prácticas 2026']) }; }
      else { name = 'Agent'; input = { subagent_type: 'Explore', description: 'Explorar el código relacionado' }; }
      var ev = { t: t, k: 'tool', x: C.describeTool(name, input), name: name, file: input.file_path };
      if (sub) ev.sub = 1;
      return ev;
    }

    function addTool(s, name, n) { s.tools[name] = (s.tools[name] || 0) + n; }

    // Consumo por hora y modelo, con la misma forma que lo guarda el parser (bumpUse en core.js).
    function addUse(s, t, dur, i, o, r, w) {
      var h0 = Math.floor(t / HOUR);
      var h1 = Math.floor((t + dur) / HOUR);
      var span = h1 - h0 + 1;
      for (var h = h0; h <= h1; h++) {
        var k = h + '|' + s.model;
        var a = s.use[k] || (s.use[k] = [0, 0, 0, 0]);
        a[0] += Math.round(i / span);
        a[1] += Math.round(o / span);
        a[2] += Math.round(r / span);
        a[3] += Math.round(w / span);
      }
    }

    function mkRun(p, s, t, dur, prompt, st, feed) {
      var tools = rint(5, 58);
      var ed = Math.round(tools * (0.08 + R() * 0.22));
      var bash = Math.round(tools * (0.1 + R() * 0.25));
      var sub = R() < 0.18 ? rint(1, 3) : 0;
      var tk = tools * rint(22, 64) * 1000;
      var out = Math.round(tk * (0.012 + R() * 0.018));
      var run = {
        id: uuid(), t: t, e: t + dur, p: prompt, src: 'human', st: st || (R() < 0.06 ? 'int' : 'ok'),
        tools: tools, ed: ed, bash: bash, err: R() < 0.12 ? rint(1, 2) : 0, sub: sub, msgs: rint(3, 28),
        out: out, tk: tk, files: sample(p.files, Math.max(1, Math.min(ed, rint(1, 4)))).map(function (f) { return p.path + '/' + f; }),
        res: st === 'run' ? null : pick(p.results)
      };
      s.runs.push(run);
      s.counts.prompts++;
      s.counts.messages += run.msgs;
      s.counts.tools += tools;
      s.counts.edits += ed;
      s.counts.bash += bash;
      s.counts.subagents += sub;
      s.counts.errors += run.err;
      if (run.st === 'int') s.counts.interrupts++;
      var cr = Math.round(tk * 0.84);
      var cw = Math.round(tk * 0.1);
      var inp = Math.max(0, tk - out - cr - cw);
      s.tokens.out += out;
      s.tokens.cr += cr;
      s.tokens.cw += cw;
      s.tokens.in += inp;
      addUse(s, t, dur, inp, out, cr, cw);
      addTool(s, 'Bash', bash);
      addTool(s, 'Edit', Math.max(0, ed - 1));
      addTool(s, 'Write', Math.min(1, ed));
      addTool(s, 'Read', Math.round((tools - bash - ed) * 0.55));
      addTool(s, 'Grep', Math.round((tools - bash - ed) * 0.3));
      addTool(s, 'Glob', Math.max(0, tools - bash - ed - Math.round((tools - bash - ed) * 0.55) - Math.round((tools - bash - ed) * 0.3)));
      if (sub) addTool(s, 'Agent', sub);
      run.files.forEach(function (f) { if (s.files.indexOf(f) < 0) s.files.push(f); });
      if (t > now - 72 * HOUR) {
        // reparte la actividad de la tanda por las horas que duró
        var h0 = Math.floor(t / HOUR);
        var h1 = Math.floor((t + dur) / HOUR);
        var span = h1 - h0 + 1;
        for (var h = h0; h <= h1; h++) {
          var a = s.act[String(h)] || (s.act[String(h)] = [0, 0]);
          a[0] += Math.round(tools / span);
          a[1] += Math.round(tk / span);
        }
      }
      if (feed) {
        feed.push({ t: t, k: 'prompt', x: '» ' + prompt });
        var n = Math.min(tools, 14);
        for (var i = 0; i < n; i++) feed.push(toolEvent(p, t + Math.round(((i + 1) / (n + 1)) * dur), false));
        if (run.res) feed.push({ t: t + dur, k: 'text', x: run.res });
      }
      return run;
    }

    function finishSession(s, feed) {
      feed.sort(function (a, b) { return a.t - b.t; });
      s.feed = feed.slice(-40).map(function (e) { var o = { t: e.t, k: e.k, x: e.x }; if (e.sub) o.sub = 1; return o; });
      s.last = s.feed.length ? s.feed[s.feed.length - 1] : null;
      var lastRun = s.runs[s.runs.length - 1];
      s.updatedAt = Math.max(s.updatedAt, lastRun ? lastRun.e : s.startedAt, s.last ? s.last.t : 0);
      s.fileMtime = s.updatedAt;
      s.tail = lastRun && lastRun.st === 'run' ? 'tool' : 'text';
      s.stopReason = 'end_turn';
      sessions[s.id] = s;
    }

    function newSession(p, start) {
      var s = C.createSessionState(uuid());
      delete s._pending;
      s.dir = p.path.replace(/[^A-Za-z0-9]/g, '-');
      s.cwd = s.cwd0 = p.path;
      s.gitBranch = p.branch;
      s.version = '2.1.283';
      s.entrypoint = R() < 0.8 ? p.entry : (p.entry === 'cli' ? 'claude-desktop' : 'cli');
      s.permissionMode = R() < 0.3 ? 'acceptEdits' : 'default';
      s.model = R() < 0.7 ? 'claude-opus-5-5' : 'claude-sonnet-5';
      s.models[s.model] = 1;
      s.startedAt = start;
      s.updatedAt = start;
      return s;
    }

    // ── historial
    PROJECTS.forEach(function (p) {
      for (var i = 0; i < p.hist; i++) {
        var daysAgo;
        if (p.weekly) daysAgo = Math.min(p.win[1], 2 + i * 7 + rint(0, 2));
        else daysAgo = p.win[0] + Math.pow(R(), 1.35) * (p.win[1] - p.win[0]);
        var day = now - daysAgo * DAY;
        var d = new Date(day);
        if ((d.getDay() === 0 || d.getDay() === 6) && R() < 0.45) day -= 2 * DAY;
        d = new Date(day);
        d.setHours(rint(9, 22), rint(0, 59), 0, 0);
        var start = d.getTime();
        if (start > now - 3 * HOUR) start = now - rint(3, 9) * HOUR;
        var s = newSession(p, start);
        var feed = [];
        var nRuns = rint(1, 6);
        var t = start;
        for (var r = 0; r < nRuns; r++) {
          var dur = rint(2, 34) * MIN;
          mkRun(p, s, t, dur, pick(p.prompts), null, feed);
          t += dur + rint(1, 20) * MIN;
        }
        s.firstPrompt = s.runs[0].p;
        s.lastPrompt = s.runs[s.runs.length - 1].p;
        s.aiTitle = s.firstPrompt.length > 60 ? s.firstPrompt.slice(0, 58) + '…' : s.firstPrompt;
        // TODOs de sesiones antiguas: casi siempre terminadas
        var nt = rint(2, 6);
        s.todos = [];
        for (var k = 0; k < nt; k++) {
          var done = R() < 0.92;
          var tt = start + Math.round(((k + 1) / (nt + 1)) * (t - start));
          s.todos.push({ c: pick(['Revisar', 'Implementar', 'Probar', 'Documentar', 'Ajustar']) + ' ' + pick(p.files).split('/').pop(), s: done ? 'completed' : 'pending', t0: start, t1: tt, done: done ? tt : undefined });
        }
        s.todosAt = t;
        if (R() < 0.22 && p.branch) s.prs.push({ n: rint(3, 90), url: 'https://github.com/demo/' + C.baseName(p.path) + '/pull/' + rint(3, 90), repo: 'demo/' + C.baseName(p.path), t: t });
        if (R() < 0.14) {
          s.plans.push({ id: uuid(), t: start + 4 * MIN, t1: start + 6 * MIN, title: 'Plan: ' + s.firstPrompt, md: '# Plan: ' + s.firstPrompt + '\n\n- [x] Analizar el estado actual\n- [x] Proponer cambios mínimos\n- [x] Implementar\n- [x] Verificar con pruebas', st: 'approved' });
        }
        finishSession(s, feed);
      }
    });

    // ── algo de trabajo en las últimas horas para los proyectos activos
    PROJECTS.filter(function (p) { return p.win[0] === 0; }).forEach(function (p, i) {
      var start = now - (4 + i * 3 + rint(0, 3)) * HOUR - rint(0, 50) * MIN;
      var s = newSession(p, start);
      var feed = [];
      var t = start;
      var nRuns = rint(1, 3);
      for (var r = 0; r < nRuns; r++) {
        var dur = rint(6, 45) * MIN;
        mkRun(p, s, t, dur, pick(p.prompts), 'ok', feed);
        t += dur + rint(2, 15) * MIN;
      }
      s.firstPrompt = s.runs[0].p;
      s.lastPrompt = s.runs[s.runs.length - 1].p;
      s.aiTitle = s.firstPrompt.length > 60 ? s.firstPrompt.slice(0, 58) + '…' : s.firstPrompt;
      s.todos = s.runs.map(function (run, k) { return { c: run.p, s: 'completed', t0: run.t, t1: run.e, done: run.e }; });
      finishSession(s, feed);
    });

    // ── escenario en vivo
    var actors = [];
    LIVE.forEach(function (L) {
      var p = byPath(L.path);
      var start = now - L.startedMin * MIN;
      var s = newSession(p, start);
      s.entrypoint = 'claude-desktop';
      s.model = 'claude-opus-5-5';
      s.models = { 'claude-opus-5-5': 1 };
      var feed = [];
      var end = L.endedMin ? now - L.endedMin * MIN : now - 4000;
      var runSt = L.status === 'idle' ? 'ok' : 'run';
      var run = mkRun(p, s, start, end - start, L.prompt, runSt, feed);
      if (runSt === 'run') { run.e = now - 3000; run.res = null; }
      s.aiTitle = L.title;
      s.firstPrompt = s.lastPrompt = L.prompt;
      // tareas (sistema nuevo: TaskCreate/TaskUpdate + ~/.claude/tasks)
      var list = { id: s.id, tasks: {}, mtime: now - 20000, archived: false };
      L.tasks.forEach(function (td, i) {
        var id = String(i + 1);
        var t0 = start + (i + 1) * 45000;
        var tc = td[2] === 'completed' ? start + Math.round(((i + 1) / (L.tasks.length + 1)) * (end - start)) : null;
        s.tasks[id] = { id: id, sub: td[0], af: td[1], st: td[2], t0: t0, t1: tc || now - rint(10, 200) * 1000, ts: td[2] !== 'pending' ? t0 + 60000 : undefined, tc: tc || undefined };
        list.tasks[id] = { id: id, subject: td[0], description: '', activeForm: td[1], status: td[2], blocks: [], blockedBy: td[3] || [], owner: null, mtime: tc || now - 30000 };
        if (tc) feed.push({ t: tc, k: 'task', x: 'Tarea #' + id + ' → completada · ' + td[0] });
      });
      if (L.tasks.length) taskLists[s.id] = list;
      if (L.plan) {
        var pt = start + 3 * MIN;
        s.plans.push({ id: uuid(), t: pt, t1: L.planStatus === 'pending' ? pt : pt + 90000, title: C.planTitle(L.plan), md: L.plan, st: L.planStatus });
        feed.push({ t: pt, k: 'plan', x: 'Plan propuesto: ' + C.planTitle(L.plan) });
        if (L.planStatus === 'approved') feed.push({ t: pt + 90000, k: 'plan', x: 'Plan aprobado: ' + C.planTitle(L.plan) });
        if (L.planStatus === 'rejected') feed.push({ t: pt + 90000, k: 'plan', x: (L.planNote || 'Plan rechazado') });
      }
      if (L.subagents) {
        s.counts.subagents += 2;
        feed.push({ t: now - 70000, k: 'tool', x: 'Agente [general-purpose] Leer notas de versión de Postgres 17' });
        feed.push({ t: now - 52000, k: 'tool', x: '$ curl -s https://www.postgresql.org/docs/release/17.2/', sub: 1 });
        feed.push({ t: now - 30000, k: 'tool', x: 'Escribe docs/actualizacion-2026-09.md', sub: 1 });
      }
      if (L.pr) { s.prs.push({ n: L.pr.n, url: L.pr.url, repo: L.pr.repo, t: end - 60000 }); feed.push({ t: end - 60000, k: 'pr', x: 'PR #' + L.pr.n + ' · ' + L.pr.repo }); }
      if (L.status === 'waiting') feed.push({ t: now - 20000, k: 'plan', x: 'Plan propuesto: ' + C.planTitle(L.plan) });
      finishSession(s, feed);
      if (L.status !== 'idle') s.updatedAt = now - 2500;
      live[s.id] = {
        pid: pidSeq++, sid: s.id, cwd: p.path, status: L.status, waitingFor: L.waitingFor || null,
        name: C.baseName(p.path), entrypoint: 'claude-desktop', kind: 'interactive', version: '2.1.283',
        startedAt: start, updatedAt: now - 1000, statusAt: now - (L.status === 'waiting' ? 20000 : 5000), verified: true, via: 'registry'
      };
      actors.push({ sid: s.id, p: p, L: L, waitUntil: L.status === 'waiting' ? now + (L.approveAfter || 16000) : 0, idleUntil: 0, cycle: 0 });
    });

    // Un plan suelto en ~/.claude/plans que aún no se vinculó a ninguna sesión.
    plans['curso-modulo-5.md'] = {
      name: 'curso-modulo-5.md',
      title: 'Plan: módulo 5 del curso de Python',
      md: '# Plan: módulo 5 del curso de Python\n\n- [ ] Lección 1: funciones como valores\n- [ ] Lección 2: comprensiones de listas\n- [ ] Lección 3: generadores\n- [ ] 10 ejercicios con tests',
      mtime: now - 2 * DAY, size: 180, archived: false
    };

    function publicAll() {
      var out = {};
      for (var id in sessions) out[id] = C.publicSession(sessions[id]);
      return out;
    }

    var snapshot = {
      source: 'demo',
      version: C.VERSION,
      generatedAt: now,
      ready: true,
      sessions: publicAll(),
      taskLists: taskLists,
      plans: plans,
      live: live,
      meta: { files: Object.keys(sessions).length, sessions: Object.keys(sessions).length, lines: 184223, bytes: 912400000, scans: 1, fullScans: 1, lastScan: now, lastFull: now }
    };

    // ── simulación
    var rnd = Math.random;
    function pushFeed(s, ev) {
      s.feed.push(ev);
      if (s.feed.length > 40) s.feed.splice(0, s.feed.length - 40);
      s.last = ev;
      s.updatedAt = ev.t;
      s.fileMtime = ev.t;
    }

    function tick(t) {
      t = t || Date.now();
      var changed = {};
      var lists = {};
      var liveChanged = false;
      actors.forEach(function (a) {
        var s = sessions[a.sid];
        var L = live[a.sid];
        var run = s.runs[s.runs.length - 1];
        var list = taskLists[a.sid];
        if (L.status === 'busy') {
          if (rnd() < 0.8) {
            var ev = toolEvent(a.p, t, a.L.subagents && rnd() < 0.4);
            pushFeed(s, { t: ev.t, k: ev.k, x: ev.x, sub: ev.sub });
            s.counts.tools++;
            s.tools[ev.name] = (s.tools[ev.name] || 0) + 1;
            run.tools++;
            var tk = Math.round(18000 + rnd() * 50000);
            var act = s.act[String(Math.floor(t / HOUR))] || (s.act[String(Math.floor(t / HOUR))] = [0, 0]);
            act[0]++;
            act[1] += tk;
            run.tk += tk;
            run.out += Math.round(tk * 0.02);
            s.tokens.cr += Math.round(tk * 0.86);
            s.tokens.out += Math.round(tk * 0.02);
            s.tokens.cw += tk - Math.round(tk * 0.86) - Math.round(tk * 0.02);
            addUse(s, t, 0, 0, Math.round(tk * 0.02), Math.round(tk * 0.86), tk - Math.round(tk * 0.86) - Math.round(tk * 0.02));
            if (ev.name === 'Edit' || ev.name === 'Write') {
              run.ed++;
              s.counts.edits++;
              if (ev.file && run.files.indexOf(ev.file) < 0) run.files.push(ev.file);
            }
            if (ev.name === 'Bash') { run.bash++; s.counts.bash++; }
            run.e = t;
            s.tail = 'tool';
            changed[a.sid] = 1;
          }
          if (list && rnd() < 0.09) {
            var ids = Object.keys(list.tasks).sort(function (x, y) { return +x - +y; });
            var cur = ids.filter(function (id) { return list.tasks[id].status === 'in_progress'; })[0];
            if (cur) {
              list.tasks[cur].status = 'completed';
              list.tasks[cur].mtime = t;
              s.tasks[cur].st = 'completed';
              s.tasks[cur].tc = t;
              s.tasks[cur].t1 = t;
              pushFeed(s, { t: t, k: 'task', x: 'Tarea #' + cur + ' → completada · ' + list.tasks[cur].subject });
              var next = ids.filter(function (id) { return list.tasks[id].status === 'pending'; })[0];
              if (next) {
                list.tasks[next].status = 'in_progress';
                list.tasks[next].mtime = t;
                s.tasks[next].st = 'in_progress';
                s.tasks[next].ts = t;
                s.tasks[next].t1 = t;
              } else {
                run.st = 'ok';
                run.res = pick(a.p.results);
                pushFeed(s, { t: t + 1, k: 'text', x: run.res });
                s.tail = 'text';
                L.status = 'idle';
                L.statusAt = t;
                a.idleUntil = t + 30000 + rnd() * 20000;
                liveChanged = true;
              }
              list.mtime = t;
              lists[a.sid] = 1;
              changed[a.sid] = 1;
            }
          }
          if (L.status === 'busy' && a.L.waitChance && rnd() < a.L.waitChance) {
            L.status = 'waiting';
            L.waitingFor = pick(a.L.waitReasons);
            L.statusAt = t;
            a.waitUntil = t + 9000 + rnd() * 9000;
            liveChanged = true;
          }
        } else if (L.status === 'waiting') {
          if (t > a.waitUntil) {
            L.status = 'busy';
            L.waitingFor = null;
            L.statusAt = t;
            liveChanged = true;
            var plan = s.plans[s.plans.length - 1];
            if (plan && plan.st === 'pending') {
              plan.st = 'approved';
              plan.t1 = t;
              pushFeed(s, { t: t, k: 'plan', x: 'Plan aprobado: ' + plan.title });
              if (a.L.nextTasks) {
                var nl = { id: a.sid, tasks: {}, mtime: t, archived: false };
                a.L.nextTasks.forEach(function (td, i) {
                  var id = String(i + 1);
                  nl.tasks[id] = { id: id, subject: td[0], description: '', activeForm: td[1], status: td[2], blocks: [], blockedBy: [], owner: null, mtime: t };
                  s.tasks[id] = { id: id, sub: td[0], af: td[1], st: td[2], t0: t, t1: t, ts: td[2] === 'in_progress' ? t : undefined };
                });
                taskLists[a.sid] = nl;
                lists[a.sid] = 1;
              }
            } else {
              pushFeed(s, { t: t, k: 'tool', x: 'Permiso concedido: continúa el trabajo' });
            }
            changed[a.sid] = 1;
          }
        } else if (L.status === 'idle' && a.idleUntil && t > a.idleUntil && a.L.status !== 'idle') {
          // Nueva tanda: otro prompt sobre el mismo proyecto.
          a.cycle++;
          var prompt = a.p.prompts[a.cycle % a.p.prompts.length];
          var nr = { id: 'sim-' + a.cycle + '-' + a.sid.slice(0, 4), t: t, e: t, p: prompt, src: 'human', st: 'run', tools: 0, ed: 0, bash: 0, err: 0, sub: 0, msgs: 1, out: 0, tk: 0, files: [], res: null };
          s.runs.push(nr);
          s.counts.prompts++;
          s.lastPrompt = prompt;
          pushFeed(s, { t: t, k: 'prompt', x: '» ' + prompt });
          if (list) {
            var ids2 = Object.keys(list.tasks);
            ids2.forEach(function (id, i) {
              var st = i === 0 ? 'in_progress' : 'pending';
              list.tasks[id].status = st;
              list.tasks[id].mtime = t;
              s.tasks[id].st = st;
              s.tasks[id].t1 = t;
              delete s.tasks[id].tc;
            });
            list.mtime = t;
            lists[a.sid] = 1;
          }
          L.status = 'busy';
          L.statusAt = t;
          a.idleUntil = 0;
          liveChanged = true;
          changed[a.sid] = 1;
        }
      });
      var delta = { sessions: {}, taskLists: {}, plans: {}, live: liveChanged ? live : null };
      var any = liveChanged;
      for (var id in changed) { delta.sessions[id] = C.publicSession(sessions[id]); any = true; }
      for (var lid in lists) { delta.taskLists[lid] = taskLists[lid]; any = true; }
      if (liveChanged) {
        // el registro vivo se reemplaza entero: pasamos una copia
        delta.live = JSON.parse(JSON.stringify(live));
      }
      return any ? delta : null;
    }

    return { snapshot: snapshot, tick: tick };
  }

  root.NexusDemo = { create: create, PROJECTS: PROJECTS };
})(typeof self !== 'undefined' ? self : this);
