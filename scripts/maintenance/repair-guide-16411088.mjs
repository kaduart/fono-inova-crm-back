#!/usr/bin/env node
/**
 * Reparo da guia 16411088 (Unimed Anápolis, fonoaudiologia).
 *
 * ══ O QUE ACONTECEU ════════════════════════════════════════════════════════
 *
 * Paciente começou 1x/semana em 21/07. Em 04/08 passou a 2x/semana (adicionado
 * um segundo horário, terça 10:00, ao InsurancePlan). Quem cadastrou colocou a
 * "data de início" do plano igual à data original (21/07) em vez de 04/08 —
 * data em que o segundo horário passou a valer de fato. Como o plano só tem UM
 * `startDate` global (sem vigência por horário), "Gerar sessões" aplicou os
 * dois horários (09:20 e 10:00) em toda semana desde 21/07, e cada uma nasceu
 * já `completed` (mesmo padrão do incidente da guia 16173377/Ícaro): consumiu
 * a guia e lançou Payment/ledger para sessões que não aconteceram.
 *
 * Fantasmas: terça 10:00 de 21/07 e terça 10:00 de 28/07. As duas sessões de
 * 09:20 (21/07 e 28/07) e as quatro de 04/08+11/08 (ambos horários) são reais.
 *
 * Confirmado por leitura direta do banco (scripts/maintenance/investigate-guide-16411088.mjs):
 * nenhum dos dois payments fantasma está faturado/recebido (status pending,
 * insurance.status pending_billing, sem batchId) — estorno é seguro.
 *
 * ══ O QUE ESTE SCRIPT FAZ ══════════════════════════════════════════════════
 *
 *   1. Estorna as 2 fantasma (21/07 10:00, 28/07 10:00) → guia 8 → 6
 *      appointment vira 'canceled' (nunca hard delete), Session vira
 *      'canceled', Payment vira 'canceled' pelo transitionPaymentStatus
 *      canônico, ledger é revertido por contrapartida, guia.usedSessions -1
 *      e consumptionHistory tem a entrada removida — por evidência de
 *      consumo provada, não às cegas.
 *
 *   2. Cria 2 appointments novos no fim da agenda do plano, terça 10:00,
 *      nas duas próximas datas livres após a última já gerada (18/08 e
 *      25/08) — como 'pre_agendado', pelo factory canônico
 *      (buildInsuranceSession), sem completar. Ficam pendentes de
 *      atendimento real, exatamente como pede o pedido do usuário
 *      ("joga pro final do pacote as duas sessões com pre_agendado").
 *
 *   Resultado obrigatório: usedSessions === 6, 2 pre_agendado no fim da agenda.
 *
 * ══ USO ════════════════════════════════════════════════════════════════════
 *
 *   node scripts/maintenance/repair-guide-16411088.mjs             (dry-run)
 *   node scripts/maintenance/repair-guide-16411088.mjs --apply
 *
 * ══ GARANTIAS ══════════════════════════════════════════════════════════════
 *
 * - Dry-run é o padrão.
 * - Pré-checagem estrita ANTES de qualquer escrita: divergiu, aborta sem tocar em nada.
 * - Idempotente: segunda execução é no-op.
 * - Sem hard delete — estorno vira 'canceled' com motivo e trilha.
 * - Estorno de ledger por contrapartida, sem apagar histórico.
 * - Devolve sessão à guia pelo caminho canônico ($inc -1 + $pull), com prova de consumo.
 * - As 2 sessões novas são criadas pelo factory canônico (buildInsuranceSession),
 *   nascem 'pre_agendado'/'scheduled' — nunca com status='completed' na mão.
 * - ABORTA se algum payment já estiver em lote ou recebido.
 * - Verifica no fim que usedSessions === 6 e que as 2 novas existem como pre_agendado.
 */
import mongoose from 'mongoose';
import dotenv from 'dotenv';
import moment from 'moment-timezone';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
dotenv.config({ path: join(__dirname, '../../.env') });
dotenv.config();

import '../../models/index.js';
import Appointment from '../../models/Appointment.js';
import Session from '../../models/Session.js';
import Payment from '../../models/Payment.js';
import InsuranceGuide from '../../models/InsuranceGuide.js';
import InsurancePlan from '../../models/InsurancePlan.js';
import { buildInsuranceSession } from '../../domain/session/sessionFactory.js';
import { transitionPaymentStatus } from '../../services/paymentStatusService.js';

const argv = process.argv;
const APPLY = argv.includes('--apply');

const TZ = 'America/Sao_Paulo';
const GUIDE_ID = '6a5a2dc5ce43485b2af4c307';
const PLAN_ID = '6a5a2df0ce43485b2af4c333';

/** Criadas pelo backfill retroativo — nenhuma aconteceu (só existe 1 sessão/semana nessas 2 semanas). */
const FANTASMAS = [
  '6a5a2df393897a6b591bf81e', // 21/07 10:00
  '6a833ed7b2f7af06da492bb3', // 28/07 10:00
];

/** Próximas duas terças 10:00 livres, continuando o padrão semanal após a última data já gerada (11/08). */
const NOVAS_DATAS = ['2026-08-18', '2026-08-25'];
const NOVO_TIME = '10:00';

const USED_SESSIONS_ESPERADO = 6;
const MOTIVO_ESTORNO = 'Estorno: sessão marcada como realizada sem atendimento correspondente — backfill retroativo por data de início do plano incorreta (incidente guia 16411088, 2026-08-17)';

const oid = (s) => new mongoose.Types.ObjectId(s);
const brl = (n) => `R$ ${Number(n || 0).toFixed(2)}`;
const d10 = (d) => moment.tz(d, TZ).format('YYYY-MM-DD (ddd)');

// ════════════════════════════════════════════════════════════════════════
async function assertNothingBilled(appointmentIds, mongoSession = null) {
  const q = Payment.find({ appointment: { $in: appointmentIds } });
  if (mongoSession) q.session(mongoSession);
  const payments = await q.lean();

  const bloqueios = [];
  for (const p of payments) {
    const batchId = p.insurance?.batchId || p.batchId || p.insuranceBatch;
    if (batchId) bloqueios.push(`payment ${String(p._id).slice(-6)} está no lote ${batchId}`);
    if (['received', 'paid'].includes(p.status)) bloqueios.push(`payment ${String(p._id).slice(-6)} com status '${p.status}'`);
    if (['received', 'billed', 'submitted'].includes(p.insurance?.status)) {
      bloqueios.push(`payment ${String(p._id).slice(-6)} com insurance.status '${p.insurance.status}'`);
    }
  }

  if (bloqueios.length > 0) {
    throw new Error(
      'ABORTADO — pagamento já faturado ou recebido. Estornar aqui criaria divergência com o ' +
      'convênio; use o fluxo formal de glosa/estorno primeiro:\n  - ' + bloqueios.join('\n  - ')
    );
  }
  return payments;
}

async function provarConsumo(appts, guide) {
  const historico = guide.consumptionHistory || [];
  const evidencias = [];
  const problemas = [];

  const ocorrencias = new Map();
  for (const h of historico) {
    const k = String(h.sessionId);
    ocorrencias.set(k, (ocorrencias.get(k) || 0) + 1);
  }

  const duplicadosNoHistorico = [...ocorrencias.entries()].filter(([, n]) => n > 1);
  if (duplicadosNoHistorico.length > 0) {
    problemas.push(`consumptionHistory tem entrada duplicada para session(s): ${
      duplicadosNoHistorico.map(([k, n]) => `${k.slice(-6)}×${n}`).join(', ')}`);
  }

  for (const appt of appts) {
    const sessions = await Session.find(
      { $or: [{ appointmentId: appt._id }, { appointment: appt._id }] },
      { _id: 1, status: 1, guideConsumed: 1 }
    ).lean();

    const noHistorico = sessions.filter(s => ocorrencias.has(String(s._id)));
    const totalConsumos = noHistorico.reduce((n, s) => n + ocorrencias.get(String(s._id)), 0);
    const ref = `${d10(appt.date)} ${appt.time}`;

    if (totalConsumos === 0) {
      problemas.push(`${ref}: nenhuma Session no consumptionHistory — decrementar roubaria autorização alheia`);
    } else if (totalConsumos > 1) {
      problemas.push(`${ref}: ${totalConsumos} consumos registrados — um $pull não resolve, exige análise manual`);
    } else {
      evidencias.push({
        appointmentId: appt._id,
        ref,
        sessionId: noHistorico[0]._id,
        sessionIds: sessions.map(s => s._id),
        consumos: totalConsumos,
      });
    }
  }

  return { evidencias, problemas, totalNoHistorico: historico.length };
}

async function levantar() {
  const guide = await InsuranceGuide.findById(GUIDE_ID).lean();
  const plan = await InsurancePlan.findById(PLAN_ID).lean();
  const appts = await Appointment.find({ insurancePlan: oid(PLAN_ID) }).sort({ date: 1, time: 1 }).lean();

  const byId = (id) => appts.find(a => String(a._id) === id);

  const pendentesFantasma = FANTASMAS.map(byId).filter(a => a && a.operationalStatus === 'completed');

  const existentesNovasDatas = NOVAS_DATAS.map(date =>
    appts.find(a => d10(a.date).startsWith(date) && a.time === NOVO_TIME && a.operationalStatus !== 'canceled')
  );

  // Referência pra copiar campos estruturais (patient/doctor/duration/specialty/valor)
  const referencia = appts.filter(a => a.operationalStatus !== 'canceled').slice(-1)[0];

  return { guide, plan, appts, pendentesFantasma, existentesNovasDatas, referencia };
}

function projetarSaldo(e) {
  const revertidas = e.pendentesFantasma.length;
  const aCriar = e.existentesNovasDatas.filter(x => !x).length;
  return { revertidas, aCriar, final: e.guide.usedSessions - revertidas };
}

function relatorio(e) {
  const { guide, plan, appts, pendentesFantasma, existentesNovasDatas } = e;
  console.log(`\n${APPLY ? '🔧 MODO APPLY (grava)' : '🔍 DRY-RUN (não grava nada)'}\n`);
  console.log('═'.repeat(80));
  console.log(`GUIA #${guide.number} · ${guide.insurance} · autoriza ${guide.specialty}`);
  console.log(`Estado: ${guide.usedSessions}/${guide.totalSessions} usadas · ${brl(guide.sessionValue)}/sessão`);
  console.log('═'.repeat(80));

  console.log('\n── AGENDA ATUAL ──');
  for (const a of appts) {
    const id = String(a._id);
    const marca = FANTASMAS.includes(id) ? '🚨 fantasma' : '';
    console.log(`  ${d10(a.date)} ${a.time}  ${String(a.operationalStatus).padEnd(11)} ${marca}`);
  }

  console.log('\n── 1. ESTORNO DAS 2 FANTASMA ──');
  if (!pendentesFantasma.length) console.log('  ✅ já estornadas (no-op)');
  else pendentesFantasma.forEach(a => console.log(`  ${d10(a.date)} ${a.time} → cancelada · guia −1 · payment estornado`));

  console.log('\n── 2. NOVAS SESSÕES PRE_AGENDADO NO FIM DA AGENDA ──');
  NOVAS_DATAS.forEach((date, i) => {
    if (existentesNovasDatas[i]) console.log(`  ${date} ${NOVO_TIME}: ✅ já existe (no-op)`);
    else console.log(`  ${date} ${NOVO_TIME}: ➕ será criada como pre_agendado`);
  });

  const { revertidas, aCriar, final } = projetarSaldo(e);
  console.log('\n' + '═'.repeat(80));
  console.log(`SALDO   agora ${guide.usedSessions}/${guide.totalSessions}  →  estornos −${revertidas}  →  ${final}/${guide.totalSessions}`);
  console.log(`  USADAS FINAIS: ${final}${final === USED_SESSIONS_ESPERADO ? ' ✅' : `  ⚠️ esperado ${USED_SESSIONS_ESPERADO}`}`);
  console.log(`  Sessões pre_agendado a criar: ${aCriar}`);
  console.log('═'.repeat(80));
}

// ════════════════════════════════════════════════════════════════════════
async function estornar(appt, mongoSession, guide, evidencia) {
  await Session.updateMany(
    { $or: [{ appointmentId: appt._id }, { appointment: appt._id }] },
    { $set: {
        status: 'canceled', canceledAt: new Date(), cancelReason: MOTIVO_ESTORNO,
        guideConsumed: false, isPaid: false, paymentStatus: 'pending',
        visualFlag: 'blocked', updatedAt: new Date(),
      } },
    { session: mongoSession }
  );

  const payments = await Payment.find(
    { appointment: appt._id, status: { $ne: 'canceled' } },
    { _id: 1 },
    { session: mongoSession }
  ).lean();

  for (const { _id: paymentId } of payments) {
    const { payment } = await transitionPaymentStatus(paymentId, 'canceled', {
      session: mongoSession,
      reason: MOTIVO_ESTORNO,
    });

    payment.insurance ??= {};
    payment.insurance.status = null;
    payment.insurance.voidedAt = new Date();
    payment.insurance.voidReason = MOTIVO_ESTORNO;
    payment.notes = MOTIVO_ESTORNO;
    await payment.save({ session: mongoSession });
  }

  const ledger = mongoose.connection.collection('financial_ledger');
  const lancamentos = await ledger.find(
    { $or: [{ appointment: appt._id }, { appointmentId: appt._id }], reversedAt: { $exists: false } },
    { session: mongoSession }
  ).toArray();

  for (const l of lancamentos) {
    await ledger.updateOne({ _id: l._id },
      { $set: { reversedAt: new Date(), reversalReason: MOTIVO_ESTORNO } }, { session: mongoSession });
    await ledger.insertOne({
      ...l, _id: new mongoose.Types.ObjectId(),
      amount: -Math.abs(l.amount ?? l.value ?? 0),
      type: 'revenue_reversal', reversalOf: l._id,
      description: MOTIVO_ESTORNO, date: new Date(), createdAt: new Date(),
    }, { session: mongoSession });
  }

  await Appointment.updateOne({ _id: appt._id },
    { $set: {
        operationalStatus: 'canceled', clinicalStatus: 'pending', paymentStatus: 'canceled',
        visualFlag: 'blocked', cancelReason: MOTIVO_ESTORNO, cancelSource: 'migration',
        missed: false, canceledAt: new Date(), updatedAt: new Date(),
      },
      $push: { history: {
        action: 'estorno_sessao_sem_atendimento', newStatus: 'canceled', timestamp: new Date(),
        context: 'reparo_dados', details: { script: 'repair-guide-16411088', motivo: MOTIVO_ESTORNO }
      } } },
    { session: mongoSession });

  const antes = guide.consumptionHistory?.length ?? null;
  const guiaAtualizada = await InsuranceGuide.findOneAndUpdate(
    {
      _id: guide._id,
      usedSessions: { $gt: 0 },
      'consumptionHistory.sessionId': evidencia.sessionId,
    },
    {
      $inc: { usedSessions: -1 },
      $pull: { consumptionHistory: { sessionId: evidencia.sessionId } },
    },
    { session: mongoSession, new: true }
  );

  if (!guiaAtualizada) {
    throw new Error(
      `ABORTADO em ${evidencia.ref}: o consumo da session ${String(evidencia.sessionId).slice(-6)} ` +
      `não estava mais no consumptionHistory no momento da escrita (ou usedSessions já era 0). ` +
      `Transação revertida.`
    );
  }

  const depois = guiaAtualizada.consumptionHistory?.length ?? null;
  if (antes !== null && depois !== null && antes - depois !== 1) {
    throw new Error(
      `ABORTADO em ${evidencia.ref}: $pull removeu ${antes - depois} entradas do consumptionHistory, ` +
      `esperado exatamente 1. Transação revertida.`
    );
  }

  guide.consumptionHistory = guiaAtualizada.consumptionHistory;
  guide.usedSessions = guiaAtualizada.usedSessions;

  return { ledgerRevertido: lancamentos.length, consumoRemovido: String(evidencia.sessionId) };
}

async function criarPreAgendado(referencia, guide, plan, date, time) {
  const dateAtMidnightLocal = moment.tz(`${date} 00:00`, 'YYYY-MM-DD HH:mm', TZ).toDate();
  const nota = `Sessão reprogramada em reparo de dados — reposição das sessões estornadas de 21/07 e 28/07 (incidente guia 16411088, 2026-08-17).`;

  const mongoSession = await mongoose.startSession();
  let apptId;
  try {
    await mongoSession.withTransaction(async () => {
      const [appt] = await Appointment.create([{
        patient: referencia.patient,
        doctor: referencia.doctor,
        date: dateAtMidnightLocal,
        time,
        duration: referencia.duration,
        specialty: referencia.specialty,
        sessionType: referencia.sessionType,
        serviceType: 'session',
        operationalStatus: 'pre_agendado',
        clinicalStatus: 'pending',
        paymentStatus: 'pending',
        billingType: 'convenio',
        paymentMethod: 'convenio',
        insuranceProvider: guide.insurance,
        insuranceGuide: guide._id,
        insurancePlan: plan._id,
        sessionValue: guide.sessionValue,
        insuranceValue: guide.sessionValue,
        notes: nota,
        metadata: { origin: { source: 'insurance_plan' } },
      }], { session: mongoSession });

      const [sess] = await Session.create([buildInsuranceSession({
        _id: appt._id,
        patient: appt.patient, doctor: appt.doctor, date: appt.date, time: appt.time,
        specialty: guide.specialty, serviceType: 'session', sessionType: referencia.sessionType,
        sessionValue: guide.sessionValue, insuranceGuide: guide._id, insurancePlan: plan._id,
      })], { session: mongoSession });

      await Appointment.updateOne({ _id: appt._id },
        { $set: { session: sess._id } }, { session: mongoSession });

      apptId = appt._id;
    });
  } finally {
    await mongoSession.endSession().catch(() => {});
  }

  return apptId;
}

// ════════════════════════════════════════════════════════════════════════
async function main() {
  await mongoose.connect(process.env.MONGO_URI);
  const estado = await levantar();
  relatorio(estado);

  const { guide, plan, pendentesFantasma, existentesNovasDatas, referencia } = estado;

  console.log('\n── PRÉ-CHECAGEM ──');
  const problemas = [];

  try {
    const pays = await assertNothingBilled(pendentesFantasma.map(a => a._id));
    console.log(`  ✅ ${pays.length} payment(s) dos estornos: pendentes e fora de lote`);
  } catch (err) { problemas.push(err.message); }

  const { evidencias, problemas: probConsumo, totalNoHistorico } = await provarConsumo(pendentesFantasma, guide);
  problemas.push(...probConsumo);
  if (pendentesFantasma.length > 0 && probConsumo.length === 0) {
    console.log(`  ✅ consumo provado: ${evidencias.length}/${pendentesFantasma.length} appointments com exatamente 1 consumo` +
      ` (consumptionHistory tem ${totalNoHistorico} entradas)`);
  }

  if (!referencia && existentesNovasDatas.some(x => !x)) {
    problemas.push('sem appointment de referência no plano pra copiar patient/doctor/duration/specialty');
  }

  const { final } = projetarSaldo(estado);
  if (final !== USED_SESSIONS_ESPERADO) {
    problemas.push(`projeção final é ${final}/${guide.totalSessions}, esperado ${USED_SESSIONS_ESPERADO}`);
  } else {
    console.log(`  ✅ projeção fecha em ${USED_SESSIONS_ESPERADO}/${guide.totalSessions}`);
  }

  if (problemas.length > 0) {
    console.error('\n🚫 ABORTADO — pré-checagem falhou:');
    problemas.forEach(p => console.error('  - ' + p));
    console.error('\nNada foi gravado.\n');
    await mongoose.disconnect();
    process.exit(2);
  }

  if (!APPLY) {
    console.log('\nNada foi gravado. Para aplicar: --apply\n');
    await mongoose.disconnect();
    return;
  }

  const nadaAFazer = !pendentesFantasma.length && existentesNovasDatas.every(Boolean);
  if (nadaAFazer) {
    console.log('\n✅ NO-OP — reparo já aplicado anteriormente.\n');
    await mongoose.disconnect();
    return;
  }

  const mongoSession = await mongoose.startSession();
  try {
    await mongoSession.withTransaction(async () => {
      await assertNothingBilled(pendentesFantasma.map(a => a._id), mongoSession);

      for (const appt of pendentesFantasma) {
        const ev = evidencias.find(e => String(e.appointmentId) === String(appt._id));
        if (!ev) throw new Error(`ABORTADO: sem evidência de consumo para ${d10(appt.date)} ${appt.time}`);
        const r = await estornar(appt, mongoSession, guide, ev);
        console.log(`  ↩️  ${d10(appt.date)} ${appt.time} estornada` +
          ` (ledger ×${r.ledgerRevertido}, consumo ${r.consumoRemovido.slice(-6)} removido)`);
      }
    });
  } finally {
    await mongoSession.endSession().catch(() => {});
  }

  for (let i = 0; i < NOVAS_DATAS.length; i++) {
    if (existentesNovasDatas[i]) {
      console.log(`  ♻️  ${NOVAS_DATAS[i]} ${NOVO_TIME}: já existe — no-op`);
      continue;
    }
    const id = await criarPreAgendado(referencia, guide, plan, NOVAS_DATAS[i], NOVO_TIME);
    console.log(`  ➕ ${NOVAS_DATAS[i]} ${NOVO_TIME}: pre_agendado criado (${String(id).slice(-6)})`);
  }

  const falhas = await reconciliar();
  await mongoose.disconnect();
  if (falhas > 0) process.exit(3);
}

async function reconciliar() {
  const guide = await InsuranceGuide.findById(GUIDE_ID).lean();
  const appts = await Appointment.find({ insurancePlan: oid(PLAN_ID) }).lean();

  const fantasmasAindaCompleted = appts.filter(a => FANTASMAS.includes(String(a._id)) && a.operationalStatus === 'completed');
  const novasPreAgendado = NOVAS_DATAS.map(date =>
    appts.find(a => d10(a.date).startsWith(date) && a.time === NOVO_TIME && a.operationalStatus === 'pre_agendado')
  );

  const checks = [
    [`guia.usedSessions = ${USED_SESSIONS_ESPERADO}`, guide.usedSessions === USED_SESSIONS_ESPERADO, `${guide.usedSessions}`],
    ['nenhuma fantasma ainda completed', fantasmasAindaCompleted.length === 0, `${fantasmasAindaCompleted.length}`],
    ['2 novas pre_agendado no fim da agenda', novasPreAgendado.every(Boolean), `${novasPreAgendado.filter(Boolean).length}/2`],
  ];

  console.log('\n' + '═'.repeat(80));
  console.log('RECONCILIAÇÃO FINAL');
  console.log('═'.repeat(80));
  let falhas = 0;
  for (const [nome, ok, obtido] of checks) {
    console.log(`  ${ok ? '✅' : '🚫'} ${nome.padEnd(46)} → ${obtido}`);
    if (!ok) falhas++;
  }
  console.log('═'.repeat(80));
  console.log(falhas === 0 ? '✅ Estado consistente.\n' : `🚫 ${falhas} verificação(ões) falharam.\n`);
  return falhas;
}

main().catch(err => { console.error(err); process.exit(1); });
