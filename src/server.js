#!/usr/bin/env node
// Punto de entrada del servicio `api`: arma el catálogo contra el esquema real,
// crea el engine y levanta el servidor HTTP.
//
// El registro se hace con el snapshot del introspector, no sin él: si una
// definición nombra una tabla o una columna que la base no tiene, `register`
// lanza `INVALID_DEFINITION` y el proceso no llega a escuchar. Un servicio que
// arranca con un contrato roto es peor que uno que no arranca.
import pg from 'pg';

import { createCatalog } from './catalog.js';
import { createEngine } from './engine.js';
import { introspect } from './introspect.js';
import { registrarModulos } from './definitions/index.js';
import { crearServidor } from './http/server.js';
import { tokensDeDemo } from './http/tokens.js';

const { DATABASE_URL, PORT = '3000', HOST = '0.0.0.0' } = process.env;

if (!DATABASE_URL) {
  console.error('Falta DATABASE_URL: el servicio necesita la conexión a Postgres (ver .env.example).');
  process.exit(1);
}

const pool = new pg.Pool({ connectionString: DATABASE_URL });
const tokens = tokensDeDemo(process.env);

const snapshot = await introspect(pool);
const catalog = createCatalog();
const advertencias = registrarModulos(catalog, snapshot);
for (const aviso of advertencias) {
  console.warn(`[registro] ${aviso.entity} · ${aviso.member}: ${aviso.warning}`);
}

const engine = createEngine({ catalog, pool });
const servidor = crearServidor({ engine, catalog, tokens });

servidor.listen(Number(PORT), HOST, () => {
  console.log(`Capa semántica escuchando en http://${HOST}:${PORT}`);
  console.log(`Catálogo versión ${catalog.version()} · ${Object.keys(tokens).length} tokens de demo`);
});

for (const senal of ['SIGTERM', 'SIGINT']) {
  process.on(senal, () => {
    servidor.close(async () => {
      await pool.end();
      process.exit(0);
    });
  });
}
