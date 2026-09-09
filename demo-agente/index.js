// Arranque de la demo: lee la configuración, comprueba que la capa esté arriba
// —si no, muere diciendo qué levantar— y escucha.
import { crearCapa, pedirCatalogo } from './src/capa.js';
import { crearServidor } from './src/servidor.js';

const url = process.env.CAPA_URL ?? 'http://localhost:3000';
const tokens = {
  agente: process.env.TOKEN_AGENTE ?? 'demo-agente-empresa-a',
  interno: process.env.TOKEN_INTERNO ?? 'demo-interno-empresa-a',
};
const puerto = Number(process.env.PUERTO ?? 3100);

let catalogo;
try {
  catalogo = await pedirCatalogo({ url, tokens });
} catch (error) {
  console.error(
    `La capa semántica no responde en ${url} (${error.message}).\n` +
      'Levántala desde la raíz del repo con:\n\n  docker compose up -d --build\n',
  );
  process.exit(1);
}

crearServidor({ capa: crearCapa({ url, tokens }) }).listen(puerto, () => {
  console.log(
    `Demo agente en http://localhost:${puerto}/ — capa en ${url}, catálogo versión ${catalogo.version}.`,
  );
});
