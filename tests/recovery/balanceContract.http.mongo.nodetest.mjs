// Contrato do consumidor de saldo (balance-update) e efeito da edição de pagamento no saldo.
//
// Fluxos legítimos que precisam continuar: débito, crédito, baixa (pendente → pago), estorno
// (pago → pendente) e ajuste de valor. Eventos que causavam débito indevido: PAYMENT_UPDATED
// (toda edição lançava o valor cheio), INSURANCE_PAYMENT_AUTO_SETTLED (saldo sem paciente),
// PAYMENT_RECEIVED, BALANCE_UPDATE_REQUESTED e tipo desconhecido. Cada caso roda também
// repetido e em concorrência.
//
// Pela camada HTTP real (express + auth + transação) e pelo despacho real do worker
// (handleBalanceEvent) com o evento que a rota gravou no EventStore. Mongo DESCARTÁVEL em
// replica set e Redis de loopback. Dados fictícios.
//
//   MONGO_TXN_TEST_URI='mongodb://127.0.0.1:27217/?directConnection=true' REDIS_URL=redis://127.0.0.1:6479 \
//     node --test --test-force-exit --test-concurrency=1 tests/recovery/balanceContract.http.mongo.nodetest.mjs
import { test, before, after, beforeEach, describe } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import mongoose from 'mongoose';

const URI = process.env.MONGO_TXN_TEST_URI;
const skip = !URI ? 'MONGO_TXN_TEST_URI não definido' : false;
const loop = (u) => ['127.0.0.1', 'localhost', '::1', '[::1]'].includes(new URL(u).hostname);
if (URI && !loop(URI)) throw new Error('MONGO_TXN_TEST_URI precisa ser loopback');
if (process.env.REDIS_URL && !loop(process.env.REDIS_URL)) throw new Error('REDIS_URL precisa ser loopback');

process.env.JWT_SECRET = 'segredo-de-teste-ficticio';
const oid = () => new mongoose.Types.ObjectId();
let app, Admin, Payment, PatientBalance, Appointment, Session, EventStore, Quarantine, tokenAdmin;
let handleBalanceEvent;

before(async () => {
  if (skip) return;
  await mongoose.connect(URI, { dbName: `crm_contrato_saldo_${Date.now()}` });
  ({ default: Admin } = await import('../../models/Admin.js'));
  ({ default: Payment } = await import('../../models/Payment.js'));
  ({ default: PatientBalance } = await import('../../models/PatientBalance.js'));
  ({ default: Appointment } = await import('../../models/Appointment.js'));
  ({ default: Session } = await import('../../models/Session.js'));
  ({ default: EventStore } = await import('../../models/EventStore.js'));
  ({ default: Quarantine } = await import('../../models/BalanceEventQuarantine.js'));
  const { default: Outbox } = await import('../../infrastructure/outbox/OutboxModel.js');
  const { default: FinancialLedger } = await import('../../models/FinancialLedger.js');
  const { default: PaymentOperation } = await import('../../models/PaymentOperation.js');
  const { default: paymentRouter } = await import('../../routes/payment.v2.js');
  ({ handleBalanceEvent } = await import('../../workers/balanceWorker.js'));
  for (const M of [Payment, PatientBalance, Appointment, Session, Outbox, EventStore, Quarantine, FinancialLedger, PaymentOperation]) {
    await M.createCollection().catch(() => {});
    await M.init();
  }
  app = express();
  app.use(express.json());
  app.use('/api/v2/payments', paymentRouter);
  const adminId = oid();
  await Admin.collection.insertOne({ _id: adminId, name: 'Admin Ficticio', email: 'admin@teste.invalid', role: 'admin' });
  tokenAdmin = jwt.sign({ id: adminId.toString(), role: 'admin' }, process.env.JWT_SECRET, { expiresIn: '30m' });
});

after(async () => {
  if (skip) return;
  await mongoose.connection.db.dropDatabase();
  await mongoose.disconnect();
});

beforeEach(async () => {
  if (skip) return;
  await Promise.all([Payment, PatientBalance, Appointment, Session, EventStore, Quarantine].map((M) => M.collection.deleteMany({})));
});

const patch = (id, body) => request(app).patch(`/api/v2/payments/${id}`).set('Authorization', `Bearer ${tokenAdmin}`).send(body);
const saldo = async (p) => PatientBalance.findOne({ patient: p }).lean();

// Payment pendente vinculado a um atendimento, com o débito de "sessão fiada" correspondente.
async function fiado(amount = 220) {
  const p = oid(), appointmentId = oid(), id = oid(), now = new Date();
  await Payment.collection.insertOne({
    _id: id, patient: p, patientId: String(p), doctor: oid(), amount, status: 'pending', kind: 'session_payment',
    billingType: 'particular', paymentMethod: 'dinheiro', clinicId: 'default', appointment: appointmentId,
    appointmentId: String(appointmentId), serviceDate: now, paymentDate: now, createdAt: now, updatedAt: now
  });
  await PatientBalance.collection.insertOne({
    patient: p, currentBalance: amount, totalDebited: amount, totalCredited: 0,
    transactions: [{ _id: oid(), type: 'debit', amount, paidAmount: 0, description: 'Sessão fictícia', appointmentId, isPaid: false, transactionDate: now }],
    createdAt: now, updatedAt: now
  });
  return { p, id: String(id), appointmentId };
}

// Entrega ao consumidor de saldo cada PAYMENT_UPDATED que a rota gravou no EventStore,
// `vezes` vezes cada (e em paralelo), como faria uma reentrega.
async function entregarEventos(vezes = 1) {
  const evs = await EventStore.find({ eventType: 'PAYMENT_UPDATED' }).lean();
  const rs = [];
  for (const ev of evs) {
    rs.push(...await Promise.all(Array.from({ length: vezes }, () => handleBalanceEvent(ev.eventType, ev.payload, ev.eventId))));
  }
  return { evs, rs };
}

describe('edição de pagamento: só o ajuste correspondente', () => {
  test('edição de dados não movimenta saldo, nem na rota nem no consumidor (3 entregas)', { skip }, async () => {
    const { p, id } = await fiado(220);
    assert.equal((await patch(id, { paymentMethod: 'pix', notes: 'observação fictícia' })).status, 200);
    const { evs, rs } = await entregarEventos(3);
    assert.equal(evs.length, 1);
    assert.equal(evs[0].payload.balanceContract, 2);
    assert.deepEqual(evs[0].payload.changedFields, ['paymentMethod', 'notes']);
    assert.ok(rs.every(r => r.status === 'no_balance_effect'));
    const b = await saldo(p);
    assert.equal(b.currentBalance, 220);
    assert.equal(b.transactions.length, 1);
  });

  test('mudança de valor 220 → 180 ajusta o débito em aberto pela diferença, uma vez', { skip }, async () => {
    const { p, id } = await fiado(220);
    assert.equal((await patch(id, { amount: 180 })).status, 200);
    assert.equal((await patch(id, { amount: 180 })).status, 200); // repetir o mesmo PATCH
    await entregarEventos(3);
    const b = await saldo(p);
    assert.equal(b.currentBalance, 180);
    assert.equal(b.totalDebited, 180);
    assert.equal(b.transactions.length, 1);
    assert.equal(b.transactions[0].amount, 180);
    assert.deepEqual(b.transactions[0].amountAdjustments.map(a => [a.from, a.to]), [[220, 180]]);
  });

  test('concorrência: 6 PATCH simultâneos para o mesmo valor novo ajustam uma vez', { skip }, async () => {
    const { p, id } = await fiado(220);
    const rs = await Promise.all(Array.from({ length: 6 }, () => patch(id, { amount: 250 })));
    assert.ok(rs.some(r => r.status === 200), rs.map(r => r.status).join(','));
    await entregarEventos(2);
    const b = await saldo(p);
    assert.equal(b.currentBalance, 250);
    assert.equal(b.transactions[0].amountAdjustments.length, 1);
  });

  test('mudança de status pendente → pago: só a baixa (antes a dívida voltava)', { skip }, async () => {
    const { p, id } = await fiado(220);
    assert.equal((await patch(id, { status: 'paid', paymentMethod: 'pix' })).status, 200);
    const { evs, rs } = await entregarEventos(3);
    assert.equal(evs[0].payload.status, 'paid');
    assert.equal(evs[0].payload.previousStatus, 'pending');
    assert.ok(rs.every(r => r.status === 'no_balance_effect'));
    const b = await saldo(p);
    assert.equal(b.currentBalance, 0);
    assert.equal(b.transactions.filter(t => t.type === 'debit').length, 1);
  });

  test('valor e status juntos (220 → 250 e pago): débito vira 250 e é quitado inteiro', { skip }, async () => {
    const { p, id } = await fiado(220);
    assert.equal((await patch(id, { amount: 250, status: 'paid', paymentMethod: 'pix' })).status, 200);
    await entregarEventos(2);
    const b = await saldo(p);
    assert.equal(b.currentBalance, 0, JSON.stringify(b));
    const debit = b.transactions.find(t => t.type === 'debit');
    assert.equal(debit.amount, 250);
    assert.equal(debit.isPaid, true);
  });

  test('estorno (pago → pendente) e pagar de novo: nenhum débito novo pelo evento', { skip }, async () => {
    const { p, id } = await fiado(220);
    assert.equal((await patch(id, { status: 'paid', paymentMethod: 'pix' })).status, 200);
    assert.equal((await patch(id, { status: 'pending' })).status, 200);
    await entregarEventos(2);
    const b = await saldo(p);
    assert.equal(b.transactions.filter(t => t.type === 'debit').length, 1);
    assert.equal(b.currentBalance, 0, 'estorno do caixa não recria dívida no saldo');
  });

  test('edições sequenciais de valor (220 → 200 → 180 → 200): cada versão ajusta uma vez, na ordem', { skip }, async () => {
    const { p, id } = await fiado(220);
    for (const v of [200, 180, 200]) assert.equal((await patch(id, { amount: v })).status, 200);
    // Reentrega dos eventos em ordem invertida e repetida: o consumidor não refaz nada.
    const evs = await EventStore.find({ eventType: 'PAYMENT_UPDATED' }).sort({ createdAt: -1 }).lean();
    assert.equal(evs.length, 3);
    assert.equal(new Set(evs.map(e => e.idempotencyKey)).size, 3, 'uma chave por versão do pagamento');
    for (const ev of evs) for (let i = 0; i < 2; i++) assert.equal((await handleBalanceEvent(ev.eventType, ev.payload, ev.eventId)).status, 'no_balance_effect');
    const b = await saldo(p);
    assert.equal(b.currentBalance, 200);
    assert.equal(b.totalDebited, 200);
    assert.equal(b.transactions[0].amount, 200);
    assert.deepEqual(b.transactions[0].amountAdjustments.map(a => [a.from, a.to]), [[220, 200], [200, 180], [180, 200]]);
    // O evento de cada versão leva o valor anterior e o novo daquela versão.
    const pares = evs.reverse().map(e => [e.payload.previousAmount, e.payload.amount]);
    assert.deepEqual(pares, [[220, 200], [200, 180], [180, 200]]);
  });

  test('edições concorrentes com valores diferentes: vale a ordem em que foram gravadas, sem ajuste duplicado', { skip }, async () => {
    for (let rodada = 0; rodada < 3; rodada++) {
      await Promise.all([Payment, PatientBalance, EventStore, Quarantine].map((M) => M.collection.deleteMany({})));
      const { p, id } = await fiado(220);
      const valores = [200, 180, 200, 180, 250, 250, 180, 200];
      // Rodada 0: todas ao mesmo tempo. Rodadas 1 e 2: como a tela faz, quem recebe 409 (retryable)
      // tenta de novo, então várias versões são gravadas intercaladas.
      const comRetry = async (v) => {
        for (let t = 0; t < 8; t++) {
          const r = await patch(id, { amount: v });
          if (r.status !== 409 || rodada === 0) return r;
          await new Promise(res => setTimeout(res, 5 + Math.floor(Math.random() * 25)));
        }
        return patch(id, { amount: v });
      };
      const rs = await Promise.all(valores.map(v => comRetry(v)));
      assert.ok(rs.every(r => r.status === 200 || r.status === 409), rs.map(r => r.status).join(','));
      assert.ok(rs.some(r => r.status === 200));
      const pg = await Payment.findById(id).lean();
      const b = await saldo(p);
      const adj = b.transactions[0].amountAdjustments || [];
      // O débito acompanha o valor final gravado do pagamento.
      assert.equal(b.transactions[0].amount, pg.amount, `rodada ${rodada}`);
      assert.equal(b.currentBalance, pg.amount);
      assert.equal(b.totalDebited, pg.amount);
      // Cadeia contínua: cada ajuste parte do valor deixado pelo anterior (nenhum aplicado duas vezes nem fora de ordem).
      let atual = 220;
      for (const a of adj) { assert.equal(a.from, atual, JSON.stringify(adj)); assert.notEqual(a.to, a.from); atual = a.to; }
      assert.equal(atual, pg.amount);
      console.log(`[teste] rodada ${rodada}: ${rs.filter(r => r.status === 200).length} gravadas, ${rs.filter(r => r.status === 409).length} recusadas por conflito, cadeia ${JSON.stringify(adj.map(a => [a.from, a.to]))}`);
      // Cada edição gravada gerou exatamente um evento com o par (anterior → novo) da sua versão, e eles batem com a cadeia.
      const evs = await EventStore.find({ eventType: 'PAYMENT_UPDATED' }).sort({ createdAt: 1 }).lean();
      const mudancas = evs.filter(e => e.payload.previousAmount !== e.payload.amount).map(e => [e.payload.previousAmount, e.payload.amount]);
      assert.deepEqual(mudancas, adj.map(a => [a.from, a.to]));
      // Reentrega concorrente de todos os eventos: nada muda.
      await entregarEventos(3);
      assert.equal((await saldo(p)).currentBalance, pg.amount);
    }
  });

  test('valor alterado sem correspondência segura (débito parcialmente pago) não ajusta e fica para análise', { skip }, async () => {
    const { p, id } = await fiado(220);
    await PatientBalance.updateOne({ patient: p }, { $set: { 'transactions.0.paidAmount': 100 } });
    assert.equal((await patch(id, { amount: 180 })).status, 200);
    const b = await saldo(p);
    assert.equal(b.currentBalance, 220);
    const q = await Quarantine.find({}).lean();
    assert.equal(q.length, 1);
    assert.equal(q[0].reason, 'debito_parcialmente_pago');
    assert.deepEqual(q[0].detail, { from: 220, to: 180 });
  });
});

describe('eventos fora do contrato: não alteram saldo e ficam preservados', () => {
  const casos = (patientId) => [
    ['PAYMENT_UPDATED', 'payment_updated_sem_contrato', { paymentId: 'p1', patientId, amount: 220, status: 'pending', previousStatus: 'pending' }],
    ['INSURANCE_PAYMENT_AUTO_SETTLED', 'tipo_fora_do_contrato', { paymentId: 'p2', amount: 180, grossAmount: 190, issAmount: 10, reason: 'teste', settledAt: new Date() }],
    ['PAYMENT_RECEIVED', 'tipo_fora_do_contrato', { paymentId: 'p3', patientId, amountReceived: 220 }],
    ['BALANCE_UPDATE_REQUESTED', 'tipo_fora_do_contrato', { patientId, amount: 50, description: 'fictício' }],
    ['EVENTO_QUE_NAO_EXISTE', 'tipo_fora_do_contrato', { patientId }]
  ];

  test('cada tipo, entregue 4 vezes em paralelo: nenhum saldo criado, 1 registro por evento', { skip }, async () => {
    const patientId = String(oid());
    for (const [tipo, motivo, payload] of casos(patientId)) {
      const rs = await Promise.all(Array.from({ length: 4 }, () => handleBalanceEvent(tipo, payload, `evt-${tipo}`)));
      assert.ok(rs.every(r => r.status === 'quarantined' && r.reason === motivo), `${tipo}: ${JSON.stringify(rs)}`);
    }
    assert.equal(await PatientBalance.collection.countDocuments({}), 0);
    const q = await Quarantine.find({}).lean();
    assert.equal(q.length, 5);
    assert.ok(q.every(r => r.deliveries === 4 && r.status === 'open'));
    // Diagnóstico seguro: nomes de campos, não valores.
    const ins = q.find(r => r.eventType === 'INSURANCE_PAYMENT_AUTO_SETTLED');
    assert.deepEqual(ins.payloadFields, ['amount', 'grossAmount', 'issAmount', 'paymentId', 'reason', 'settledAt']);
    assert.equal(JSON.stringify(q).includes('fictício'), false);
  });
});

describe('fluxos legítimos do consumidor continuam', () => {
  test('débito e crédito explícitos movem o saldo; repetir não duplica', { skip }, async () => {
    const patientId = String(oid()), appointmentId = String(oid());
    const deb = { patientId, amount: 220, description: 'Sessão fictícia', appointmentId };
    await handleBalanceEvent('BALANCE_DEBIT_REQUESTED', deb, 'evt-deb');
    await handleBalanceEvent('BALANCE_DEBIT_REQUESTED', deb, 'evt-deb-reentrega');
    let b = await saldo(patientId);
    assert.equal(b.currentBalance, 220);
    const cred = { patientId, amount: 220, description: 'Crédito fictício', idempotencyKey: 'cred-1' };
    await handleBalanceEvent('BALANCE_CREDIT_REQUESTED', cred, 'evt-cred');
    await handleBalanceEvent('BALANCE_CREDIT_REQUESTED', cred, 'evt-cred');
    b = await saldo(patientId);
    assert.equal(b.currentBalance, 0);
  });
});

describe('fila real (BullMQ): evento preservado para análise não volta para a fila', () => {
  test('job fora do contrato termina como concluído na 1ª tentativa, sem retry nem DLQ; reentrega também conclui sem retry', { skip: skip || (!process.env.REDIS_URL && 'REDIS_URL não definido') }, async () => {
    const { startBalanceWorker } = await import('../../workers/balanceWorker.js');
    const { getQueue } = await import('../../infrastructure/queue/queueConfig.js');
    const queue = getQueue('balance-update');
    const dlq = getQueue('dlq');
    await queue.obliterate({ force: true }).catch(() => {});
    await dlq.obliterate({ force: true }).catch(() => {});
    const worker = startBalanceWorker();
    try {
      // Mesmas opções do eventPublisher (attempts 5, backoff exponencial).
      const opts = { attempts: 5, backoff: { type: 'exponential', delay: 1000 } };
      const data = (eventId) => ({ eventId, eventType: 'INSURANCE_PAYMENT_AUTO_SETTLED', payload: { paymentId: 'p-fila', amount: 180 } });
      const j1 = await queue.add('INSURANCE_PAYMENT_AUTO_SETTLED', data('evt-fila-1'), opts);
      const j2 = await queue.add('PAYMENT_UPDATED', { eventId: 'evt-fila-2', eventType: 'PAYMENT_UPDATED', payload: { paymentId: 'p-fila', amount: 220 } }, opts);
      const espera = async (job) => {
        for (let i = 0; i < 100; i++) {
          const st = await job.getState();
          if (st === 'completed' || st === 'failed') return st;
          await new Promise(r => setTimeout(r, 100));
        }
        return 'timeout';
      };
      assert.equal(await espera(j1), 'completed');
      assert.equal(await espera(j2), 'completed');
      // Espera mais que o primeiro backoff (1 s) para provar que nada foi reagendado.
      await new Promise(r => setTimeout(r, 1500));
      const counts = await queue.getJobCounts('failed', 'delayed', 'wait', 'active');
      assert.deepEqual(counts, { failed: 0, delayed: 0, wait: 0, active: 0 });
      assert.equal((await dlq.getJobCounts('wait', 'delayed')).wait, 0);
      const r1 = (await queue.getJob(j1.id));
      assert.equal(r1.returnvalue.status, 'quarantined');
      assert.ok(!r1.failedReason);
      // Reentrega do mesmo evento por um job novo (ex.: republicação): conclui de novo, sem retry.
      const j3 = await queue.add('INSURANCE_PAYMENT_AUTO_SETTLED', data('evt-fila-1'), opts);
      assert.equal(await espera(j3), 'completed');
      const q = await Quarantine.find({ source: 'balance-update' }).sort({ eventId: 1 }).lean();
      assert.deepEqual(q.map(r => [r.eventId, r.eventType, r.deliveries]), [['evt-fila-1', 'INSURANCE_PAYMENT_AUTO_SETTLED', 1], ['evt-fila-2', 'PAYMENT_UPDATED', 1]]);
      assert.equal(await PatientBalance.collection.countDocuments({}), 0);
    } finally {
      await worker.close();
      await queue.obliterate({ force: true }).catch(() => {});
    }
  });
});
