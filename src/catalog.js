// Catálogo: registro central de definiciones semánticas (ADR 0001). Valida al
// registrar, arma el grafo de relaciones y expone la vista pública. No genera
// SQL: esa es la única responsabilidad del engine.
import { createHash } from 'node:crypto';

import { SemanticError } from './errors.js';
import { masParecido } from './suggest.js';
import { GRANULARIDADES, operadoresDe } from './vocabulary.js';

const TIPOS_DE_DIMENSION = new Set(['string', 'number', 'date', 'boolean']);
const TIPOS_DE_MEDIDA = new Set(['count', 'sum', 'avg']);

function invalida(member, suggestion) {
  return new SemanticError({ code: 'INVALID_DEFINITION', member, suggestion });
}

function exigirTexto(valor, member, suggestion) {
  if (typeof valor === 'string' && valor.trim().length > 0) return;
  throw invalida(member, suggestion);
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
    if (!TIPOS_DE_MEDIDA.has(medida?.type)) {
      throw invalida(
        `${entidad}.${nombre}.type`,
        `Una medida se agrega con uno de: ${[...TIPOS_DE_MEDIDA].join(', ')}.`,
      );
    }
    if (medida.type !== 'count') {
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

// Serialización canónica: mismo contenido, mismo texto, sin importar en qué
// orden se declararon las claves. Es lo que hace del hash una versión y no un
// número que cambia solo porque alguien reordenó un objeto.
function canonica(valor) {
  if (Array.isArray(valor)) return `[${valor.map(canonica).join(',')}]`;
  if (valor && typeof valor === 'object') {
    return `{${Object.keys(valor)
      .sort()
      .map((clave) => `${JSON.stringify(clave)}:${canonica(valor[clave])}`)
      .join(',')}}`;
  }
  return JSON.stringify(valor ?? null);
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

export function createCatalog() {
  const entidades = new Map();
  const consultasTipo = new Map();
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
      if (snapshot) validarContraEsquema(def, snapshot);
      entidades.set(def.name, def);
      if (snapshot) esquema = snapshot;
      return {
        ok: true,
        version: version(),
        warnings: snapshot ? advertenciasDe(def, snapshot) : [],
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
    // él ni servirle de mapa a quien busque atacar.
    describe(ctx) {
      const publica = {
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

      if (!ctx?.internal) return publica;
      return { ...publica, tables: vistaInterna() };
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
  };
}
