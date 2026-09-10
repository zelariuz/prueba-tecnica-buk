# Investigación: capas semánticas existentes

Antes de diseñar se revisó cómo resuelven el mismo problema las herramientas
más usadas, para tomar vocabulario y decisiones probadas y para poder
explicar, en cada punto, por qué este diseño hace lo mismo o algo distinto.
Fuente: documentación oficial de cada proyecto.

## Cube

- **Declaración:** `cube({ sql_table, joins, measures, dimensions })` en JS o YAML.
  Los joins se declaran con SQL crudo (`sql: "${a.x} = ${b.id}"`).
- **Consulta:** JSON con `measures`, `dimensions`, `timeDimensions` (con
  `granularity` y `dateRange`), `filters` (`member`, `operator`, `values`), `segments`.
- **Multi-tenancy:** `queryRewrite(query, { securityContext })` agrega un filtro
  a la consulta; `COMPILE_CONTEXT` para tenants en esquemas o bases separadas.
- **Derivadas:** medida `type: number` con `sql: "1.0 * {a} / NULLIF({b}, 0)"`.
- **Se toma:** la forma de la consulta completa, las medidas con filtro y la idea
  de un contexto de seguridad separado de la consulta.
- **Se hace distinto:** las relaciones se declaran tipadas, no como SQL; el
  filtro de empresa entra en la CTE de cada entidad, no como filtro adicional.

## dbt MetricFlow

- **Declaración:** YAML con `entities` tipadas (`primary`, `foreign`) desde las
  que infiere los joins; separa `measure` (agregación) de `metric` (concepto de
  negocio); las métricas tienen tipo explícito: `simple`, `ratio`, `cumulative`,
  `derived`.
- **Se toma:** relaciones por entidades tipadas y derivadas con tipo explícito,
  de modo que el engine las identifica por tipo y no por inspección. La
  derivada `ratio` de este proyecto viene de aquí.
- **Se descarta:** el acoplamiento a dbt y al warehouse; no trata multi-tenancy.

## Malloy

- **Declaración:** los joins son propiedad del `source`, no de la consulta;
  medidas como expresiones agregadas con filtro (`count() { where: … }`).
- **Se toma:** que las relaciones vivan en la definición y nunca en la consulta.
- **Se descarta:** el lenguaje propio; requiere parser.

## Wren Engine (MDL)

- Capa semántica diseñada para agentes de IA. Manifest JSON con `models`,
  `relationships` (`joinType`, `condition`), `metrics`; `description` en modelos
  y columnas como contexto para el modelo de lenguaje; exposición selectiva de
  columnas; `rowLevelAccessControls` con propiedad de sesión obligatoria.
- **Se toma:** el catálogo como contexto del agente (descripciones
  obligatorias, solo se expone lo declarado), el tenant como propiedad de
  sesión obligatoria y la idea de expandir cada modelo como CTE.
- **Se hace distinto:** el agente no escribe SQL sobre los modelos; solo
  consulta declarativa.

## Otros revisados

- **LookML (Looker):** el patrón original (views, explores, access_filter).
  Propietario; referencia histórica.
- **Metabase, Superset, Lightdash:** capa semántica dentro del BI; no sirve de
  interfaz común para APIs ni agentes.
- **OLAP clásico (SSAS, Kylin, AtScale):** linaje de las pre-agregaciones.
- **Constructores de SQL (Knex, Kysely, SQLAlchemy, Arel):** no son capas
  semánticas; opción para emitir SQL sin concatenar cadenas.

## Lo que ninguno hace y este diseño sí

Validar las definiciones contra el esquema físico (`information_schema`,
`pg_indexes`) al registrar, para detectar el drift antes de que falle una
consulta, y exponer el catálogo en dos vistas (pública sin nombres físicos,
interna solo en el servidor).
