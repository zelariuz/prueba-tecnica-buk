// Del código del error estructurado al código HTTP. Es una tabla, no lógica:
// el que no está en ella no es un error del consumidor sino del servidor, y
// sale como 500 sin detalles.
//
// Decisiones:
//   * `MISSING_TENANT` es 401 y no 403: sin token conocido no hay sesión que
//     autorizar, todavía no se sabe quién pide.
//   * `QUERY_TIMEOUT` es 504 y no 503: el servicio está sano; lo que se agotó
//     es el presupuesto de tiempo de esta consulta contra la base, que para el
//     servicio HTTP es su dependencia aguas arriba. 503 diría "vuelve más
//     tarde", y volver más tarde con la misma consulta no la haría terminar.
//   * `INVALID_JSON` es el único código que nace en la capa HTTP: el cuerpo no
//     llegó a ser una consulta declarativa, así que ninguna puerta del engine
//     pudo opinar.
//   * `PAYLOAD_TOO_LARGE` es 413: el cuerpo superó el techo que la capa HTTP le
//     pone antes de leerlo entero. Nace aquí, como `INVALID_JSON`: ninguna
//     puerta del engine llegó a ver una consulta.
//   * `SCHEMA_DRIFT` es 503 y no 500: la base ya no calza con el catálogo, así
//     que el servicio no puede responder hasta que alguien lo vuelva a
//     registrar contra el esquema actual. Es una dependencia rota, no una
//     consulta mal escrita, y el consumidor no puede arreglarla cambiando lo
//     que pidió.
//   * `SOURCE_UNAVAILABLE` es 503 y sí lleva `Retry-After`: la base de la
//     fuente no respondió a la conexión. A diferencia del `QUERY_TIMEOUT`, aquí
//     volver más tarde con la misma consulta sí puede funcionar, así que el
//     servicio lo dice con la cabecera en vez de dejar que el cliente adivine.
//   * `INVALID_DEFINITION` no está en la tabla a propósito: una definición mal
//     declarada es un error del servidor, no de quien consulta.
export const CODIGOS_HTTP = {
  MISSING_TENANT: 401,
  FORBIDDEN_FIELD: 400,
  UNKNOWN_MEMBER: 400,
  NO_JOIN_PATH: 400,
  INVALID_OPERATOR: 400,
  UNSUPPORTED_OPERATOR: 400,
  MULTI_ENTITY_MEASURES: 400,
  MISSING_TIME_RANGE: 400,
  INVALID_CONSUMER: 400,
  UNKNOWN_QUERY: 400,
  MISSING_PARAM: 400,
  INVALID_QUERY: 400,
  INVALID_JSON: 400,
  PAYLOAD_TOO_LARGE: 413,
  QUERY_TIMEOUT: 504,
  SCHEMA_DRIFT: 503,
  SOURCE_UNAVAILABLE: 503,
};

// Cabeceras que acompañan a un código de error. `Retry-After` sólo tiene
// sentido donde reintentar sirve de algo: la fuente que no responde puede
// volver, y el número le ahorra al cliente inventarse un intervalo. Es una
// tabla, no lógica, por la misma razón que la de arriba.
export const CABECERAS_HTTP = {
  SOURCE_UNAVAILABLE: { 'retry-after': '5' },
};
