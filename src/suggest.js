// Sugerencias por distancia de edición. Un error estructurado con sugerencia es
// lo que permite a un agente de IA reintentar sin intervención humana, así que
// la distancia se calcula aquí y no en cada sitio que lanza un error.
// Sin dependencias: el algoritmo cabe en veinte líneas y una dependencia más
// sería más superficie de la que ahorra.

// Levenshtein con dos filas: solo hace falta la fila anterior para calcular la
// siguiente, así que el costo en memoria es del largo del candidato.
export function distancia(a, b) {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;

  let previa = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i += 1) {
    const actual = [i];
    for (let j = 1; j <= b.length; j += 1) {
      const costo = a[i - 1] === b[j - 1] ? 0 : 1;
      actual[j] = Math.min(actual[j - 1] + 1, previa[j] + 1, previa[j - 1] + costo);
    }
    previa = actual;
  }
  return previa[b.length];
}

// Un candidato solo se sugiere si está razonablemente cerca: proponer un nombre
// que no se parece en nada confunde más que no proponer ninguno. El umbral crece
// con el largo de lo escrito (un tercio, mínimo 1) y empata por orden de
// declaración, que es estable entre corridas.
export function masParecido(escrito, candidatos) {
  const umbral = Math.max(1, Math.floor(escrito.length / 3));
  let mejor;
  let mejorDistancia = Infinity;
  for (const candidato of candidatos) {
    const d = distancia(escrito, candidato);
    if (d < mejorDistancia && d <= umbral) {
      mejor = candidato;
      mejorDistancia = d;
    }
  }
  return mejor;
}
