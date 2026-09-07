# ADR 0001 — Tres piezas separadas: definiciones, catálogo, engine

## Contexto
El caso pide una capa que exponga conceptos de negocio de forma declarativa y
abstraiga la estructura interna de cada módulo. El primer criterio de
evaluación es la claridad de la separación entre definiciones, catálogo y motor.

## Decisión
- **Definiciones**: cada módulo declara entidades, dimensiones, medidas,
  segmentos, relaciones y derivadas. No conoce el engine.
- **Catálogo**: registra y valida definiciones, arma el grafo de relaciones,
  expone `describe()`. No genera SQL.
- **Engine**: recibe consulta declarativa + contexto, resuelve contra el
  catálogo, genera y ejecuta SQL. No conoce módulos concretos.

## Alternativas
- Definiciones que incluyan su propio SQL de consulta: acopla módulos al motor
  y duplica lógica. Descartada.
- Catálogo dentro del engine: dificulta testear el registro sin base y hace
  imposible que el agente lo lea de forma independiente. Descartada.

## Consecuencias
Agregar un módulo es un archivo de definición y `catalog.register()`, sin tocar
engine ni consumidores. El catálogo puede testearse con un snapshot de esquema
inyectado, sin Postgres.
