# ADR 0008 — El catálogo tiene una vista pública y una interna

## Contexto
Dashboards y agentes necesitan descubrir qué datos existen. Exponer el mapeo a
tablas y columnas revelaría la estructura interna que la capa debe ocultar y
daría un mapa a quien busque atacar.

## Decisión
`describe(ctx)` devuelve la vista pública: nombres semánticos, tipos,
descripciones, operadores que el planificador emite, granularidades y consultas
tipo, siempre detrás de autenticación. La vista interna (tablas, columnas,
esquema físico, índices) existe solo del lado del servidor.

**La vista pública es la misma para todo contexto** (precisión del 08-09: antes
este ADR decía "filtrada por empresa y rol", y el código nunca lo hizo). El
contexto se recibe porque es parte del contrato, pero no se lee: lo que varía
por consumidor es el **presupuesto**, no el catálogo, y una vista que dependiera
de un campo del contexto sería una vista que el consumidor puede pedirse solo
—`describe({ internal: true })` devuelve exactamente lo mismo, y hay un test que
lo fija—. Filtrar el diccionario por empresa o por rol es una evolución con su
propia decisión: hoy el diccionario es común a todas las empresas.

**La vista pública incluye el `query` de cada consulta tipo** (09-09): son
ejemplos resueltos para el agente. Una plantilla declarativa sólo nombra
miembros semánticos —por eso puede publicarse tal cual— y viaja con sus
marcadores `:nombre` sin sustituir; sin ella, quien sólo lee el catálogo copia
la forma pero no los detalles que deciden el resultado.

## Alternativas
- Un solo `describe()` completo: más simple, expone el mapeo físico. Descartada.
- No exponer catálogo: el agente y el constructor de gráficos no podrían
  operar. Descartada.

## Consecuencias
Test: la salida pública no contiene ningún nombre de tabla o columna física ni
información de otra empresa. Los dashboards fijos ni siquiera necesitan el
catálogo: llaman consultas tipo por nombre.

**El SQL del dry-run es interno por esta misma razón** (08-09): nombra tablas y
columnas físicas, así que `POST /analytics/query?dryRun=true` devuelve el plan
lógico —que sólo tiene nombres semánticos— a todo el mundo y agrega el `sql` sólo
si el token marca la sesión como interna. Esconder el mapeo en `/catalog` y
regalarlo por la otra ruta era tener media regla.
