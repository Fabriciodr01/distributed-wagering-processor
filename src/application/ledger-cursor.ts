import { InvalidCursorError } from './errors';

// O prefixo versiona o formato: dá para mudar o cursor sem aceitar errado os antigos.
// v2 amarra o cursor à wallet; v1 (só a posição) não é mais aceito: cursores são de vida curta e a
// v1 nunca teve cliente, então aceitá-la só preservaria o caso que a v2 existe para recusar.
const PREFIX = 'v2:';
const PAYLOAD = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}):([1-9]\d{0,18})$/;

/** Cursor opaco da paginação do ledger: base64url de `v2:<walletId>:<seq>`. */
export const LedgerCursor = {
  encode(walletId: string, position: bigint): string {
    return Buffer.from(`${PREFIX}${walletId.toLowerCase()}:${position}`, 'utf8').toString('base64url');
  },

  /** Posição do cursor; recusa cursor malformado, de outra versão ou de outra wallet. */
  decode(cursor: string, walletId: string): bigint {
    if (!/^[A-Za-z0-9_-]+$/.test(cursor)) throw new InvalidCursorError();
    const decoded = Buffer.from(cursor, 'base64url').toString('utf8');
    const match = decoded.startsWith(PREFIX) ? PAYLOAD.exec(decoded.slice(PREFIX.length)) : null;
    if (!match || match[1] !== walletId.toLowerCase()) throw new InvalidCursorError();
    return BigInt(match[2]!);
  },
};
