#!/usr/bin/env node
// Servidor ISOLADO para validar o conjunto front + back dos pagamentos.
//
// Sobe só as rotas de pagamento (/api/v2/payments, /api/v2/financial) e o
// worker de pagamentos, contra Mongo e Redis DESCARTÁVEIS em loopback, com um
// usuário e um paciente fictícios. Não lê .env, recusa host que não seja
// loopback e não chama WhatsApp, e-mail, Atlas ou Render.
//
// Simulação de falhas (só neste servidor):
//   POST /__caos/perder-respostas {"n": 1}
//     as próximas N respostas de POST financeiro são descartadas DEPOIS que o
//     servidor gravou (o cliente vê erro de rede: "timeout após gravação").
//   POST /__caos/atraso {"ms": 800}
//     atraso antes de cada POST financeiro (para clique duplo e concorrência).
//   POST /__caos/derrubar
//     mata o processo com SIGKILL (API e worker juntos, como uma queda). Use com
//     scripts/e2e/validar-front-back.sh, que reinicia o servidor mantendo o banco.
//   GET  /__estado/:patientId
//     contagem de Payments, recibos, saldo e payment_operations do paciente.
//
// Uso:
//   E2E_MONGO_URI='mongodb://127.0.0.1:27217/crm_e2e?directConnection=true' \
//   REDIS_URL=redis://127.0.0.1:6479 PORT=5055 node scripts/e2e/servidor-pagamentos-isolado.mjs
import express from 'express';
import cors from 'cors';
import jwt from 'jsonwebtoken';
import mongoose from 'mongoose';

const LOOP = ['127.0.0.1', 'localhost', '::1', '[::1]'];
const MONGO = process.env.E2E_MONGO_URI;
if (!MONGO || !LOOP.includes(new URL(MONGO).hostname)) {
  console.error('E2E_MONGO_URI precisa apontar para um Mongo de loopback (descartável).');
  process.exit(2);
}
if (!process.env.REDIS_URL || !LOOP.includes(new URL(process.env.REDIS_URL).hostname)) {
  console.error('REDIS_URL precisa apontar para um Redis de loopback (descartável).');
  process.exit(2);
}
const dbName = new URL(MONGO).pathname.replace('/', '') || 'crm_e2e';
if (!/^crm_e2e/.test(dbName)) {
  console.error('O banco precisa começar com crm_e2e (é apagado a cada início).');
  process.exit(2);
}
process.env.JWT_SECRET = 'segredo-e2e-ficticio';
process.env.NODE_ENV = process.env.NODE_ENV || 'test';
const PORT = Number(process.env.PORT || 5055);

await mongoose.connect(MONGO);
const KEEP = process.env.E2E_KEEP_DB === '1';
if (!KEEP) await mongoose.connection.db.dropDatabase();

const { default: Admin } = await import('../../models/Admin.js');
const { default: Payment } = await import('../../models/Payment.js');
const { default: PatientBalance } = await import('../../models/PatientBalance.js');
const { default: PaymentOperation } = await import('../../models/PaymentOperation.js');
const { default: EventStore } = await import('../../models/EventStore.js');
const { default: Appointment } = await import('../../models/Appointment.js');
const { default: Session } = await import('../../models/Session.js');
const { default: Outbox } = await import('../../infrastructure/outbox/OutboxModel.js');
const { default: FinancialLedger } = await import('../../models/FinancialLedger.js');
const { CORS_ALLOWED_HEADERS } = await import('../../config/corsAllowedHeaders.js');
for (const M of [Payment, PatientBalance, PaymentOperation, EventStore, Appointment, Session, Outbox, FinancialLedger]) {
  await M.createCollection().catch(() => {});
  await M.init();
}
const { default: paymentV2Routes } = await import('../../routes/payment.v2.js');
const { default: financialRoutes } = await import('../../routes/financialSummary.js');
const { startPaymentWorker } = await import('../../workers/paymentWorker.js');

// IDs fixos: o reinício (E2E_KEEP_DB=1) reaproveita o mesmo usuário e paciente.
const adminId = new mongoose.Types.ObjectId('0000000000000000000e2e01');
const patientId = new mongoose.Types.ObjectId('0000000000000000000e2e02');
await Admin.collection.updateOne({ _id: adminId }, { $setOnInsert: { name: 'Secretaria Ficticia', email: 'sec@teste.invalid', role: 'secretary' } }, { upsert: true });
await mongoose.connection.db.collection('patients').updateOne({ _id: patientId }, { $setOnInsert: { fullName: 'Paciente Ficticio E2E', phone: '5500000000000' } }, { upsert: true });
const token = jwt.sign({ id: String(adminId), role: 'secretary' }, process.env.JWT_SECRET, { expiresIn: '12h' });

const caos = { perder: 0, atrasoMs: 0 };
const app = express();
app.use(cors({ origin: true, credentials: true, allowedHeaders: [...CORS_ALLOWED_HEADERS] }));
app.use(express.json());
app.post('/__caos/perder-respostas', (req, res) => { caos.perder = Number(req.body?.n || 0); res.json(caos); });
app.post('/__caos/atraso', (req, res) => { caos.atrasoMs = Number(req.body?.ms || 0); res.json(caos); });
app.post('/__caos/derrubar', (req, res) => {
  res.json({ derrubando: true });
  setTimeout(() => process.kill(process.pid, 'SIGKILL'), 50);
});
app.get('/__saude', (req, res) => res.json({ ok: true, pid: process.pid }));
app.get('/__estado/:patientId', async (req, res) => {
  const p = new mongoose.Types.ObjectId(req.params.patientId);
  res.json({
    payments: await Payment.countDocuments({ patient: p, kind: { $ne: 'monthly_settlement' } }),
    paid: await Payment.countDocuments({ patient: p, status: 'paid', kind: { $ne: 'monthly_settlement' } }),
    recibos: await Payment.countDocuments({ patient: p, kind: 'monthly_settlement' }),
    saldo: (await PatientBalance.findOne({ patient: p }).lean())?.currentBalance ?? 0,
    creditado: (await PatientBalance.findOne({ patient: p }).lean())?.totalCredited ?? 0,
    operacoes: await PaymentOperation.countDocuments({ patient: p })
  });
});
app.use(async (req, res, next) => {
  const financeiro = req.method === 'POST' && /^\/api\/v2\/(payments|financial)\//.test(req.path);
  if (!financeiro) return next();
  if (caos.atrasoMs) await new Promise((r) => setTimeout(r, caos.atrasoMs));
  if (caos.perder > 0) {
    caos.perder--;
    // A rota roda e grava normalmente; só a resposta não chega ao cliente.
    res.end = function () { req.socket.destroy(); return this; };
  }
  next();
});
app.use('/api/v2/payments', paymentV2Routes);
app.use('/api/v2/financial', financialRoutes);

const worker = startPaymentWorker();
const server = app.listen(PORT, '127.0.0.1', () => {
  console.log(JSON.stringify({ pronto: true, base: `http://127.0.0.1:${PORT}/api`, token, patientId: String(patientId), db: dbName }));
});

const stop = async () => { server.close(); await worker?.close?.(); await mongoose.disconnect(); process.exit(0); };
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
