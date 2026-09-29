# NOTAS DE CONTEXTO · NEXUS

> Este archivo existe para que cualquier persona, cuenta de Claude u otra IA pueda retomar
> el proyecto sin perder el hilo. **Léelo entero antes de tocar código y actualízalo al
> terminar cada sesión de trabajo** (sección "Bitácora" al final).

- Repositorio: `lean19r-cell/Nexus` (antes se llamó `Experimentos`; algunos textos aún lo mencionan).
- Idioma: **todo en español** (código comentado, UI, docs, commits y explicaciones al usuario).
- Última actualización de este archivo: 2026-09-29.

## 1. Qué es NEXUS

Panel cyberpunk (negro y azul) para seguir **todo lo que Claude Code hace en los proyectos
del usuario**: sesiones en vivo, tareas, tandas, planes; tanto de desarrollo como de los
vídeos de su canal de YouTube. Es una app local + una skill `/nexus` para Claude Code.

Idea central: **no pedirle a Claude que reporte nada**. Claude Code ya escribe todo en
`~/.claude`; NEXUS solo **lee** esos archivos. Cero tokens, cero fricción, tiempo real,
privado (el servidor solo escucha en `127.0.0.1:2077`).

## 2. Estado actual (2026-09-29)

- Versión `1.0.0` (`web/js/core.js` → `VERSION`; `package.json`).
- `main` está en `7a0bbd4` (PR #2 fusionado). El trabajo nuevo va en la rama
  `claude/lucid-maxwell-jin1x7` (sin PR abierto todavía; el usuario no lo ha pedido).
- **30 pruebas, todas en verde** (`cd nexus && npm test`, ~1 s).
- **Sin dependencias** (solo Node ≥ 18 y el navegador). Mantener así.
- Funcionalidad ya hecha: 8 vistas (Mando, Proyectos, Tareas, Planes, Tandas, Sesiones,
  Consumo, Ajustes), servidor con escaneo incremental + caché + SSE, hooks opcionales, CLI
  completo, skill `/nexus`, modo navegador sin Node (File System Access API), demo con datos
  vivos, build a HTML único, acceso directo de escritorio (Mac/Windows/Linux), iconos, vista móvil.
- **Añadido el 2026-09-29:** vista y comando **Consumo** (tokens y coste estimado por día,
  proyecto y modelo, precios editables en Ajustes) y **avisos con sonido** al terminar una
  tanda o una tarea (ver bitácora).

## 3. Mapa del código (`nexus/`)

| Archivo | Responsabilidad |
|---|---|
| `web/js/core.js` | **Isomórfico** (se carga con `<script>` en el navegador y con `require()` en Node). Parser de transcripciones `.jsonl`, `Collector` (lectura incremental) y `buildModel` (agregador que produce el modelo que pinta la UI). Aquí vive casi toda la lógica. |
| `web/js/app.js` | Interfaz (vistas, filtros, atajos, notificaciones). |
| `web/js/fs-browser.js` | Adaptador de "Conectar carpeta" (File System Access API, solo Chrome/Edge). |
| `web/js/demo.js` | Generador de datos de ejemplo vivos (`nexus demo`). |
| `web/css/nexus.css` | Tema cyberpunk. |
| `server.mjs` | Servidor HTTP: `Store` (caché en `~/.claude-nexus/cache`), escaneo periódico, SSE. |
| `bin/nexus.mjs` | CLI (`open`, `start`, `stop`, `status`, `tasks`, `projects`, `tag`, `install`, `uninstall`, `hooks`, `shortcut`, `doctor`, `demo`). |
| `hooks/emit.mjs` | Hook de Claude Code que avisa al servidor (silencioso, < 150 ms). |
| `lib/node-fs.mjs` | Adaptador de sistema de archivos de Node para el `Collector`; resuelve `~/.claude` (respeta `CLAUDE_CONFIG_DIR`) y `NEXUS_HOME`. |
| `lib/install.mjs` | Instala/desinstala la skill y los hooks (`~/.claude/settings.json`, con copia de seguridad). |
| `lib/shortcut.mjs` | Acceso directo de escritorio por plataforma. |
| `tools/build-standalone.mjs` | Genera `dist/nexus.html` (todo en línea). `dist/` está en `.gitignore`. |
| `tools/build-icons.mjs` | Regenera `.icns/.ico/.png` desde `assets/icon.svg`. |
| `test/*.test.mjs` | `node --test`. `helpers.mjs` fabrica transcripciones sintéticas con la forma real de Claude Code 2.1.x y un FS en memoria. `cli.test.mjs` ejecuta el CLI real contra carpetas temporales. |

Piezas del **consumo** (todas en `web/js/core.js`): `bumpUse` guarda por sesión `use`
(`"<hora UTC>|<modelo>" → [in, out, cacheRead, cacheWrite]`); `buildModel` lo agrupa por día
local, proyecto y modelo en `model.usage` (`buildUsage`); `aggregateUsage(usage, {from, to,
project, projects, model})` suma y calcula el coste (lo usan la vista y `nexus usage`);
`PRICES`/`priceFor`/`normModel`/`modelName` son la tabla de precios y utilidades.
Los **avisos** viven en `web/js/app.js` (`transitions`, `alertUser`, `playSound`).
| `SKILL.md` | La skill `/nexus` (qué comando ejecutar según la petición). |

### API del servidor (`127.0.0.1:2077`)

`GET /api/health` · `GET /api/snapshot` · `GET /api/model` · `GET /api/stream` (SSE) ·
`GET /api/config` · `POST /api/config` · `POST /api/hook` · `POST /api/rescan`.
Todo lo demás (GET) sirve estáticos desde `web/`.

### Rutas que lee de `~/.claude`

`projects/<dir>/<sesión>.jsonl` (+ `subagents/agent-*.jsonl`), `tasks/<lista>/<id>.json`,
`plans/*.md`, `sessions/<pid>.json`. Su propio estado va en `~/.claude-nexus`
(caché, config, registro). **Solo escribe** `settings.json` (hooks, con backup),
`skills/nexus` (skill) y el acceso directo.

## 4. Decisiones de diseño (no las cambies sin hablarlo con el usuario)

1. **Leer, no reportar.** Nada de pedir a Claude que escriba estados; se deduce de `~/.claude`.
2. **Sin dependencias ni build step.** Node + navegador puros; `core.js` compartido.
3. **Privado y local.** Solo `127.0.0.1`; nada sale del ordenador.
4. **Historial propio.** Claude Code borra transcripciones a los 30 días; NEXUS guarda el
   resumen por sesión en `~/.claude-nexus` para no perderlo.
5. **Tolerante al formato.** El formato de `~/.claude` no es API pública: las líneas que no
   entiende se ignoran sin romper. `STATE_VERSION` (en `core.js`) invalida la caché si cambia
   el modelo guardado.
6. **Tareas "abandonadas".** Tareas abiertas de sesiones cerradas hace días no cuentan como
   pendientes (no inflan contadores).
7. **Categorías y etapas por proyecto:** vídeo (Idea → Guion → Grabación → Edición → Miniatura
   → Publicado), desarrollo (Planificación → Desarrollo → Pruebas → Deploy → Mantenimiento),
   contenido, investigación, ops, otros. Detección automática por nombre de carpeta / uso de
   `ffmpeg`, `whisper`, `yt-dlp`; editable por el usuario.

8. **No subir `STATE_VERSION` para añadir campos.** `importState` descarta las sesiones
   cacheadas de otra versión, y las que ya no tienen transcripción (Claude Code las borra a los
   30 días) perderían su historial. En su lugar el campo nuevo es opcional y se rellena de forma
   perezosa: `_checkTranscript` relee una sesión sin `use` solo si su transcripción principal
   aún existe; si no, se conserva tal cual y `buildModel` usa su total como respaldo
   (`usage.legacy` cuenta cuántas). Solo subir `STATE_VERSION` si el formato cambia de forma
   incompatible.
9. **El coste es una estimación.** Precios de lista de la API (tabla `PRICES`, fecha en
   `PRICES_CHECKED`, tomados de la lista de modelos de la skill `claude-api` el 2026-09-25);
   la caché escrita se calcula a 1,25× la entrada (caché de 5 min). El usuario los puede
   corregir en Ajustes (`config.prices`, validados por `cleanPrices`); un modelo sin precio
   muestra solo tokens. Al cambiar precios de lista, actualizar `PRICES` **y** `PRICES_CHECKED`.
10. **Los atajos numéricos siguen el orden del menú lateral** (`.rail .nav`), no un mapa fijo:
    añadir una sección en `index.html` no obliga a renumerar nada.
11. **Avisos:** un mismo repaso puede terminar varias cosas; hasta 3 se avisan por separado y a
    partir de ahí en resumen, y suena un único tono (prioridad: te espera > error > tanda >
    tarea). No se avisa en la carga inicial ni al cambiar de fuente de datos (`S.primed`).

## 5. Cómo trabajar en el proyecto

```bash
cd nexus
npm test                                  # 22 pruebas
node bin/nexus.mjs demo                   # panel con datos de ejemplo
node bin/nexus.mjs open                   # panel con datos reales
node tools/build-standalone.mjs           # dist/nexus.html
```

- Si añades lógica al parser/agregador, **añade la prueba** en `test/core.test.mjs`
  (usa los helpers de `test/helpers.mjs`).
- Si cambias la forma de lo que se guarda en caché, sube `STATE_VERSION`.
- La UI vive en `web/`; el mismo `core.js` debe seguir funcionando en Node y en navegador.
- Capturas de la documentación: `nexus/docs/*.jpg` (se generan a mano con el modo demo).

## 6. Límites conocidos

- Solo ve sesiones **locales**. Las sesiones en la nube de claude.ai/code no escriben en
  `~/.claude` del usuario (por eso NEXUS no las ve).
- Modo carpeta del navegador: solo Chrome/Edge.
- Depende del formato interno de `~/.claude` (puede cambiar con versiones de Claude Code).

## 7. Detalles a corregir / cabos sueltos

- Falta una captura `nexus/docs/consumo.jpg` para el README: en el entorno de la nube no cargan
  las fuentes de Google y saldría con otra tipografía. Hacerla en local (`nexus demo`, vista
  Consumo, 1440×900) y enlazarla en la tabla de vistas.
- Los avisos y los tonos solo se han probado en Chromium con un `AudioContext` simulado; falta
  oírlos en un navegador real.

- `README.md` (raíz) tiene el título `# Experimentos` y `nexus/README.md` clona
  `.../Experimentos.git`; el repositorio ahora se llama **Nexus**. Pendiente de confirmar con
  el usuario si se renombra todo.
- Origen del código: la rama `claude/task-tracking-cyberpunk-app-i3pwaj` (ya fusionada vía
  PR #1 y #2). No hace falta seguir usándola.

## 8. Ideas para seguir (sin decidir; el usuario elige el rumbo)

El usuario eligió el 2026-09-29 (por este orden de riesgo):

1. ✅ **Coste y tokens** — hecho (vista Consumo + `nexus usage`).
2. ⏳ **Seguimiento de tandas y tareas** — vista unificada con pendientes, activas, esperándote,
   completadas y con problemas. Petición nueva del usuario a mitad de sesión.
3. ⏳ **Flujo de vídeos del canal** — checklist por etapa, fecha objetivo y pipeline; requiere
   guardar estado nuevo por proyecto vídeo en `config.projects[...]`.
4. ✅ **Avisos con sonido** al terminar tandas y tareas — hecho.
5. ❌ **Sesiones en la nube (claude.ai/code)** — **descartado por el usuario** ("déjalo").
   No investigar salvo que lo pida de nuevo.

## 9. Bitácora de sesiones

Formato: fecha · quién/qué herramienta · qué se hizo · qué queda.

- **2026-09-27** · Claude Code (web) · Construcción inicial de NEXUS (PR #1 y #2): parser,
  colector, servidor, 7 vistas, CLI, skill, hooks, modo navegador, demo, acceso directo de
  escritorio. 22 pruebas verdes.
- **2026-09-29** · Claude Code (web, rama `claude/lucid-maxwell-jin1x7`) · El usuario quiere
  seguir desarrollando NEXUS. Se revisó el estado (todo al día, pruebas verdes) y se
  crearon estas notas (`NOTAS.md`) y `CLAUDE.md`.
- **2026-09-29 (misma sesión, después)** · Claude Code (web) · El usuario eligió rumbo (ver §8).
  Hecho: (a) **Consumo**: colector guarda tokens por hora y modelo (`use`), `buildModel` produce
  `usage`, vista Consumo (KPIs, barras diarias/semanales, tablas por proyecto y modelo),
  editor de precios en Ajustes, `nexus usage [--days --todo --project --json]`, demo con datos
  de consumo, pruebas de parser/colector/modelo/CLI; (b) **avisos con sonido** de tandas y
  tareas terminadas con 4 tonos, ajustes propios y botones de prueba; (c) atajos numéricos
  derivados del menú. Verificado con Playwright (capturas de escritorio y móvil, edición de
  precio, avisos reales de la demo) y con datos reales de esta sesión (`nexus usage` → Sonnet
  5.5, 15,2M tokens, ≈$4,86). El usuario descartó las sesiones en la nube. Pendiente: seguimiento
  unificado de tandas y tareas, y flujo de vídeos.
