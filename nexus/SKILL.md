---
name: nexus
description: NEXUS, el centro de mando para seguir todo lo que Claude Code hace en los proyectos del usuario (desarrollo, vídeos del canal, contenido…) con un panel cyberpunk local. Úsala cuando el usuario pida abrir el panel, dashboard, "mission control" o "centro de mando"; pregunte qué sesiones están trabajando o le esperan, qué tareas, tandas o planes hay pendientes, qué hizo Claude hoy o en un proyecto, cuántos tokens o cuánto coste estimado llevan los proyectos; o quiera clasificar un proyecto (por ejemplo como vídeo del canal) o fijar su etapa (Guion, Edición, Publicado, Deploy…).
---

# NEXUS · centro de mando de Claude Code

NEXUS lee en local lo que Claude Code ya guarda en `~/.claude` (transcripciones, tareas, planes y el registro de sesiones vivas) y lo muestra en un panel web en `http://127.0.0.1:2077`. No envía tus datos fuera del ordenador (solo consulta GitHub para buscar actualizaciones) y no gasta tokens: no hace falta "reportar" nada, basta con leer.

Todo se maneja con el CLI que acompaña a esta skill. Su ruta es `bin/nexus.mjs` dentro del directorio base de esta skill (el que aparece como "Base directory for this skill"). En los ejemplos, `NEXUS` significa `node "<directorio base>/bin/nexus.mjs"`. Requiere Node 18 o superior.

## Qué hacer según lo que pida el usuario

| Petición | Comando |
|---|---|
| Abrir el panel / dashboard | `NEXUS open` y dale la URL que imprime |
| "¿Qué está pasando?", "¿qué tengo pendiente?", resumen general | `NEXUS status` y resume en 3–6 líneas |
| Estado de un proyecto concreto | `NEXUS status --project <nombre>` |
| Lista completa de tareas abiertas | `NEXUS tasks` (añade `--project <nombre>` para filtrar) |
| Lista de proyectos, categorías y etapas | `NEXUS projects` |
| "¿Cuántos tokens he gastado?", coste por proyecto, modelo o día | `NEXUS usage` (`--days 7`, `--todo`, `--project <nombre>`; `--json` para procesarlo) |
| Marcar el proyecto actual como vídeo, desarrollo, etc. | `NEXUS tag video` (categorías: dev, video, contenido, investigacion, ops, otros) |
| Fijar la etapa del proyecto actual | `NEXUS tag video --etapa Edición` (o solo `--etapa Deploy`) |
| Renombrar cómo se ve el proyecto | `NEXUS tag --nombre "Episodio 48"` |
| Fijar la fecha objetivo (p. ej. de publicación de un vídeo) | `NEXUS tag --fecha 2026-10-05` (`--fecha ninguna` la quita). Se ve en la vista **Canal** del panel, junto a la lista de comprobación de cada etapa |
| Crear un acceso directo en el escritorio (abrir el panel con doble clic) | `NEXUS shortcut` |
| Quitar el acceso directo | `NEXUS shortcut --remove` |
| Ver la demo | `NEXUS demo` |
| Parar el servidor | `NEXUS stop` |
| «¿Hay una versión nueva de NEXUS?», actualizarlo | `NEXUS update --check` para mirar y `NEXUS update --restart` para instalar y reiniciar el servidor (sin git). Avisa después de reiniciar Claude Code o Claude Desktop para que cargue la skill nueva. También hay un botón en Ajustes → Actualizaciones del panel |
| Reiniciar el servidor de NEXUS | `NEXUS restart` |
| Problemas o dudas de instalación | `NEXUS doctor` |

Para procesar los datos tú mismo (por ejemplo, para planificar el día), usa `--json` en `status`, `tasks` o `projects`.

`tag` actúa sobre la carpeta actual; para otra carpeta añade `--proyecto <ruta>`.

## Cómo responder

- Empieza por lo que necesita al usuario: sesiones que **le esperan** (permiso, pregunta o plan por aprobar) y **planes pendientes de aprobación**.
- Luego lo que está en marcha (proyecto → qué está haciendo) y las tareas abiertas más relevantes. No pegues la salida completa del comando: resúmela.
- Si `status` dice que el servidor no está en marcha, los datos siguen siendo válidos (se leen directamente de `~/.claude`). Ofrece `NEXUS open` si quiere el panel en vivo.
- Las tareas "abandonadas" son tareas abiertas de sesiones cerradas hace días; no las cuentes como pendientes salvo que el usuario pregunte por ellas (`NEXUS tasks --all`).
- El coste de `NEXUS usage` es una **estimación** a precios de lista de la API (no lo presentes como una factura): con una suscripción Pro/Max no se paga por token. Si aparecen tokens "sin precio", di que el modelo no tiene precio configurado (se añade en Ajustes del panel).

## Avisos instantáneos (opcional)

Sin hooks, el panel se actualiza en uno o dos segundos. Con hooks, cada evento de Claude Code avisa al panel al momento y puede arrancar el servidor solo. Instálalos **solo si el usuario lo pide**, porque modifica `~/.claude/settings.json` (se guarda una copia de seguridad):

```
NEXUS install --hooks            # avisos al instante
NEXUS install --hooks --autostart  # además, arranca NEXUS al abrir cualquier sesión
NEXUS hooks --remove             # quitarlos
```
