#!/usr/bin/env node
// Demo por consola: es el entregable que reemplaza al front (PRD, Fuera de
// Alcance). Registra los módulos contra el esquema real, imprime el catálogo
// público y responde las tres preguntas del caso mostrando, para cada una, el
// JSON de la consulta, el SQL que generó el planificador y las filas que
// devolvió Postgres. Al final, la telemetría de lo que acaba de correr.
//
// Todo lo que se ve aquí sale de las mismas interfaces que usa el servicio
// HTTP: la demo no tiene atajos ni SQL propio.
import pg from 'pg';

import { createCatalog } from './catalog.js';
import { createEngine } from './engine.js';
import { crearMemoryStore } from './cache/store.js';
import { crearTelemetria } from './telemetry.js';
import { introspect } from './introspect.js';
import { registrarModulos } from './definitions/index.js';

const { DATABASE_URL } = process.env;
if (!DATABASE_URL) {
  console.error('Falta DATABASE_URL. Levanta la base con `docker compose up -d db` (ver README).');
  process.exit(1);
}

// El contexto de sesión lo arma la aplicación, nunca la consulta (ADR 0002).
const CTX = { companyId: 1, consumer: 'dashboard' };

// El seed vive en 2025, así que "los últimos tres meses" son los últimos tres
// meses de los datos, no los del calendario de hoy.
const ANIO_2025 = ['2025-01-01', '2025-12-31'];
const ULTIMOS_TRES_MESES = ['2025-06-01', '2025-08-31'];

const PREGUNTAS = [
  {
    titulo: 'Score promedio y evaluaciones completadas por departamento y trimestre de 2025',
    consulta: 'evaluaciones-por-departamento-y-trimestre',
    params: { dateRange: ANIO_2025 },
  },
  {
    titulo: 'Porcentaje de evaluaciones completadas por departamento (2025)',
    consulta: 'completitud-por-departamento',
    params: { dateRange: ANIO_2025 },
  },
  {
    titulo: 'Tasa de asistencia por departamento de los últimos tres meses',
    consulta: 'asistencia-por-departamento',
    params: { dateRange: ULTIMOS_TRES_MESES },
  },
];

const pool = new pg.Pool({ connectionString: DATABASE_URL });
const telemetria = crearTelemetria();

try {
  // En producción el registro va siempre con el snapshot del esquema real: si
  // una definición nombra algo que la base no tiene, esto corta acá.
  const snapshot = await introspect(pool);
  const catalog = createCatalog();
  const advertencias = registrarModulos(catalog, snapshot);
  const engine = createEngine({ catalog, pool, telemetria, cache: crearMemoryStore() });

  titulo('CATÁLOGO PÚBLICO');
  imprimirCatalogo(catalog.describe(CTX));
  if (advertencias.length > 0) {
    console.log('\nAdvertencias de registro:');
    for (const aviso of advertencias) console.log(`  · ${aviso.member}: ${aviso.warning}`);
  }

  for (const [numero, pregunta] of PREGUNTAS.entries()) {
    const consulta = catalog.query(pregunta.consulta, pregunta.params);
    titulo(`PREGUNTA ${numero + 1} · ${pregunta.titulo}`);

    console.log(`\nConsulta tipo: ${pregunta.consulta}`);
    console.log('\nJSON de la consulta:');
    console.log(sangrar(JSON.stringify(consulta, null, 2)));

    const { sql, params } = engine.plan(consulta, CTX);
    console.log('\nSQL generado:');
    console.log(sangrar(sql));
    console.log(`\nParámetros: ${JSON.stringify(params)}`);

    // Cada pregunta se ejecuta dos veces: la primera va a la base, la segunda
    // sale de la caché L1. Las filas son las mismas y el `asOf` también —el de
    // la ejecución que las produjo—; lo único que cambia es `servedFrom`.
    const { rows, meta } = await engine.run(consulta, CTX);
    console.log('\nFilas:');
    console.log(sangrar(tabla(rows)));
    console.log(`\nmeta: servedFrom=${meta.servedFrom} asOf=${meta.asOf} queryId=${meta.queryId}`);
    if (meta.warnings.length > 0) {
      for (const aviso of meta.warnings) console.log(`  ⚠ ${aviso.member}: ${aviso.warning}`);
    }

    const repetida = await engine.run(consulta, CTX);
    console.log(
      `\nsegunda ejecución: servedFrom=${repetida.meta.servedFrom} asOf=${repetida.meta.asOf} · ${repetida.rows.length} filas iguales`,
    );
  }

  // Una consulta mal escrita, a propósito: así se ve el error estructurado y
  // así queda un rechazo en la telemetría.
  titulo('UN ERROR, A PROPÓSITO');
  try {
    await engine.run({ measures: ['reviews.avg_scor'] }, CTX);
  } catch (error) {
    console.log(`\n${JSON.stringify({ code: error.code, member: error.member, suggestion: error.suggestion }, null, 2)}`);
  }

  titulo('TELEMETRÍA');
  const contadores = engine.telemetry();
  console.log(`\nConsultas: ${contadores.total} (ok ${contadores.byResult.ok}, error ${contadores.byResult.error})`);
  console.log(`Por consumidor: ${JSON.stringify(contadores.byConsumer)}`);
  console.log(`Por código de error: ${JSON.stringify(contadores.byErrorCode)}`);
  console.log(`Por puerta que rechazó: ${JSON.stringify(contadores.byGate)}`);
  const { count, totalMs } = contadores.database;
  const promedio = count > 0 ? (totalMs / count).toFixed(1) : '0.0';
  console.log(`Base de datos: ${count} consultas, ${totalMs.toFixed(1)} ms en total (${promedio} ms de promedio)`);
  const { hits, misses, hitRatio } = contadores.cache;
  console.log(
    `Caché L1: ${hits} hits, ${misses} misses, hit ratio ${(hitRatio * 100).toFixed(0)} % ` +
      `(${hits} de las ${contadores.byResult.ok} respuestas no tocaron la base)\n`,
  );
} finally {
  await pool.end();
}

function titulo(texto) {
  console.log(`\n${'═'.repeat(78)}\n${texto}\n${'═'.repeat(78)}`);
}

function sangrar(texto) {
  return texto
    .split('\n')
    .map((linea) => `  ${linea}`)
    .join('\n');
}

function imprimirCatalogo(publico) {
  console.log(`\nVersión del catálogo: ${publico.version}`);
  console.log(`Granularidades: ${publico.granularities.join(', ')}`);
  for (const entidad of publico.entities) {
    console.log(`\n▸ ${entidad.name} — ${entidad.description}`);
    for (const dimension of entidad.dimensions) {
      console.log(`    dimensión ${dimension.name} (${dimension.type}) · ${dimension.description}`);
    }
    for (const medida of entidad.measures) {
      console.log(`    medida    ${medida.name} (${medida.type}) · ${medida.description}`);
    }
    for (const segmento of entidad.segments) {
      console.log(`    segmento  ${segmento.name} · ${segmento.description}`);
    }
    if (entidad.relatedEntities.length > 0) {
      console.log(`    se cruza con: ${entidad.relatedEntities.join(', ')}`);
    }
  }
  console.log('\nConsultas tipo:');
  for (const consulta of publico.queries) {
    const params = consulta.params.length > 0 ? ` (${consulta.params.join(', ')})` : '';
    console.log(`  · ${consulta.name}${params} — ${consulta.description}`);
  }
}

// Tabla de ancho fijo: lo que se lee en una terminal sin tener que contar comas.
function tabla(filas) {
  if (filas.length === 0) return '(sin filas)';
  const columnas = Object.keys(filas[0]);
  const texto = (valor) => (valor === null ? '—' : String(valor));
  const ancho = Object.fromEntries(
    columnas.map((columna) => [
      columna,
      Math.max(columna.length, ...filas.map((fila) => texto(fila[columna]).length)),
    ]),
  );

  const linea = (celdas) => celdas.map((celda, i) => celda.padEnd(ancho[columnas[i]])).join('  ');
  return [
    linea(columnas),
    columnas.map((columna) => '─'.repeat(ancho[columna])).join('  '),
    ...filas.map((fila) => linea(columnas.map((columna) => texto(fila[columna])))),
  ].join('\n');
}
