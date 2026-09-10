// Serialización canónica: mismo contenido, mismo texto, sin importar en qué
// orden se declararon las claves. Es lo que hace del hash una identidad y no un
// número que cambia solo porque alguien reordenó un objeto.
//
// Vive aparte porque la usan dos piezas que no se conocen: el catálogo, para su
// versión, y el engine, para el `queryId`. Si cada una tuviera la suya, dos
// hashes que deberían coincidir podrían dejar de hacerlo sin que nadie lo note.
export function canonica(valor) {
  if (Array.isArray(valor)) return `[${valor.map(canonica).join(',')}]`;
  if (valor && typeof valor === 'object') {
    return `{${Object.keys(valor)
      .sort()
      .map((clave) => `${JSON.stringify(clave)}:${canonica(valor[clave])}`)
      .join(',')}}`;
  }
  return JSON.stringify(valor ?? null);
}
