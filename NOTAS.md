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
- `main` y la rama de trabajo apuntan al mismo commit (`7a0bbd4`, PR #2 fusionado).
- **22 pruebas, todas en verde** (`cd nexus && npm test`, ~1 s).
- **Sin dependencias** (solo Node ≥ 18 y el navegador). Mantener así.
- Funcionalidad ya hecha: 7 vistas (Mando, Proyectos, Tareas, Planes, Tandas, Sesiones,
  Ajustes), servidor con escaneo incremental + caché + SSE, hooks opcionales, CLI completo,
  skill `/nexus`, modo navegador sin Node (File System Access API), demo con datos vivos,
  build a HTML único, acceso directo de escritorio (Mac/Windows/Linux), iconos, vista móvil.

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
| `test/*.test.mjs` | `node --test`. `helpers.mjs` fabrica transcripciones sintéticas con la forma real de Claude Code 2.1.x y un FS en memoria. |
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

- `README.md` (raíz) tiene el título `# Experimentos` y `nexus/README.md` clona
  `.../Experimentos.git`; el repositorio ahora se llama **Nexus**. Pendiente de confirmar con
  el usuario si se renombra todo.
- Origen del código: la rama `claude/task-tracking-cyberpunk-app-i3pwaj` (ya fusionada vía
  PR #1 y #2). No hace falta seguir usándola.

## 8. Ideas para seguir (sin decidir; el usuario elige el rumbo)

_Sin backlog priorizado todavía. Cuando el usuario decida una dirección, anótala aquí y
pásala a "Bitácora" al empezar._

## 9. Bitácora de sesiones

Formato: fecha · quién/qué herramienta · qué se hizo · qué queda.

- **2026-09-27** · Claude Code (web) · Construcción inicial de NEXUS (PR #1 y #2): parser,
  colector, servidor, 7 vistas, CLI, skill, hooks, modo navegador, demo, acceso directo de
  escritorio. 22 pruebas verdes.
- **2026-09-29** · Claude Code (web, rama `claude/lucid-maxwell-jin1x7`) · El usuario quiere
  seguir desarrollando NEXUS. Se revisó el estado (todo al día, pruebas verdes) y se
  crearon estas notas (`NOTAS.md`) y `CLAUDE.md`. Falta: decidir la próxima funcionalidad.
