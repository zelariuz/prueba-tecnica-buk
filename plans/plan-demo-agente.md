# Plan: Demo agente (mini back y front en WSL)

> PRD de origen: `prds/prd-demo-agente.md` (2026-09-09). Tres fases aprobadas
> por el usuario el 09-09; ejecución completa autorizada ("te dejo trabajar").

## Decisiones arquitectónicas

Decisiones duraderas que aplican a todas las fases:

- **Ubicación**: `demo-agente/` dentro del repo, con `package.json`, tests y
  README propios. No importa nada de `src/` en tiempo de ejecución; habla con
  la capa solo por HTTP. `npm test` de la raíz no cambia.
- **Rutas del mini back** (todo GET, HTML del servidor, sin JavaScript):
  - `GET /` — formulario y, si hay parámetros, el rastro de llamadas.
    Parámetros: `pregunta` (id de la preparada), `texto` (editable, opcional;
    por defecto el de la preparada), `desde`, `hasta`, `departamento`
    (opcional), `agente` (`1`/ausente).
  - `GET /agente/sesion` — prompt de creación completo y datos de la sesión.
- **Modelo de datos del rastro**: lista ordenada de saltos
  `{ destino, via, token, enviado, recibido, ms, estado }`. `token` es el
  nombre (`interno` | `agente`), nunca el valor. `estado` ∈ `ok` | `rechazo`
  | `fallo`. Es lo que devuelve el seam y lo que dibuja la página.
- **Seams** (los únicos con tests):
  1. `ejecutar(peticion, { agente, capa, reloj })` → `rastro`.
  2. `asegurarSesion({ claude, catalogo, estado })` →
     `{ id, creada, motivo, version, huella }`.
  Fuera de tests: `render(rastro)` a HTML, adaptador real de `claude`
  (`spawn`), adaptador real de la capa (`fetch`).
- **Contratos de la capa** (verificados 09-09): catálogo
  `{ version, granularities, entities, queries }`; dry-run interno
  `{ params, plan, sql }`; consulta `{ rows, meta }`; error
  `{ code, member?, suggestion }`.
- **Configuración por `.env`** (con `.env.example`): `CAPA_URL`,
  `TOKEN_AGENTE`, `TOKEN_INTERNO`, `SESION_NOMBRE`, `MODELO`,
  `AGENTE_TIMEOUT_MS`, `PUERTO`. El uuid de la sesión no es configuración: es un
  uuid aleatorio persistido en `.sesion.json` junto a la versión y la huella del
  catálogo con el que se creó la sesión.
- **Preguntas preparadas** en un JSON propio: `{ id, titulo, texto, consulta,
  filtros }`, con marcadores `:desde`, `:hasta`, `:departamento` en `consulta`
  y en `texto`. Siete: las 3 del caso, las otras 3 consultas tipo, la trampa.
- **Agente**: sesión nombrada de Claude Code (`claude -p -n <nombre>
  --session-id <uuid>` para crear; `claude -p --resume <uuid>
  --output-format json` por clic), sin herramientas y sin configuración
  global; modelo `claude-sonnet-5`; un solo reintento; salida solo JSON o
  `{"noPuedo": "motivo"}`.
- **Runner**: `node:test`; `cd demo-agente && npm test` sin Postgres, Docker
  ni Claude Code.

---

## Fase 1: Camino sin agente, de punta a punta

**Historias de usuario**: 1, 3, 5, 6, 7, 8, 9, 10 (camino sin agente), 18,
21, 22, 23, 24, 25, 27, 28 (parte de la capa)
**Bloqueada por**: Ninguna — puede empezar de inmediato

### Qué construir

La carpeta `demo-agente/` con su infraestructura de tests, el seam `ejecutar`
para el camino sin agente, el servidor GET y la página. La persona abre
`http://localhost:3100/`, elige una pregunta preparada, ajusta `desde`,
`hasta` y `departamento`, envía, y ve el rastro con dos saltos: dry-run con
token interno (params, plan, SQL) y consulta con token `agente` (filas y
meta), cada uno con enviado, recibido y tiempo. La trampa produce un salto
de rechazo con `UNKNOWN_MEMBER` y su sugerencia. Recargar la URL muestra
`cache-l1`. El arranque falla con mensaje claro si la capa no responde.

### Criterios de aceptación

- [x] `cd demo-agente && npm test` corre en verde sin Postgres, Docker ni
      Claude Code. **39 tests, 0 fail** (09-09).
- [x] Por el seam `ejecutar` con una capa falsa: el camino sin agente
      produce exactamente los saltos 2 y 3; los marcadores se sustituyen;
      `departamento` vacío elimina el filtro; un rechazo de la capa queda
      como salto con `estado: rechazo` y el error en `recibido`; los tiempos
      salen del reloj inyectado. `demo-agente/test/ejecutar.test.js`.
- [x] Contra la capa real en Docker: las 7 preguntas responden; las 3 del
      caso dan las filas del seed validadas en M1; la trampa da
      `UNKNOWN_MEMBER`; F5 da `cache-l1`. QA del 09-09 en
      `demo-agente/docs/qa.md`.
- [x] Sin capa: `npm start` termina con un mensaje que dice qué levantar.
      Comprobado el 09-09 con `CAPA_URL` apuntando a un puerto muerto: el
      proceso muere con código 1 y el comando de `docker compose` a la vista.
- [x] La página muestra el nombre del token por salto y nunca su valor.
      Comprobado el 09-09: ningún valor de token aparece en el HTML servido.

---

## Fase 2: Camino con agente

**Historias de usuario**: 2, 4, 11, 12, 13, 14, 15, 16, 17, 19, 26, 28, 29,
30
**Bloqueada por**: Fase 1

### Qué construir

La casilla "usar agente" y el texto editable. Al arrancar, el mini back lee
el catálogo, y asegura la sesión `agente-buk`: la crea con el prompt de
creación (rol, catálogo, reglas, contrato) si no existe o si la versión del
catálogo cambió. Por clic, el salto 1 manda texto y filtros a `claude -p
--resume` y recibe solo JSON; ese JSON sigue a los saltos 2 y 3. Si la capa
rechaza, el salto 3b reenvía el error con `suggestion` al agente y repite el
salto 3 una sola vez. `noPuedo` corta sin tocar la capa. JSON malformado del
agente es un salto fallido con el texto crudo. Tope de tiempo por llamada.
`/agente/sesion` muestra el prompt completo, nombre, UUID, versión del
catálogo, modelo y versión de Claude Code. Si `claude` no está disponible,
el servidor arranca igual con la casilla deshabilitada y el motivo.

### Criterios de aceptación

- [x] Por el seam `ejecutar` con agente y capa falsos: el camino con agente
      produce los saltos 1, 2 y 3; `noPuedo` produce solo el salto 1; un
      rechazo produce 3b y un segundo salto 3, y un segundo rechazo termina
      ahí (nunca un tercer intento); JSON malformado es salto con `estado:
      fallo` y el texto crudo. `demo-agente/test/ejecutar.test.js`.
- [x] Por el seam `asegurarSesion` con `claude` falso: crea si no existe,
      conserva si la versión coincide, recrea si cambió; el prompt de
      creación contiene el catálogo entero y el contrato de salida.
      **Precisión del 09-09**: lo que se compara ya no es `version` sino la
      **huella** del catálogo público entero (sha256 canónico), porque la
      versión de la capa no cubre las consultas tipo. Hay un test para cada
      caso, incluido "misma versión, otra consulta tipo → recrea".
- [x] Contra la capa real y Claude Code real: las 7 preguntas por el camino
      con agente dan las mismas filas que sin agente (la trampa termina en
      `noPuedo` o en `UNKNOWN_MEMBER` seguido de `noPuedo`); el rastro muestra
      los tiempos del agente en segundos y los de la capa en milisegundos.
      QA del 09-09: 3,2-6,2 s el agente, 2-17 ms la capa.
- [x] `/agente/sesion` muestra el catálogo con la versión actual (y ahora
      también su huella). Comprobado el 09-09 contra la demo corriendo.
- [x] Cada llamada a `claude -p` corre sin herramientas; medido el contexto
      por llamada y anotado en el README (515 tokens de entrada con
      `--tools "" --setting-sources "" --system-prompt`).

---

## Fase 3: Cierre y QA de la demo

**Historias de usuario**: 20, 24, 29
**Bloqueada por**: Fase 2

### Qué construir

README de la demo: requisitos (capa arriba con Docker, Node 24, Claude Code
logueado con crédito del Agent SDK, versión probada), dos comandos para
levantarla, qué muestra cada salto, camino sin agente como respaldo,
medición de costo y contexto. Registro de QA de la demo con las 7 preguntas
por los dos caminos y los números del seed. Enlace desde el README de la
raíz (una línea, sección de demo). `revisa-codigo` sobre todo el diff de la
demo.

**Añadido el 09-09, con el OK del usuario**: la vista pública del catálogo
publica además el `query` de cada consulta tipo (ADR 0008), y el prompt de
creación manda copiarlo. Era el hallazgo de la fase 2: sin ver el `segments` de
la consulta tipo, el agente daba otro número en la pregunta del caso.

### Criterios de aceptación

- [x] Una persona con el repo clonado y Docker arriba levanta la demo con dos
      comandos siguiendo el README, sin leer código. Los dos comandos del
      README se corrieron tal cual el 09-09 y levantaron la demo en :3100.
      No se probó con una persona ajena al repo: eso queda para el QA humano.
- [x] Registro de QA con las 7 preguntas × 2 caminos, todas OK o con su
      hallazgo anotado: `demo-agente/docs/qa.md` (14 corridas, más una segunda
      pasada por combinación para ver la caché).
- [ ] `revisa-codigo` sin hallazgos duros abiertos. **No corrido en esta
      sesión**; queda pendiente sobre el diff completo de la demo.
- [x] `npm test` de la raíz sigue igual; `cd demo-agente && npm test` en
      verde. **Precisión del 09-09**: la raíz pasó de 114 a **115 sin
      variables** (1 skipped) y de 179 a **180 con Docker**, por el test nuevo
      que fija el `query` de las consultas tipo en la vista pública. Ningún
      test existente cambió de resultado y los tres snapshots de SQL siguen
      idénticos.
