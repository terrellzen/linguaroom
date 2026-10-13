import { createApp } from "./app.js";
try {
  const { app, cfg } = await createApp();
  const shutdown = async () => {
    await app.close();
    process.exit(0);
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
  await app.listen({ port: cfg.PORT, host: cfg.BIND });
} catch (error) {
  console.error(error instanceof Error ? error.message : "Startup failed");
  process.exit(1);
}
