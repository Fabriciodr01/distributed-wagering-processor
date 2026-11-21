export const ID_GENERATOR = Symbol('ID_GENERATOR');

/** Gera ids internos (UUIDv7: ordenáveis pelo tempo de criação). */
export interface IdGenerator {
  next(): string;
}
