import { ConfigError, loadConfig } from "./config/environment";
import { createCollector } from "./app";

/**
 * Entry point. SIGTERM/SIGINT = graceful shutdown (kill switch): the HTTP server stops accepting webhooks, running
 * jobs reach a saved state, and pending jobs stay on disk to resume after the next start. Platforms redeliver
 * webhooks that were not acknowledged while the service was down.
 */
async function main(): Promise<void> {
  let config;
  try {
    config = loadConfig();
  } catch (err) {
    if (err instanceof ConfigError) {
      process.stderr.write(`${err.message}\n`);
      process.exit(2);
    }
    throw err;
  }
  const collector = createCollector(config);
  await collector.start();
  collector.server.listen(config.port, config.host, () => {
    collector.logger.info("collector.listening", {
      host: config.host, port: config.port, whatsapp: config.whatsapp.enabled, viber: config.viber.enabled, backend: new URL(config.backend.url).host,
    });
  });
  let stopping = false;
  const shutdown = (signal: string) => {
    if (stopping) return;
    stopping = true;
    collector.logger.info("collector.stopping", { signal });
    const force = setTimeout(() => process.exit(1), 25_000);
    force.unref();
    collector.stop().then(
      () => process.exit(0),
      () => process.exit(1),
    );
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}

main().catch((err: unknown) => {
  process.stderr.write(`fatal: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
