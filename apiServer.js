import 'dotenv/config';
import { getApp } from './apiApp.js';
import { closeMongo } from './db.js';

async function main() {
  const app = await getApp();
  const port = Number.parseInt(String(process.env.API_PORT || '3001'), 10) || 3001;

  const server = app.listen(port, () => {
    console.log(`[api] listening on :${port}`);
  });

  const shutdown = async () => {
    server.close(() => {});
    await closeMongo().catch(() => {});
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
