import { type INestApplication, Logger } from '@nestjs/common';
import { createApp } from './app.factory';
import { type AppConfig, InvalidConfigError, loadConfig } from './config/app-config';

// Margem além do tempo de drenagem dos workers antes de desistir e sair à força.
const FORCED_EXIT_MARGIN_MS = 5000;

/**
 * Sinais tratados aqui, não com `enableShutdownHooks()`: o Nest reemite o sinal depois
 * de fechar, e o processo sai com 143 mesmo num shutdown limpo. Assim `app.close()`
 * roda os mesmos hooks de ciclo de vida e o exit code diz se a drenagem terminou bem.
 */
function handleShutdownSignals(app: INestApplication, config: AppConfig): void {
  const logger = new Logger('Shutdown');
  let shuttingDown = false;
  const shutdown = async (signal: NodeJS.Signals) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.log(`${signal} recebido, encerrando`);
    setTimeout(() => {
      logger.error('Encerramento excedeu o tempo limite; saindo à força');
      process.exit(1);
    }, config.consumer.shutdownTimeoutMs + FORCED_EXIT_MARGIN_MS).unref();
    try {
      await app.close();
      process.exit(0);
    } catch (error) {
      logger.error(`Falha ao encerrar a aplicação: ${error instanceof Error ? error.message : String(error)}`);
      process.exit(1);
    }
  };
  process.once('SIGTERM', shutdown);
  process.once('SIGINT', shutdown);
}

async function bootstrap(): Promise<void> {
  const config = loadConfig();
  const app = await createApp(config);
  handleShutdownSignals(app, config);
  await app.listen(config.port);
}

bootstrap().catch((error: unknown) => {
  if (error instanceof InvalidConfigError) {
    console.error(error.message);
  } else {
    console.error('Falha ao iniciar a aplicação', error);
  }
  process.exit(1);
});
