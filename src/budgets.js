// Presupuestos por clase de consumidor (CONTEXT.md, "Consumidor"): tabla de
// configuración, no lógica. Lo que un consumidor puede gastar se decide por su
// clase, que viaja en el contexto de sesión y nunca en la consulta (ADR 0002).
import { SemanticError } from './errors.js';

// `cacheTtlMs` vive aquí y no en una constante global porque la frescura que
// alguien puede tolerar es parte de lo que su clase puede gastar, igual que el
// timeout: el tablero repite la misma consulta muchas veces y un minuto de
// antigüedad le sobra; la API y el agente responden preguntas más variadas y se
// les da la mitad, para que un dato de hace un minuto no salga en un informe.
export const presupuestos = {
  dashboard: { timeoutMs: 5_000, maxFilas: 5_000, rangoObligatorio: false, cacheTtlMs: 60_000 },
  api: { timeoutMs: 15_000, maxFilas: 10_000, rangoObligatorio: false, cacheTtlMs: 30_000 },
  // El agente de IA pide en lenguaje natural: se le exige rango temporal para
  // que no produzca por accidente una consulta que recorre toda la historia.
  agent: { timeoutMs: 10_000, maxFilas: 1_000, rangoObligatorio: true, cacheTtlMs: 30_000 },
};

// Sin clase de consumidor no hay presupuesto, y sin presupuesto no se ejecuta:
// una clase desconocida es un contexto mal construido, no un valor por defecto.
export function presupuestoDe(consumer, tabla = presupuestos) {
  const presupuesto = Object.hasOwn(tabla, consumer ?? '') ? tabla[consumer] : undefined;
  if (!presupuesto) {
    throw new SemanticError({
      code: 'INVALID_CONSUMER',
      member: 'consumer',
      suggestion: `El contexto de sesión debe traer una clase de consumidor conocida: ${Object.keys(tabla).join(', ')}.`,
    });
  }
  return presupuesto;
}
