import { InvalidCursorError } from './errors';

// O prefixo versiona o formato: dá para mudar o cursor sem aceitar errado os antigos.
const PREFIX = 'v1:';
const POSITION = /^[1-9]\d{0,18}$/;

/** Cursor opaco da paginação do ledger: base64url de uma posição (seq). */
export const LedgerCursor = {
  encode(position: bigint): string {
    return Buffer.from(`${PREFIX}${position}`, 'utf8').toString('base64url');
  },

  decode(cursor: string): bigint {
    if (!/^[A-Za-z0-9_-]+$/.test(cursor)) throw new InvalidCursorError();
    const decoded = Buffer.from(cursor, 'base64url').toString('utf8');
    const position = decoded.startsWith(PREFIX) ? decoded.slice(PREFIX.length) : '';
    if (!POSITION.test(position)) throw new InvalidCursorError();
    return BigInt(position);
  },
};
