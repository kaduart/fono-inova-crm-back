// tests/insurance/legacyMigration.integration.test.js
//
// Testes do CAMINHO DE ESCRITA da migração legada, contra Mongo real em memória
// com replica set (transação exige). Os testes de função pura vivem em
// migrateLegacyBatchesToInvoices.test.js — estes provam o que aquele não podia:
// que os lotes nascem, as sessões migram, os originais viram superseded, e que
// uma falha no meio não deixa estado parcial.
//
// O que está sendo protegido é faturamento histórico. Um rollback que não
// reverte deixa sessões apontando para lote que não existe; uma segunda execução
// que não é idempotente duplica NF; e um ledger criado aqui lança receita de
// março na competência de hoje.

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import mongoose from 'mongoose';
import { MongoMemoryReplSet } from 'mongodb-memory-server';

vi.mock('../../utils/logger.js', () => ({
  createContextLogger: vi.fn(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }))
}));
vi.mock('../../infrastructure/outbox/outboxPattern.js', () => ({
  saveToOutbox: vi.fn(async () => ({}))
}));

import { saveToOutbox } from '../../infrastructure/outbox/outboxPattern.js';
import InsuranceBatch from '../../models/InsuranceBatch.js';
import Session from '../../models/Session.js';
import Payment from '../../models/Payment.js';
import Appointment from '../../models/Appointment.js';
import InsuranceGuide from '../../models/InsuranceGuide.js';
import Patient from '../../models/Patient.js';
import FinancialLedger from '../../models/FinancialLedger.js';
import { migrateLegacyBatchesToInvoices } from '../../services/insuranceGuide/migrateLegacyBatchesToInvoices.js';
import { voidLegacyInsuranceBatches } from '../../services/insuranceGuide/voidLegacyInsuranceBatches.js';

let replSet;
const USER = new mongoose.Types.ObjectId();

beforeAll(async () => {
  replSet = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  await mongoose.connect(replSet.getUri());
}, 90_000);

afterAll(async () => {
  await mongoose.disconnect();
  if (replSet) await replSet.stop();
}, 90_000);

beforeEach(async () => {
  for (const m of [InsuranceBatch, Session, Payment, Appointment, InsuranceGuide, Patient]) {
    await m.deleteMany({});
  }
  // FinancialLedger tem trava de imutabilidade no middleware do mongoose
  // (`[AUDIT LOCK] ... Exclusão em massa não é permitida`). A limpeza entre
  // testes passa pelo driver nativo de propósito — o teste precisa medir se a
  // migração criou lançamento, e a trava é justamente o que queremos preservar
  // em produção.
  await mongoose.connection.db.collection('financial_ledger').deleteMany({}).catch(() => {});
  saveToOutbox.mockClear();
});

// ─── Fábrica de cenário legado ────────────────────────────────────────────────
/**
 * Cria um lote legado com N sessões. `spec` = [{ patientName, date, gross }].
 * Devolve o lote e os ids, já com Payment billed e Appointment coerente.
 */
const DOCTOR = new mongoose.Types.ObjectId();
const ESPECIALIDADE = 'fonoaudiologia';

async function criarLoteLegado(spec, { provider = 'unimed-anapolis', omitirAppointmentNoItem = false } = {}) {
  const items = [];
  for (const s of spec) {
    let patient = await Patient.findOne({ fullName: s.patientName });
    if (!patient) patient = await Patient.create({ fullName: s.patientName });

    const guide = await InsuranceGuide.create({
      number: s.guideNumber || `G${Math.floor(Math.random() * 1e9)}`,
      patientId: patient._id, insurance: provider, specialty: ESPECIALIDADE,
      totalSessions: 20, expiresAt: new Date('2027-12-31'), sessionValue: s.gross
    });
    const appointment = await Appointment.create({
      patient: patient._id, doctor: DOCTOR, date: new Date(s.date),
      specialty: ESPECIALIDADE, operationalStatus: 'scheduled'
    });
    const session = await Session.create({
      patient: patient._id, doctor: DOCTOR, date: new Date(s.date),
      sessionType: ESPECIALIDADE, status: 'completed',
      sessionValue: s.gross, insuranceGuide: guide._id, appointmentId: appointment._id
    });
    const payment = await Payment.create({
      patient: patient._id, session: session._id, amount: s.gross,
      paymentDate: new Date(s.date), paymentMethod: 'convenio',
      billingType: 'convenio', status: 'billed',
      insurance: { status: 'billed', grossAmount: s.gross }
    });
    items.push({
      session: session._id, sessionDate: session.date,
      appointment: omitirAppointmentNoItem ? undefined : appointment._id,
      guide: guide._id, payment: payment._id,
      grossAmount: s.gross, netAmount: s.gross, status: 'sent'
    });
  }
  const dates = spec.map(s => new Date(s.date)).sort((a, b) => a - b);
  const batch = await InsuranceBatch.create({
    batchNumber: `LOT-${Date.now()}-${Math.random()}`,
    insuranceProvider: provider,
    startDate: dates[0], endDate: dates[dates.length - 1], sentDate: dates[0],
    sessions: items,
    totalGross: spec.reduce((a, s) => a + s.gross, 0),
    totalNet: spec.reduce((a, s) => a + s.gross, 0),
    totalSessions: spec.length, status: 'sent'
  });
  await Session.updateMany({ _id: { $in: items.map(i => i.session) } }, { $set: { billingBatchId: batch._id } });
  return batch;
}

// ─── 1 e 2: criação, vínculo e superseded ─────────────────────────────────────
describe('🔀 Split e substituição', () => {
  it('lote com 2 pacientes e 2 competências vira 4 NFs, sessões remapeadas e original superseded', async () => {
    const batch = await criarLoteLegado([
      { patientName: 'Ana Silva', date: '2026-03-10T12:00:00Z', gross: 80 },
      { patientName: 'Ana Silva', date: '2026-04-10T12:00:00Z', gross: 80 },
      { patientName: 'Bruno Costa', date: '2026-03-11T12:00:00Z', gross: 100 },
      { patientName: 'Bruno Costa', date: '2026-04-11T12:00:00Z', gross: 100 }
    ]);

    const r = await migrateLegacyBatchesToInvoices({
      userId: USER.toString(), dryRun: false, sourceBatchIds: [batch._id.toString()]
    });

    expect(r.blocked).toBe(false);
    expect(r.written).toBe(true);
    expect(r.created).toHaveLength(4);

    const numeros = r.created.map(c => c.invoiceNumber).sort();
    expect(numeros).toEqual([
      'ANA_SILVA-ABRIL_2026', 'ANA_SILVA-MARCO_2026',
      'BRUNO_COSTA-ABRIL_2026', 'BRUNO_COSTA-MARCO_2026'
    ]);

    // 2. original marcado
    const original = await InsuranceBatch.findById(batch._id).lean();
    expect(original.status).toBe('superseded');
    expect(original.statusBeforeInvalidation).toBe('sent');
    expect(original.supersededByBatchIds).toHaveLength(4);
    expect(original.supersededAt).toBeInstanceOf(Date);

    // 1. sessões remapeadas, nenhuma no lote antigo
    const novos = r.created.map(c => new mongoose.Types.ObjectId(c.batchId));
    expect(await Session.countDocuments({ billingBatchId: { $in: novos } })).toBe(4);
    expect(await Session.countDocuments({ billingBatchId: batch._id })).toBe(0);

    // ISS explícito zero — senão a baixa aplica a alíquota atual
    for (const c of r.created) {
      const nb = await InsuranceBatch.findById(c.batchId).lean();
      expect(nb.issRate).toBe(0);
      expect(nb.issAmount).toBe(0);
      expect(nb.totalNet).toBe(nb.totalGross);
      expect(nb.receivedAmount).toBe(0);
      expect(nb.receivedAt).toBeNull();
      expect(nb.origin).toBe('legacy_reconciliation');
      expect(nb.sourceLegacyBatchIds.map(String)).toContain(batch._id.toString());
      expect(nb.sessions.reduce((s, i) => s + i.grossAmount, 0)).toBe(nb.totalGross);
      expect(nb.sessions.every(i => i.netAmount === i.grossAmount)).toBe(true);
    }
  }, 60_000);

  it('REGRESSÃO: lote de origem com item inválido pelo schema atual ainda vira superseded', async () => {
    // Caso real 69ea13db: item legado com `sessions[].appointment` nulo, e o
    // campo é `required`. Marcar como superseded via `.save()` dispara validação
    // do documento INTEIRO e aborta a migração — o lote antigo é justamente o
    // que não está íntegro, e é por isso que está sendo aposentado.
    const batch = await criarLoteLegado([
      { patientName: 'Ana Silva', date: '2026-03-10T12:00:00Z', gross: 80 }
    ]);
    // Remove o `appointment` do item pelo driver nativo, contornando a validação
    // do mongoose — é exatamente o estado em que o script legado deixou o 69ea13db.
    // A sessão continua válida e o appointment é recuperável por Session.appointmentId.
    await InsuranceBatch.collection.updateOne(
      { _id: batch._id },
      { $unset: { 'sessions.0.appointment': '' } }
    );

    const r = await migrateLegacyBatchesToInvoices({
      userId: USER.toString(), dryRun: false, sourceBatchIds: [batch._id.toString()]
    });

    expect(r.blocked).toBe(false);
    expect(r.written).toBe(true);
    const original = await InsuranceBatch.findById(batch._id).lean();
    expect(original.status).toBe('superseded');
    expect(original.statusBeforeInvalidation).toBe('sent');
  }, 60_000);

  it('sessões do mesmo paciente/competência vindas de 3 lotes viram UMA NF', async () => {
    const b1 = await criarLoteLegado([{ patientName: 'Davi Felipe', date: '2026-03-09T12:00:00Z', gross: 140 }]);
    const b2 = await criarLoteLegado([{ patientName: 'Davi Felipe', date: '2026-03-25T12:00:00Z', gross: 140 }]);
    const b3 = await criarLoteLegado([{ patientName: 'Davi Felipe', date: '2026-03-30T12:00:00Z', gross: 140 }]);

    const r = await migrateLegacyBatchesToInvoices({
      userId: USER.toString(), dryRun: false,
      sourceBatchIds: [b1, b2, b3].map(b => b._id.toString())
    });

    expect(r.created).toHaveLength(1);
    expect(r.created[0].invoiceNumber).toBe('DAVI_FELIPE-MARCO_2026');
    expect(r.created[0].sessions).toBe(3);
    expect(r.created[0].totalGross).toBe(420);

    for (const b of [b1, b2, b3]) {
      const o = await InsuranceBatch.findById(b._id).lean();
      expect(o.status).toBe('superseded');
    }
  }, 60_000);
});

// ─── 11 e 12: nenhum efeito financeiro ────────────────────────────────────────
describe('💵 A migração não toca dinheiro', () => {
  it('não cria FinancialLedger e não altera nenhum Payment', async () => {
    const batch = await criarLoteLegado([
      { patientName: 'Ana Silva', date: '2026-03-10T12:00:00Z', gross: 80 },
      { patientName: 'Ana Silva', date: '2026-03-17T12:00:00Z', gross: 80 }
    ]);
    const antes = await Payment.find({}).lean();

    await migrateLegacyBatchesToInvoices({
      userId: USER.toString(), dryRun: false, sourceBatchIds: [batch._id.toString()]
    });

    expect(await FinancialLedger.countDocuments({})).toBe(0);

    const depois = await Payment.find({}).lean();
    expect(depois).toHaveLength(antes.length);
    for (const p of depois) {
      const a = antes.find(x => x._id.toString() === p._id.toString());
      expect(p.status).toBe(a.status);
      expect(p.insurance.status).toBe(a.insurance.status);
      expect(p.amount).toBe(a.amount);
      expect(p.insurance.receivedAmount ?? 0).toBe(a.insurance.receivedAmount ?? 0);
    }

    // nenhum evento de faturamento; só substituição
    const tipos = saveToOutbox.mock.calls.map(c => c[0].eventType);
    expect(tipos).toContain('INSURANCE_BATCH_SUPERSEDED');
    expect(tipos).not.toContain('INSURANCE_BATCH_SENT');
  }, 60_000);
});

// ─── 3 e 4: rollback ──────────────────────────────────────────────────────────
describe('↩️  Rollback integral', () => {
  it('Appointment divergente bloqueia antes de escrever qualquer coisa', async () => {
    const batch = await criarLoteLegado([
      { patientName: 'Ana Silva', date: '2026-03-10T12:00:00Z', gross: 80 },
      { patientName: 'Ana Silva', date: '2026-03-17T12:00:00Z', gross: 80 }
    ]);
    // aponta o item para um Appointment de OUTRO paciente
    const outro = await Patient.create({ fullName: 'Carlos Dias' });
    // Outro profissional: `unique_appointment_slot` (doctor+date+time) impede
    // dois agendamentos do mesmo profissional no mesmo horário.
    const apptErrado = await Appointment.create({
      patient: outro._id, doctor: new mongoose.Types.ObjectId(),
      date: new Date('2026-03-10T12:00:00Z'),
      specialty: ESPECIALIDADE, operationalStatus: 'scheduled'
    });
    await InsuranceBatch.updateOne(
      { _id: batch._id },
      { $set: { 'sessions.0.appointment': apptErrado._id } }
    );

    const r = await migrateLegacyBatchesToInvoices({
      userId: USER.toString(), dryRun: false, sourceBatchIds: [batch._id.toString()]
    });

    expect(r.blocked).toBe(true);
    expect(r.conflicts.some(c => c.code === 'LEGACY_APPOINTMENT_INTEGRITY_CONFLICT')).toBe(true);

    // nada escrito
    expect(await InsuranceBatch.countDocuments({ origin: 'legacy_reconciliation' })).toBe(0);
    const o = await InsuranceBatch.findById(batch._id).lean();
    expect(o.status).toBe('sent');
    expect(await Session.countDocuments({ billingBatchId: batch._id })).toBe(2);
  }, 60_000);

  it('sessão movida para fora do lote de origem bloqueia', async () => {
    const batch = await criarLoteLegado([{ patientName: 'Ana Silva', date: '2026-03-10T12:00:00Z', gross: 80 }]);
    const outro = await InsuranceBatch.create({
      batchNumber: 'OUTRO', insuranceProvider: 'unimed-anapolis',
      startDate: new Date(), endDate: new Date(), status: 'sent'
    });
    await Session.updateMany({ billingBatchId: batch._id }, { $set: { billingBatchId: outro._id } });

    const r = await migrateLegacyBatchesToInvoices({
      userId: USER.toString(), dryRun: false, sourceBatchIds: [batch._id.toString()]
    });

    expect(r.blocked).toBe(true);
    expect(r.conflicts.some(c => c.code === 'LEGACY_SESSION_MOVED')).toBe(true);
    expect(await InsuranceBatch.countDocuments({ origin: 'legacy_reconciliation' })).toBe(0);
  }, 60_000);
});

// ─── 6 e 7: idempotência e estado parcial ─────────────────────────────────────
describe('🔁 Idempotência', () => {
  it('segunda execução retorna idempotent e não cria nada', async () => {
    const batch = await criarLoteLegado([
      { patientName: 'Ana Silva', date: '2026-03-10T12:00:00Z', gross: 80 }
    ]);
    const ids = [batch._id.toString()];

    const primeira = await migrateLegacyBatchesToInvoices({ userId: USER.toString(), dryRun: false, sourceBatchIds: ids });
    expect(primeira.created).toHaveLength(1);
    const totalDepois = await InsuranceBatch.countDocuments({});

    const segunda = await migrateLegacyBatchesToInvoices({ userId: USER.toString(), dryRun: false, sourceBatchIds: ids });
    expect(segunda.idempotent).toBe(true);
    expect(segunda.blocked).toBe(false);
    expect(segunda.created).toBeUndefined();
    expect(await InsuranceBatch.countDocuments({})).toBe(totalDepois);
  }, 60_000);

  it('estado parcial (um migrado, um não) bloqueia', async () => {
    const b1 = await criarLoteLegado([{ patientName: 'Ana Silva', date: '2026-03-10T12:00:00Z', gross: 80 }]);
    const b2 = await criarLoteLegado([{ patientName: 'Bruno Costa', date: '2026-03-11T12:00:00Z', gross: 80 }]);

    await migrateLegacyBatchesToInvoices({ userId: USER.toString(), dryRun: false, sourceBatchIds: [b1._id.toString()] });

    const r = await migrateLegacyBatchesToInvoices({
      userId: USER.toString(), dryRun: false, sourceBatchIds: [b1._id.toString(), b2._id.toString()]
    });
    expect(r.blocked).toBe(true);
    expect(r.conflicts[0].code).toBe('LEGACY_MIGRATION_PARTIAL_STATE');
  }, 60_000);
});

// ─── 14: divergência de valor ─────────────────────────────────────────────────
describe('⚖️  Divergência de valor exige override', () => {
  async function cenarioDivergente() {
    const batch = await criarLoteLegado([{ patientName: 'Ana Silva', date: '2026-05-10T12:00:00Z', gross: 100 }]);
    // canônico vale 80, embutido vale 100 → diferença de 20
    await Payment.updateMany({}, { $set: { amount: 80, 'insurance.grossAmount': 80 } });
    return batch;
  }

  it('sem override, bloqueia e informa os dois valores', async () => {
    const batch = await cenarioDivergente();
    const r = await migrateLegacyBatchesToInvoices({
      userId: USER.toString(), dryRun: false, sourceBatchIds: [batch._id.toString()]
    });
    expect(r.blocked).toBe(true);
    const c = r.conflicts.find(x => x.code === 'NEEDS_HISTORICAL_VALUE_DECISION');
    expect(c).toBeDefined();
    expect(r.valueDecisions[0]).toMatchObject({ documentedGross: 100, canonicalPaymentGross: 80, difference: 20 });
    expect(await InsuranceBatch.countDocuments({ origin: 'legacy_reconciliation' })).toBe(0);
  }, 60_000);

  it('override sem reason/evidence não destrava', async () => {
    const batch = await cenarioDivergente();
    const r = await migrateLegacyBatchesToInvoices({
      userId: USER.toString(), dryRun: false, sourceBatchIds: [batch._id.toString()],
      historicalOverrides: { [batch._id.toString()]: { acceptedGross: 100 } }
    });
    expect(r.blocked).toBe(true);
  }, 60_000);

  it('override para o canônico reescreve os ITENS, mantendo soma == total', async () => {
    const batch = await cenarioDivergente();
    const r = await migrateLegacyBatchesToInvoices({
      userId: USER.toString(), dryRun: false, sourceBatchIds: [batch._id.toString()],
      historicalOverrides: {
        [batch._id.toString()]: { acceptedGross: 80, reason: 'guia confirma 80', evidence: 'NF em papel' }
      }
    });
    expect(r.blocked).toBe(false);
    const novo = await InsuranceBatch.findById(r.created[0].batchId).lean();
    expect(novo.totalGross).toBe(80);
    expect(novo.sessions[0].grossAmount).toBe(80);
    expect(novo.sessions[0].netAmount).toBe(80);
    expect(novo.sessions.reduce((s, i) => s + i.grossAmount, 0)).toBe(novo.totalGross);
  }, 60_000);
});

// ─── G: allowlist obrigatória para escrita ────────────────────────────────────
describe('🔒 Allowlist', () => {
  it('escrita sem sourceBatchIds é recusada', async () => {
    await criarLoteLegado([{ patientName: 'Ana Silva', date: '2026-03-10T12:00:00Z', gross: 80 }]);
    const r = await migrateLegacyBatchesToInvoices({ userId: USER.toString(), dryRun: false });
    expect(r.blocked).toBe(true);
    expect(r.conflicts[0].code).toBe('LEGACY_MIGRATION_ALLOWLIST_REQUIRED');
    expect(await InsuranceBatch.countDocuments({ origin: 'legacy_reconciliation' })).toBe(0);
  }, 60_000);
});

// ─── 8: voided ────────────────────────────────────────────────────────────────
describe('🗑️  Invalidação de lotes órfãos', () => {
  async function loteOrfao() {
    return InsuranceBatch.create({
      batchNumber: `ORFAO-${Date.now()}-${Math.random()}`,
      insuranceProvider: 'unimed-campinas',
      startDate: new Date('2026-07-18'), endDate: new Date('2026-07-18'),
      sessions: [{
        session: new mongoose.Types.ObjectId(), appointment: new mongoose.Types.ObjectId(),
        guide: new mongoose.Types.ObjectId(), grossAmount: 140, netAmount: 140, status: 'sent'
      }],
      totalGross: 140, totalNet: 140, totalSessions: 1, receivedAmount: 0, status: 'sent'
    });
  }

  it('invalida preservando o documento e o status anterior', async () => {
    const b = await loteOrfao();
    const r = await voidLegacyInsuranceBatches({
      batchIds: [b._id.toString()], userId: USER.toString(), reason: 'lote de teste órfão', dryRun: false
    });
    expect(r.written).toBe(true);
    const d = await InsuranceBatch.findById(b._id).lean();
    expect(d).not.toBeNull();
    expect(d.status).toBe('voided');
    expect(d.statusBeforeInvalidation).toBe('sent');
    expect(d.voidReason).toBe('lote de teste órfão');
    expect(saveToOutbox.mock.calls.map(c => c[0].eventType)).toContain('INSURANCE_BATCH_VOIDED');
  }, 60_000);

  it('segunda execução é idempotente', async () => {
    const b = await loteOrfao();
    const ids = [b._id.toString()];
    await voidLegacyInsuranceBatches({ batchIds: ids, userId: USER.toString(), reason: 'x', dryRun: false });
    const r2 = await voidLegacyInsuranceBatches({ batchIds: ids, userId: USER.toString(), reason: 'x', dryRun: false });
    expect(r2.idempotent).toBe(true);
    expect(r2.written).toBe(false);
  }, 60_000);

  it('bloqueia se existir Session viva apontando para o lote', async () => {
    const b = await loteOrfao();
    const p = await Patient.create({ fullName: 'Ana Silva' });
    await Session.create({
      patient: p._id, doctor: DOCTOR, date: new Date(), sessionType: ESPECIALIDADE,
      status: 'completed', billingBatchId: b._id
    });

    const r = await voidLegacyInsuranceBatches({
      batchIds: [b._id.toString()], userId: USER.toString(), reason: 'x', dryRun: false
    });
    expect(r.blocked).toBe(true);
    expect(r.conflicts[0].blockers.some(x => x.code === 'VOID_BATCH_HAS_LIVE_SESSION')).toBe(true);
    expect((await InsuranceBatch.findById(b._id).lean()).status).toBe('sent');
  }, 60_000);

  it('bloqueia se o lote tiver NF', async () => {
    const b = await loteOrfao();
    await InsuranceBatch.updateOne({ _id: b._id }, { $set: { invoiceNumber: 'NF-123' } });
    const r = await voidLegacyInsuranceBatches({
      batchIds: [b._id.toString()], userId: USER.toString(), reason: 'x', dryRun: false
    });
    expect(r.blocked).toBe(true);
    expect(r.conflicts[0].blockers.some(x => x.code === 'VOID_BATCH_HAS_INVOICE')).toBe(true);
  }, 60_000);

  it('exige allowlist', async () => {
    const r = await voidLegacyInsuranceBatches({ batchIds: [], userId: USER.toString(), reason: 'x', dryRun: false });
    expect(r.blocked).toBe(true);
    expect(r.conflicts[0].code).toBe('VOID_BATCH_ALLOWLIST_REQUIRED');
  }, 60_000);
});
