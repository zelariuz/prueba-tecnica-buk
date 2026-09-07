// Composición de los módulos: qué definiciones y qué consultas tipo existen.
// Es el único lugar que los nombra a todos, y por eso agregar un módulo es
// agregar una línea aquí más su archivo de definición: ni el engine ni el
// planificador se enteran (historia 9).
import { consultasTipo } from './consultas-tipo.js';
import { departments } from './departments.js';
import { employees } from './employees.js';
import { reviews } from './reviews.js';

export const modulos = [reviews, employees, departments];

// En producción el registro va SIEMPRE con el snapshot del esquema real: sin él
// se valida la forma pero no que las columnas existan, y una definición que
// nombra una columna que ya no está sólo se descubriría cuando un dashboard
// falle. Sin snapshot, `register` no puede cortar el arranque.
export function registrarModulos(catalog, snapshot) {
  const advertencias = [];
  for (const definicion of modulos) {
    const { warnings } = catalog.register(definicion, snapshot);
    advertencias.push(...warnings.map((aviso) => ({ entity: definicion.name, ...aviso })));
  }
  for (const consulta of consultasTipo) catalog.registerQuery(consulta);
  return advertencias;
}
