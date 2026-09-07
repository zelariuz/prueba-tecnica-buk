// Catálogo: registro central de definiciones semánticas (ADR 0001).
// En esta fase solo guarda en memoria; la validación contra el snapshot del
// esquema físico y la vista pública llegan en fases posteriores.
export function createCatalog() {
  const entidades = new Map();

  return {
    register(def) {
      entidades.set(def.name, def);
    },

    entity(name) {
      return entidades.get(name);
    },
  };
}
