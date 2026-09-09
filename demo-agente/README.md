# Demo agente — el rastro de llamadas a la capa semántica

Una página que muestra **lo que viaja** cuando alguien le pregunta algo a la
capa: la consulta declarativa que sale, el plan y el SQL que devuelve el
dry-run interno, y las filas que devuelve la consulta real con el token de
clase `agente`. Cada salto con su token **por nombre** (nunca su valor), su
tiempo y su estado.

Fase 1 (esta): **camino sin agente**. La pregunta preparada se sustituye con
los filtros del formulario y va directo a la capa. La casilla "usar agente"
aparece deshabilitada; el camino con Claude Code llega en la fase 2, y el
README lo completa la fase 3.

## Requisitos

- La capa arriba en Docker (desde la raíz del repo: `docker compose up -d --build`).
- Node 24 (probado en v24.18.0). Sin dependencias: `node:http`, `fetch` nativo.

## Dos comandos

```bash
cp demo-agente/.env.example demo-agente/.env   # ajusta si cambiaste puertos o tokens
cd demo-agente && npm start                    # http://localhost:3100/
```

Si la capa no responde, el arranque muere diciendo exactamente qué levantar.

## Qué muestra

- **Salto 1** — fase 2 (agente). Todavía no aparece.
- **Salto 2** — `POST /analytics/query?dryRun=true` con el token `interno`:
  `params`, `plan` y `sql`. El SQL solo lo recibe una sesión interna.
- **Salto 3** — `POST /analytics/query` con el token `agente`: `rows` y `meta`
  (`servedFrom`, `asOf`, `queryId`, `warnings`).

Cada combinación del formulario es una URL. Recargarla repite la consulta y
`meta.servedFrom` pasa de `live` a `cache-l1`.

Un rechazo de la capa no corta el rastro: el salto queda con estado `rechazo`
y el error (`code`, `member`, `suggestion`) tal cual en "recibido", y la
consulta se intenta igual para ver el mismo error por las dos clases de token.

## Las 7 preguntas preparadas

Viven en `preguntas.json` (datos, no código). Las 3 del caso, las otras 3
consultas tipo del catálogo y la trampa:

| Pregunta | Qué demuestra |
| --- | --- |
| Evaluaciones por departamento y trimestre | El caso, con filtros y segmento |
| Completitud por departamento | Medida derivada (ratio) |
| Asistencia por departamento y mes | Otra entidad, otra dimensión temporal |
| Empleados que completaron por trimestre | La medida trae puesto su segmento |
| Conteo de evaluaciones por estado | La clase `agente` exige rango: la demo se lo agrega |
| Headcount por departamento | **Solo responde con un token de otra clase**: `employees` no tiene dimensión temporal ni camino de joins hacia una, así que no hay rango posible y la consulta termina en `MISSING_TIME_RANGE`. El dry-run interno sí pasa |
| Sueldo promedio por departamento | La trampa: `employees.salary_avg` no existe → `UNKNOWN_MEMBER` con sugerencia |

## Tests

```bash
cd demo-agente && npm test
```

Sin Postgres, sin Docker, sin Claude Code y sin variables de entorno. Entran
por el único seam de comportamiento, `ejecutar(peticion, { agente, capa,
reloj })`, con la capa y el reloj inyectados como dobles. El HTML, el
adaptador `fetch` y el arranque no tienen tests: son efectos, y se verifican
mirando la página.
