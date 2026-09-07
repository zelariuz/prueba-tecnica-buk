# ADR 0005 — Ningún SQL fuera del engine: segmentos y filtros declarativos

## Contexto
"Evaluación completada" debe definirse una sola vez. La tentación es declarar
el segmento como texto SQL (`"status = 'completed'"`), pero un módulo podría
colar subconsultas sin filtro de empresa o funciones costosas.

## Decisión
Segmentos, filtros de medida y filtros de consulta se declaran como
`{ member, operator, value }`. El único componente que emite SQL es el
planificador del engine. Las medidas con filtro se emiten como
`COUNT(*) FILTER (WHERE …)` cuando el dialecto lo soporta.

## Alternativas
- SQL crudo en las definiciones (como hace Cube en `sql`): flexible, pero
  imposible de validar y contradice el principio de un solo emisor. Descartada.

## Consecuencias
La validación puede verificar cada miembro y operador contra el catálogo. Un
módulo no puede degradar el rendimiento ni saltarse el aislamiento desde su
definición.
