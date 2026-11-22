import type { Socket, TCPSocketListener } from 'bun';

/** Uma ponta do proxy, com o que ainda não coube no buffer do socket (backpressure). */
interface End {
  socket?: Socket<Pair>;
  backlog: Uint8Array[];
}

interface Pair {
  client: End;
  upstream: End;
}

/** Escreve tudo, guardando o que o socket não aceitou para o próximo `drain`. */
function write(end: End, chunk: Uint8Array): void {
  if (!end.socket || end.backlog.length > 0) {
    end.backlog.push(chunk);
    return;
  }
  const written = end.socket.write(chunk);
  if (written < chunk.byteLength) end.backlog.push(chunk.subarray(Math.max(written, 0)));
}

function flush(end: End): void {
  while (end.socket && end.backlog.length > 0) {
    const chunk = end.backlog[0]!;
    const written = end.socket.write(chunk);
    if (written < chunk.byteLength) {
      end.backlog[0] = chunk.subarray(Math.max(written, 0));
      return;
    }
    end.backlog.shift();
  }
}

/**
 * Proxy TCP entre a aplicação e uma dependência real (ex.: MiniStack). `cut()` derruba as
 * conexões abertas e para de escutar: para a aplicação, a dependência caiu de verdade
 * (conexão recusada). `restore()` volta a escutar na mesma porta.
 */
export class TcpProxy {
  private listener?: TCPSocketListener<Pair>;
  private readonly pairs = new Set<Pair>();
  private port = 0;

  private constructor(
    private readonly targetHost: string,
    private readonly targetPort: number,
  ) {}

  /** `target` no formato de URL (`http://host:porta`). */
  static start(target: string): TcpProxy {
    const url = new URL(target);
    const proxy = new TcpProxy(url.hostname, Number(url.port || 80));
    proxy.listen();
    return proxy;
  }

  get url(): string {
    return `http://127.0.0.1:${this.port}`;
  }

  get isUp(): boolean {
    return this.listener !== undefined;
  }

  cut(): void {
    this.listener?.stop(true);
    this.listener = undefined;
    for (const pair of this.pairs) {
      pair.client.socket?.end();
      pair.upstream.socket?.end();
    }
    this.pairs.clear();
  }

  restore(): void {
    if (!this.listener) this.listen();
  }

  stop(): void {
    this.cut();
  }

  private listen(): void {
    const { targetHost, targetPort, pairs } = this;
    const close = (pair: Pair) => {
      pair.client.socket?.end();
      pair.upstream.socket?.end();
      pairs.delete(pair);
    };
    this.listener = Bun.listen<Pair>({
      hostname: '127.0.0.1',
      // Na primeira vez é 0 (porta efêmera); no restore, a mesma porta de antes.
      port: this.port,
      socket: {
        open(client) {
          const pair: Pair = { client: { socket: client, backlog: [] }, upstream: { backlog: [] } };
          client.data = pair;
          pairs.add(pair);
          Bun.connect<Pair>({
            hostname: targetHost,
            port: targetPort,
            data: pair,
            socket: {
              open(upstream) {
                pair.upstream.socket = upstream;
                flush(pair.upstream);
              },
              data(_upstream, chunk) {
                write(pair.client, new Uint8Array(chunk));
              },
              drain() {
                flush(pair.upstream);
              },
              close: () => close(pair),
              error: () => close(pair),
            },
          }).catch(() => close(pair));
        },
        data(client, chunk) {
          write(client.data.upstream, new Uint8Array(chunk));
        },
        drain(client) {
          flush(client.data.client);
        },
        close: (client) => close(client.data),
        error: (client) => close(client.data),
      },
    });
    this.port = this.listener.port;
  }
}
