// Error estructurado del engine: { code, member?, suggestion? } (CONTEXT.md).
// Se lanza como excepción para que ninguna capa pueda confundir un error con
// un resultado; la capa HTTP lo traduce a una respuesta. Las propiedades son
// enumerables para poder serializarlo directo.
export class SemanticError extends Error {
  constructor({ code, member, suggestion }) {
    super(`${code}${member ? ` (${member})` : ''}: ${suggestion ?? ''}`.trim());
    this.name = 'SemanticError';
    this.code = code;
    if (member !== undefined) this.member = member;
    if (suggestion !== undefined) this.suggestion = suggestion;
  }
}
