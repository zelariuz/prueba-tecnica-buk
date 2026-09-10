# ADR 0007 — La consulta declarativa usa el vocabulario de Cube

## Contexto
El equipo ya usa Cube como capa semántica y Metabase para dashboards. Un
vocabulario propio obligaría a traducir mentalmente en cada lectura.

## Decisión
La consulta es `{ measures, dimensions, timeDimensions: [{ dimension,
granularity, dateRange }], filters: [{ member, operator, values }], segments,
order, limit }`. Los miembros se nombran `entidad.miembro`.

## Alternativas
- Formato propio más compacto: menos tecleo, más fricción con el equipo. Descartada.

## Consecuencias
Un dashboard que hoy consulta Cube podría migrar sin cambiar la consulta. La
documentación de Cube sirve como referencia para los consumidores.
