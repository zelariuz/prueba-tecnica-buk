// Catálogo: registro central de definiciones semánticas (ADR 0001). Valida al
// registrar, arma el grafo de relaciones y expone la vista pública. No genera
// SQL: eso es responsabilidad exclusiva del planificador (src/planner.js).
import { createHash } from 'node:crypto';

import { canonica } from './canonical.js';
import { postgres } from './dialect/postgres.js';
import { SemanticError } from './errors.js';
import { masParecido } from './suggest.js';
import { GRANULARIDADES, operadoresDe } from './vocabulary.js';

// Toda entidad pertenece a una fuente, y una fuente tiene un dialecto. Cuando
// la definición no la nombra, es la de siempre: el catálogo de hoy vive entero
// sobre Postgres y una definición no debería tener que decirlo para eso.
const FUENTE_POR_DEFECTO = 'postgres';
const FUENTES_POR_DEFECTO = { [FUENTE_POR_DEFECTO]: { dialecto: postgres } };

// Las medidas que agregan una columna con aritmética: sólo tienen sentido sobre
// números. `count` cuenta filas y no mira ninguna columna.
const AGREGADOS_NUMERICOS = new Set(['sum', 'avg']);

const TIPOS_DE_DIMENSION = new Set(['string', 'number', 'date', 'boolean']);
const TIPOS_DE_MEDIDA = new Set(['count', 'sum', 'avg']);
// Una medida derivada no agrega una columna: se calcula a partir de otras
// medidas ya agregadas. En v1 solo existe la razón (ADR 0004).
const TIPOS_DE_DERIVADA = new Set(['ratio']);
// Las que no nombran columna: `count` cuenta filas y una derivada solo combina
// medidas.
const SIN_COLUMNA = new Set(['count', 'ratio']);

function invalida(member, suggestion) {
  return new SemanticError({ code: 'INVALID_DEFINITION', member, suggestion });
}

function exigirTexto(valor, member, suggestion) {
  if (typeof valor === 'string' && valor.trim().length > 0) return;
  throw invalida(member, suggestion);
}

// Una razón declara de qué dos medidas de su misma entidad sale. No es una
// expresión: no hay texto que parsear ni SQL que colar (ADR 0004). La escala se
// interpola en el SQL, así que solo puede ser un número.
function validarRatio(def, nombre, medida) {
  const miembro = `${def.name}.${nombre}`;
  for (const parte of ['numerator', 'denominator']) {
    exigirTexto(
      medida[parte],
      `${miembro}.${parte}`,
      `Una razón declara el nombre de la medida que va en su ${parte}.`,
    );
    if (medida[parte] === nombre) {
      throw invalida(`${miembro}.${parte}`, `La razón ${miembro} se referencia a sí misma.`);
    }
    if (!(medida[parte] in (def.measures ?? {}))) {
      throw invalida(
        `${miembro}.${parte}`,
        sugerenciaDe(medida[parte], Object.keys(def.measures ?? {}), 'medida', def.name),
      );
    }
  }
  if (medida.scale !== undefined && !Number.isFinite(medida.scale)) {
    throw invalida(
      `${miembro}.scale`,
      'La escala de una razón es un número (100 para un porcentaje) y se omite para una fracción.',
    );
  }
}

// Orden en que hay que calcular las derivadas de una entidad: primero aquellas
// de las que dependen las demás. El recorrido en profundidad produce el orden y
// delata el ciclo de paso: volver a una razón que todavía se está resolviendo
// significa que se necesita a sí misma dando un rodeo, y entonces ninguna de las
// dos puede calcularse primero (ADR 0004). Se resuelve al registrar y no al
// planificar, donde el ciclo sería una recursión que no termina.
function ordenDeDerivadas(def) {
  const orden = [];
  const resueltas = new Set();
  const enCurso = new Set();

  const visitar = (nombre) => {
    if (resueltas.has(nombre)) return;
    if (enCurso.has(nombre)) {
      throw invalida(
        `${def.name}.${nombre}`,
        `La razón ${def.name}.${nombre} depende de sí misma en círculo: ninguna de las razones del círculo puede calcularse antes que la otra.`,
      );
    }
    enCurso.add(nombre);
    const medida = def.measures[nombre];
    for (const parte of [medida.numerator, medida.denominator]) {
      if (def.measures[parte]?.type === 'ratio') visitar(parte);
    }
    enCurso.delete(nombre);
    resueltas.add(nombre);
    orden.push(nombre);
  };

  for (const [nombre, medida] of Object.entries(def.measures ?? {})) {
    if (medida.type === 'ratio') visitar(nombre);
  }
  return orden;
}

// Forma de la definición: lo que un módulo debe declarar para que sus datos
// puedan exponerse bajo nombres de negocio. La descripción es obligatoria en la
// entidad, en cada dimensión y en cada medida: es lo que consumidores y agentes
// leen para entender el significado sin preguntarle al dueño del módulo.
function validarForma(def) {
  exigirTexto(def?.name, 'definition.name', 'La definición debe declarar el nombre semántico de su entidad.');
  const entidad = def.name;

  exigirTexto(def.table, `${entidad}.table`, 'Declara la tabla física que respalda la entidad.');
  exigirTexto(def.primaryKey, `${entidad}.primaryKey`, 'Declara la columna llave de la tabla.');
  exigirTexto(
    def.companyColumn,
    `${entidad}.companyColumn`,
    'Declara la columna de empresa: sin ella el engine no puede aislar por tenant (ADR 0003).',
  );
  exigirTexto(
    def.description,
    `${entidad}.description`,
    'La descripción de la entidad es obligatoria: es lo que lee un agente para saber qué representa.',
  );

  for (const [nombre, dimension] of Object.entries(def.dimensions ?? {})) {
    exigirTexto(dimension?.column, `${entidad}.${nombre}.column`, 'Declara la columna física de la dimensión.');
    if (!TIPOS_DE_DIMENSION.has(dimension.type)) {
      throw invalida(
        `${entidad}.${nombre}.type`,
        `El tipo de una dimensión decide sus operadores válidos; usa uno de: ${[...TIPOS_DE_DIMENSION].join(', ')}.`,
      );
    }
    exigirTexto(
      dimension.description,
      `${entidad}.${nombre}.description`,
      'La descripción de la dimensión es obligatoria.',
    );
  }

  for (const [nombre, medida] of Object.entries(def.measures ?? {})) {
    if (!TIPOS_DE_MEDIDA.has(medida?.type) && !TIPOS_DE_DERIVADA.has(medida?.type)) {
      throw invalida(
        `${entidad}.${nombre}.type`,
        `Una medida se agrega con uno de: ${[...TIPOS_DE_MEDIDA].join(', ')}; una medida derivada se declara con uno de: ${[...TIPOS_DE_DERIVADA].join(', ')}.`,
      );
    }
    if (medida.type === 'ratio') validarRatio(def, nombre, medida);
    if (!SIN_COLUMNA.has(medida.type)) {
      exigirTexto(
        medida.column,
        `${entidad}.${nombre}.column`,
        `Una medida de tipo ${medida.type} necesita la columna que agrega.`,
      );
    }
    exigirTexto(
      medida.description,
      `${entidad}.${nombre}.description`,
      'La descripción de la medida es obligatoria.',
    );
    if (medida.segment !== undefined && !(medida.segment in (def.segments ?? {}))) {
      throw invalida(
        `${entidad}.${nombre}.segment`,
        `La medida filtra por el segmento ${medida.segment}, que la entidad no declara.`,
      );
    }
  }

  for (const [nombre, segmento] of Object.entries(def.segments ?? {})) {
    exigirTexto(
      segmento?.description,
      `${entidad}.${nombre}.description`,
      'La descripción del segmento es obligatoria: fija una regla de negocio y hay que poder leerla.',
    );
    if (!Array.isArray(segmento.filters) || segmento.filters.length === 0) {
      throw invalida(
        `${entidad}.${nombre}.filters`,
        'Un segmento se declara como lista de filtros { member, operator, values }; nunca como SQL (ADR 0005).',
      );
    }
  }

  for (const [nombre, relacion] of Object.entries(def.relationships ?? {})) {
    if (relacion?.type !== 'many_to_one') {
      throw invalida(
        `${entidad}.${nombre}.type`,
        'En v1 solo existen relaciones many_to_one: son las que no multiplican filas (ADR 0006).',
      );
    }
    exigirTexto(relacion.target, `${entidad}.${nombre}.target`, 'Declara la entidad destino de la relación.');
    exigirTexto(
      relacion.foreignKey,
      `${entidad}.${nombre}.foreignKey`,
      'Declara la columna de esta entidad que apunta al destino.',
    );
    exigirTexto(
      relacion.description,
      `${entidad}.${nombre}.description`,
      'La descripción de la relación es obligatoria.',
    );
  }

  if (def.timeDimension !== undefined && !(def.timeDimension in (def.dimensions ?? {}))) {
    throw invalida(
      `${entidad}.timeDimension`,
      `La dimensión temporal ${def.timeDimension} debe estar declarada entre las dimensiones de la entidad.`,
    );
  }
}

// Toda columna que la definición nombra, con el miembro al que responsabilizar
// si no existe. El engine solo puede emitir columnas que salen de aquí.
function columnasDeclaradas(def) {
  const declaradas = [
    { member: `${def.name}.primaryKey`, columna: def.primaryKey },
    { member: `${def.name}.companyColumn`, columna: def.companyColumn },
  ];
  for (const [nombre, dimension] of Object.entries(def.dimensions ?? {})) {
    declaradas.push({ member: `${def.name}.${nombre}.column`, columna: dimension.column });
  }
  for (const [nombre, medida] of Object.entries(def.measures ?? {})) {
    if (medida.column) declaradas.push({ member: `${def.name}.${nombre}.column`, columna: medida.column });
  }
  for (const [nombre, relacion] of Object.entries(def.relationships ?? {})) {
    declaradas.push({ member: `${def.name}.${nombre}.foreignKey`, columna: relacion.foreignKey });
  }
  return declaradas;
}

// El esquema físico se descubre, no se declara: la definición se contrasta
// contra la foto que trae `introspect(pool)`. Un cambio de esquema se detecta
// al registrar y no cuando el dashboard ya está roto.
function validarContraEsquema(def, snapshot) {
  const tabla = snapshot.tables?.[def.table];
  if (!tabla) {
    throw invalida(
      `${def.name}.table`,
      sugerenciaDe(def.table, Object.keys(snapshot.tables ?? {}), 'tabla', 'el esquema'),
    );
  }

  const existentes = Object.keys(tabla.columns ?? {});
  for (const { member, columna } of columnasDeclaradas(def)) {
    if (existentes.includes(columna)) continue;
    throw invalida(member, sugerenciaDe(columna, existentes, 'columna', def.table));
  }
}

// Compatibilidad de tipos: el tipo declarado de una dimensión decide qué
// operadores publica el catálogo, y el tipo físico decide qué hay de verdad en
// la columna. Si no calzan, el catálogo promete un vocabulario que la base no
// puede cumplir —`inDateRange` sobre una columna de texto no es una consulta
// lenta, es una consulta que miente— y una medida `avg` o `sum` sobre texto
// falla recién en la base, con un error del motor que nadie pidió.
//
// Quién traduce el tipo físico al semántico es el dialecto de la fuente de la
// entidad: `numeric` significa algo distinto en cada motor y el catálogo no
// tiene por qué saberlo. Un tipo físico que el dialecto no reconoce no se juzga
// (`tipoSemantico` devuelve `undefined`): es la respuesta conservadora, la misma
// que da el catálogo cuando no hay snapshot.
//
// Que la incompatibilidad sea error o advertencia lo decide el dialecto con su
// capacidad `tiposGarantizados`: un motor que declara y hace cumplir el tipo de
// cada columna convierte el desajuste en un hecho; uno de tipos laxos (SQLite)
// lo deja en sospecha, y ahí rechazar el registro sería negarse a hablar con el
// motor.
function incompatibilidadesDeTipo(def, snapshot, dialecto) {
  const columnas = snapshot.tables?.[def.table]?.columns ?? {};
  const problemas = [];

  const semantico = (columna) => dialecto.tipoSemantico(columnas[columna]);

  for (const [nombre, dimension] of Object.entries(def.dimensions ?? {})) {
    const fisico = semantico(dimension.column);
    if (fisico === undefined || fisico === dimension.type) continue;
    problemas.push({
      member: `${def.name}.${nombre}`,
      detalle: `La dimensión ${def.name}.${nombre} se declara de tipo ${dimension.type}, pero la columna ${def.table}.${dimension.column} es ${columnas[dimension.column]}, que en ${dialecto.name} es de tipo ${fisico}. Declara type '${fisico}' o apunta la dimensión a otra columna.`,
    });
  }

  for (const [nombre, medida] of Object.entries(def.measures ?? {})) {
    if (!AGREGADOS_NUMERICOS.has(medida.type)) continue;
    const fisico = semantico(medida.column);
    if (fisico === undefined || fisico === 'number') continue;
    problemas.push({
      member: `${def.name}.${nombre}`,
      detalle: `La medida ${def.name}.${nombre} agrega con ${medida.type} la columna ${def.table}.${medida.column}, que es ${columnas[medida.column]}: de tipo ${fisico} y no number. Una medida ${medida.type} sólo puede agregar columnas numéricas.`,
    });
  }

  return problemas;
}

function validarTipos(def, snapshot, dialecto) {
  const problemas = incompatibilidadesDeTipo(def, snapshot, dialecto);
  if (dialecto.capabilities?.tiposGarantizados === false) {
    return problemas.map(({ member, detalle }) => ({ member, warning: detalle }));
  }
  for (const { member, detalle } of problemas) throw invalida(member, detalle);
  return [];
}

// Advertencias: problemas que no impiden registrar pero que el dueño del módulo
// debería corregir antes de producción. La dimensión temporal es la que más
// filas recorre —toda consulta la acota por rango— y sin índice que la cubra
// cada consulta termina leyendo la tabla entera.
function advertenciasDe(def, snapshot) {
  const advertencias = [];
  const temporal = def.dimensions?.[def.timeDimension];
  if (!temporal) return advertencias;

  const indices = snapshot.tables?.[def.table]?.indexes ?? [];
  const cubierta = indices.some((indice) => indice.columns.includes(temporal.column));
  if (!cubierta) {
    advertencias.push({
      member: `${def.name}.${def.timeDimension}`,
      warning: `La dimensión temporal ${def.name}.${def.timeDimension} no tiene índice que la cubra en ${def.table}: toda consulta con rango recorrerá la tabla completa.`,
    });
  }
  return advertencias;
}

function sugerenciaDe(escrito, candidatos, clase, contenedor) {
  const parecido = masParecido(escrito, candidatos);
  return parecido
    ? `La ${clase} ${escrito} no existe en ${contenedor}. ¿Quisiste decir ${parecido}?`
    : `La ${clase} ${escrito} no existe en ${contenedor}.`;
}

// Un parámetro de consulta tipo se escribe `:nombre` en el lugar donde va su
// valor. Reemplazarlo es recorrer la plantilla y cambiar esas hojas: la
// plantilla no se muta nunca, así que dos llamadas con valores distintos no se
// pisan.
function reemplazarParametros(valor, params, nombre) {
  if (typeof valor === 'string' && valor.startsWith(':')) {
    const parametro = valor.slice(1);
    if (!Object.hasOwn(params, parametro)) {
      throw new SemanticError({
        code: 'MISSING_PARAM',
        member: parametro,
        suggestion: `La consulta tipo ${nombre} necesita el parámetro ${parametro}.`,
      });
    }
    return params[parametro];
  }
  if (Array.isArray(valor)) return valor.map((elemento) => reemplazarParametros(elemento, params, nombre));
  if (valor && typeof valor === 'object') {
    return Object.fromEntries(
      Object.entries(valor).map(([clave, hijo]) => [clave, reemplazarParametros(hijo, params, nombre)]),
    );
  }
  return valor;
}

// Clases de miembro, con el nombre que se usa al hablarle al consumidor.
const CLASES = { dimensions: 'dimensión', measures: 'medida', segments: 'segmento' };

// `fuentes` es el mapa nombre → { dialecto } de las fuentes que este catálogo
// conoce. El catálogo no ejecuta nada, así que no le importa el pool: sólo el
// dialecto, que es quien traduce los tipos físicos de esa fuente.
export function createCatalog({ fuentes = FUENTES_POR_DEFECTO } = {}) {
  const entidades = new Map();
  const consultasTipo = new Map();
  // Por entidad, sus medidas derivadas en orden topológico: cada una después de
  // aquellas de las que depende.
  const ordenDeCalculo = new Map();
  // Última foto del esquema con la que se registró: entra al hash de versión
  // porque el mismo diccionario sobre otro esquema físico no es el mismo
  // contrato.
  let esquema;

  // La versión invalida la caché (fase 8) y viaja en el catálogo público: es el
  // hash del contrato completo, definiciones más esquema.
  function version() {
    return createHash('sha256')
      .update(canonica({ entities: Object.fromEntries(entidades), schema: esquema ?? null }))
      .digest('hex')
      .slice(0, 16);
  }

  // Vista interna (ADR 0008): el mapeo semántico → físico. Vive solo del lado
  // del servidor; es lo que el engine necesita para emitir SQL y lo que un
  // consumidor no debe ver nunca.
  function vistaInterna() {
    const tablas = {};
    for (const def of entidades.values()) {
      const columnas = {};
      for (const [nombre, dimension] of Object.entries(def.dimensions ?? {})) {
        columnas[`${def.name}.${nombre}`] = dimension.column;
      }
      for (const [nombre, medida] of Object.entries(def.measures ?? {})) {
        if (medida.column) columnas[`${def.name}.${nombre}`] = medida.column;
      }
      tablas[def.name] = {
        table: def.table,
        primaryKey: def.primaryKey,
        companyColumn: def.companyColumn,
        columns: columnas,
        joins: Object.values(def.relationships ?? {}).map((r) => ({
          to: r.target,
          foreignKey: r.foreignKey,
        })),
      };
    }
    return tablas;
  }

  // Vista pública (ADR 0008): nombres semánticos, tipos, descripciones,
  // operadores válidos, granularidades y consultas tipo. Nunca nombres de
  // tablas ni de columnas: lo que un consumidor no ve, no puede acoplarse a él
  // ni servirle de mapa a quien busque atacar.
  function vistaPublica() {
    return {
      version: version(),
      granularities: [...GRANULARIDADES],
      entities: [...entidades.values()].map((def) => ({
        name: def.name,
        description: def.description,
        ...(def.timeDimension ? { timeDimension: `${def.name}.${def.timeDimension}` } : {}),
        dimensions: Object.entries(def.dimensions ?? {}).map(([nombre, dimension]) => ({
          name: `${def.name}.${nombre}`,
          type: dimension.type,
          description: dimension.description,
          operators: operadoresDe(dimension.type),
        })),
        measures: Object.entries(def.measures ?? {}).map(([nombre, medida]) => ({
          name: `${def.name}.${nombre}`,
          type: medida.type,
          description: medida.description,
        })),
        segments: Object.entries(def.segments ?? {}).map(([nombre, segmento]) => ({
          name: `${def.name}.${nombre}`,
          description: segmento.description,
        })),
        // Con qué se puede cruzar esta entidad, por nombre de entidad: el
        // consumidor nunca nombra una relación ni su columna de unión.
        relatedEntities: Object.values(def.relationships ?? {}).map((r) => r.target),
      })),
      queries: [...consultasTipo.values()].map(({ name, description, params }) => ({
        name,
        description,
        params: [...params],
      })),
    };
  }

  // Todos los miembros conocidos con su clase. Es la lista contra la que se
  // busca la sugerencia cuando alguien escribe mal un nombre: un agente que se
  // equivoca puede corregirse solo si el error le dice cuál era el nombre.
  function miembrosConocidos() {
    const conocidos = new Map();
    for (const def of entidades.values()) {
      for (const clase of Object.keys(CLASES)) {
        for (const nombre of Object.keys(def[clase] ?? {})) {
          conocidos.set(`${def.name}.${nombre}`, CLASES[clase]);
        }
      }
    }
    return conocidos;
  }

  function desconocido(miembro, clase) {
    const conocidos = miembrosConocidos();
    const esperada = CLASES[clase];

    // El miembro existe, pero es de otra clase: decirlo ahorra la vuelta de
    // buscar un nombre correcto que ya estaba escrito bien.
    if (conocidos.has(miembro)) {
      return new SemanticError({
        code: 'UNKNOWN_MEMBER',
        member: miembro,
        suggestion: `${miembro} es una ${conocidos.get(miembro)} y aquí se espera una ${esperada}.`,
      });
    }

    const parecido = masParecido(String(miembro), [...conocidos.keys()]);
    return new SemanticError({
      code: 'UNKNOWN_MEMBER',
      member: miembro,
      suggestion: parecido
        ? `No existe la ${esperada} ${miembro}. ¿Quisiste decir ${parecido}?`
        : `No existe la ${esperada} ${miembro}. Consulta el catálogo público para ver los miembros disponibles.`,
    });
  }

  // Resolver un miembro es traducir su nombre de negocio `entidad.miembro` a lo
  // que la entidad declaró. El engine no lee las definiciones: se lo pregunta
  // al catálogo, que es quien sabe qué existe y qué sugerir cuando no existe.
  function resolver(miembro, clase) {
    const [entidad, nombre, ...sobra] = String(miembro).split('.');
    const declaracion = sobra.length === 0 ? entidades.get(entidad)?.[clase]?.[nombre] : undefined;
    if (!declaracion) throw desconocido(miembro, clase);
    return { miembro, entidad, nombre, definicion: declaracion };
  }

  return {
    // El snapshot es opcional: sin él se valida la forma pero no el esquema
    // físico. Quien registra contra una base viva pasa el de `introspect`.
    register(def, snapshot) {
      validarForma(def);
      const dialecto = fuentes[def?.source ?? FUENTE_POR_DEFECTO]?.dialecto;
      if (snapshot) validarContraEsquema(def, snapshot);
      const deTipos = snapshot && dialecto ? validarTipos(def, snapshot, dialecto) : [];
      // El orden de cálculo de las derivadas se resuelve una vez, al registrar:
      // el engine lo recibe hecho y nunca tiene que descubrirlo por consulta.
      ordenDeCalculo.set(def.name, ordenDeDerivadas(def));
      entidades.set(def.name, def);
      if (snapshot) esquema = snapshot;
      return {
        ok: true,
        version: version(),
        warnings: snapshot ? [...deTipos, ...advertenciasDe(def, snapshot)] : [],
      };
    },

    // Consulta tipo: plantilla con nombre y parámetros que el dueño del módulo
    // registra para que un dashboard fijo no tenga que armar JSON.
    registerQuery({ name, description, query, params = [] }) {
      exigirTexto(name, 'query.name', 'La consulta tipo debe declarar un nombre.');
      exigirTexto(
        description,
        `${name}.description`,
        'La descripción de la consulta tipo es obligatoria: es lo que se lee en el catálogo.',
      );
      if (!query || typeof query !== 'object') {
        throw invalida(`${name}.query`, 'La consulta tipo debe traer una consulta declarativa.');
      }
      consultasTipo.set(name, { name, description, params, query });
      return { ok: true, name };
    },

    // Devuelve la consulta declarativa con sus parámetros puestos, lista para
    // `engine.plan` o `engine.run`.
    query(name, params = {}) {
      const consulta = consultasTipo.get(name);
      if (!consulta) {
        const parecida = masParecido(String(name), [...consultasTipo.keys()]);
        throw new SemanticError({
          code: 'UNKNOWN_QUERY',
          member: name,
          suggestion: parecida
            ? `No existe la consulta tipo ${name}. ¿Quisiste decir ${parecida}?`
            : `No existe la consulta tipo ${name}. Consulta el catálogo público para ver las disponibles.`,
        });
      }
      for (const parametro of consulta.params) {
        if (Object.hasOwn(params, parametro)) continue;
        throw new SemanticError({
          code: 'MISSING_PARAM',
          member: parametro,
          suggestion: `La consulta tipo ${name} necesita el parámetro ${parametro}.`,
        });
      }
      return reemplazarParametros(consulta.query, params, name);
    },

    queries() {
      return [...consultasTipo.values()].map(({ name, description, params }) => ({
        name,
        description,
        params: [...params],
      }));
    },

    version,

    // Vista pública (ADR 0008): nombres semánticos, tipos, descripciones,
    // operadores válidos, granularidades y consultas tipo. Nunca nombres de
    // tablas ni de columnas: lo que un consumidor no ve, no puede acoplarse a
    // él ni servirle de mapa a quien busque atacar. Es lo único que devuelve
    // `describe`, sin importar qué traiga el contexto: el contexto lo arma
    // quien llama, y una vista que dependiera de un campo suyo sería una vista
    // que el consumidor puede pedirse solo.
    // Recibe el contexto porque es parte del contrato —la vista se filtrará por
    // empresa y rol— aunque hoy la vista pública sea la misma para todos.
    describe(ctx) {
      return vistaPublica();
    },

    // Vista interna (ADR 0008): la pública más el mapeo físico. No recibe el
    // contexto de un consumidor porque no es para ningún consumidor: la usa el
    // servidor —depuración, herramientas del equipo— y nunca sale por la API.
    describeInternal() {
      return { ...vistaPublica(), tables: vistaInterna() };
    },

    // Un miembro de cada clase, resuelto o con el error que explica por qué no.
    dimension(miembro) {
      const resuelta = resolver(miembro, 'dimensions');
      return { ...resuelta, columna: resuelta.definicion.column, tipo: resuelta.definicion.type };
    },

    measure(miembro) {
      return resolver(miembro, 'measures');
    },

    segment(miembro) {
      return resolver(miembro, 'segments');
    },

    entity(name) {
      return entidades.get(name);
    },

    // Las derivadas de una entidad en el orden en que pueden calcularse: cada
    // una después de aquellas de las que depende. Es lo que le permite al
    // planificador emitir una razón apoyada en otra sin resolver el grafo por
    // su cuenta.
    derivedOrder(name) {
      return [...(ordenDeCalculo.get(name) ?? [])];
    },
  };
}
