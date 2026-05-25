import crypto from 'crypto';
import express from 'express';
import { config } from './config';
import { router } from './proxy/routes';
import { log } from './logger';

const app = express();
app.use(express.json({ limit: '25mb' }));

app.use((req, res, next) => {
  res.locals.reqId = crypto.randomUUID().slice(0, 8);
  res.locals.startAt = Date.now();
  log.info(`→ ${req.method} ${req.path} [${res.locals.reqId as string}]`);
  res.on('finish', () => {
    const ms = Date.now() - (res.locals.startAt as number);
    const level = res.statusCode >= 500 ? 'error' : res.statusCode >= 400 ? 'warn' : 'info';
    log[level](`← ${req.method} ${req.path} ${res.statusCode} ${ms}ms [${res.locals.reqId as string}]`);
  });
  next();
});

app.use(router);

const server = app.listen(config.port, () => {
  const modelList = config.models.map((m) => (m.slug !== m.id ? `${m.id} → ${m.slug}` : m.id)).join(', ');
  console.log(`\nCodeMie proxy  →  http://localhost:${config.port}`);
  console.log(`Auth type      :  ${config.authType}`);
  console.log(`CodeMie server :  ${config.serverUrl}`);
  console.log(`Models         :  ${modelList}`);
  console.log(`Auth cache     :  ${config.authCachePath}\n`);
});

// Track open connections so we can destroy them on shutdown.
const connections = new Set<import('net').Socket>();
server.on('connection', (socket) => {
  connections.add(socket);
  socket.once('close', () => connections.delete(socket));
});

function shutdown(signal: string): void {
  log.info(`${signal} received — shutting down`);
  server.close((err) => {
    if (err) log.error(`Error during shutdown: ${err.message}`);
    else log.info('Server closed');
    process.exit(err ? 1 : 0);
  });
  // Destroy keep-alive connections so server.close() doesn't wait for them.
  for (const socket of connections) socket.destroy();
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
