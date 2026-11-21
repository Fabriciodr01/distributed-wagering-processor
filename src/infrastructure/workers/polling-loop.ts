/**
 * Laço de polling com parada cooperativa: `stop()` interrompe a espera entre rodadas e
 * aguarda a rodada em andamento terminar, sem cortar um item no meio.
 */
export class PollingLoop {
  private running?: Promise<void>;
  private stopping = false;
  private wake?: () => void;

  constructor(
    private readonly intervalMs: number,
    /** Devolve true quando há mais trabalho imediato (lote cheio) e não deve esperar. */
    private readonly tick: () => Promise<boolean>,
    private readonly onError: (error: unknown) => void,
  ) {}

  start(): void {
    if (this.running) return;
    this.stopping = false;
    this.running = this.run();
  }

  async stop(): Promise<void> {
    this.stopping = true;
    this.wake?.();
    await this.running;
    this.running = undefined;
  }

  private async run(): Promise<void> {
    while (!this.stopping) {
      let busy = false;
      try {
        busy = await this.tick();
      } catch (error) {
        this.onError(error);
      }
      if (!busy && !this.stopping) await this.pause();
    }
  }

  private pause(): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(done, this.intervalMs);
      this.wake = done;
      function done() {
        clearTimeout(timer);
        resolve();
      }
    });
  }
}
