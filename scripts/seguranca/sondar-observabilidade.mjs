#!/usr/bin/env node
// Sonda SEM TOKEN todas as rotas GET dos routers de observabilidade/diagnóstico
// e imprime o status. Isolado: Mongo e Redis de loopback, dados vazios.
//   AUD_MONGO_URI='mongodb://127.0.0.1:27217/crm_aud?directConnection=true' REDIS_URL=redis://127.0.0.1:6479 \
//     node scripts/seguranca/sondar-observabilidade.mjs [--json]
import express from 'express';
import request from 'supertest';
import mongoose from 'mongoose';

const LOOP = ['127.0.0.1', 'localhost', '::1'];
const URI = process.env.AUD_MONGO_URI;
if (!URI || !LOOP.includes(new URL(URI).hostname)) { console.error('AUD_MONGO_URI loopback obrigatório'); process.exit(2); }
if (!process.env.REDIS_URL || !LOOP.includes(new URL(process.env.REDIS_URL).hostname)) { console.error('REDIS_URL loopback obrigatório'); process.exit(2); }
process.env.JWT_SECRET = 'segredo-auditoria-ficticio';
await mongoose.connect(URI);

export const MOUNTS = [
  ['/api/health', './routes/health.js'],
  ['/api/v2/health', './routes/health.v2.js'],
  ['/api/health', './routes/health.migration.js'],
  ['/api/admin', './routes/adminSystem.js'],
  ['/api/admin/whatsapp-queue', './routes/adminWhatsappQueue.routes.js'],
  ['/api/diagnostic', './routes/whatsapp/diagnostic.js'],
  ['/api/financial/v2', './routes/financial/metrics.routes.js'],
  ['/api/metrics', './routes/metrics.dashboard.js'],
  ['/api/metrics/packages', './routes/package.metrics.js'],
  ['/api/sync', './routes/sync.js'],
  ['/api/observability', './infrastructure/observability/observabilityRoutes.js'],
  ['/api/v2/admin/financial-metrics', './routes/admin/financialMetrics.routes.js'],
];

const rows = [];
for (const [base, file] of MOUNTS) {
  let mod;
  try { mod = await import(new URL(`../../${file.slice(2)}`, import.meta.url)); }
  catch (e) { rows.push({ method: '-', url: base, file, status: `nao_carregou:${(e.code || e.message).slice(0, 40)}` }); continue; }
  const router = mod.default;
  const app = express();
  app.use(express.json());
  app.use(base, router);
  if (file.endsWith('adminSystem.js') && mod.serverAdapter) {
    // Mesma montagem do server.js (com a guarda, quando ela existe nesta versão).
    let guard = (req, res, next) => next();
    try { guard = (await import(new URL('../../middleware/observabilityAccess.js', import.meta.url))).bullBoardGuard || guard; } catch { /* versão sem guarda */ }
    app.use('/admin/queues', guard, mod.serverAdapter.getRouter());
  }
  const routes = [];
  for (const layer of router.stack || []) {
    if (!layer.route) continue;
    for (const m of Object.keys(layer.route.methods)) routes.push([m.toUpperCase(), layer.route.path]);
  }
  if (file.endsWith('adminSystem.js') && mod.serverAdapter) routes.push(['GET', '__bullboard__']);
  for (const [method, path] of routes) {
    const url = path === '__bullboard__' ? '/admin/queues' : base + String(path).replace(/:([A-Za-z]+)/g, 'x000000000000000000000001');
    let status;
    try {
      const r = await request(app)[method.toLowerCase()](url).timeout({ response: 8000 });
      status = r.status;
    } catch (e) { status = `erro:${e.code || e.message}`.slice(0, 30); }
    rows.push({ method, url, file, status, aberta: typeof status === 'number' && status < 400 || status === 404 && false });
  }
}
await mongoose.disconnect();
if (process.argv.includes('--json')) console.log(JSON.stringify(rows, null, 1));
else for (const r of rows) console.log(`${String(r.status).padEnd(6)} ${r.method.padEnd(6)} ${r.url}  (${r.file})`);
process.exit(0);
