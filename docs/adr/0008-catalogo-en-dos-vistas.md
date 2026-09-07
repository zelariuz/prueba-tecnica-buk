# ADR 0008 — El catálogo tiene una vista pública y una interna

## Contexto
Dashboards y agentes necesitan descubrir qué datos existen. Exponer el mapeo a
tablas y columnas revelaría la estructura interna que la capa debe ocultar y
daría un mapa a quien busque atacar.

## Decisión
`describe(ctx)` devuelve la vista pública: nombres semánticos, tipos,
descripciones, operadores permitidos, granularidades y consultas tipo,
filtrada por empresa y rol, siempre detrás de autenticación. La vista interna
(tablas, columnas, esquema físico, índices) existe solo del lado del servidor.

## Alternativas
- Un solo `describe()` completo: más simple, expone el mapeo físico. Descartada.
- No exponer catálogo: el agente y el constructor de gráficos no podrían
  operar. Descartada.

## Consecuencias
Test: la salida pública no contiene ningún nombre de tabla o columna física ni
información de otra empresa. Los dashboards fijos ni siquiera necesitan el
catálogo: llaman consultas tipo por nombre.
