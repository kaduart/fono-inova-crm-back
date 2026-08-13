#!/usr/bin/env node
/**
 * Reparo da guia 16173377 (Ícaro) — três incidentes na mesma guia.
 *
 * ══ O QUE ACONTECEU ════════════════════════════════════════════════════════
 *
 * A) 12/08 21:10 — "Gerar sessões" com backfill retroativo criou 5 appointments
 *    datados de julho, e a rota os completou automaticamente. Consumiu 5
 *    sessões da guia e lançou R$ 400 de produção. Nenhum aconteceu.
 *
 * B) 07/08 19:55 — o appointment de 18/09 (data FUTURA) foi editado e concluído
 *    manualmente. Consumiu +1 sessão e lançou R$ 80.
 *
 * C) 01/07 20:21 — ERRO CADASTRAL: o plano nasceu como `fonoaudiologia`
 *    enquanto a guia autoriza `terapia_ocupacional` e a profissional é de TO.
 *    Auditoria confirma: 5 edições no plano, todas mantendo fono. Ninguém
 *    tentou corrigir. Não é mudança clínica — é cadastro errado desde o início.
 *
 * Estado: guia 8/10 com 3 atendimentos reais (papel assinado).
 *
 * ══ O QUE ESTE SCRIPT FAZ ══════════════════════════════════════════════════
 *
 *   1. Estorna as 5 fabricadas          → guia 8 → 3
 *   2. Estorna o 18/09                  → guia 3 → 2
 *   3. Reconcilia especialidade p/ TO    (plano + 17/07 + 24/07 + cadeia)
 *   4. Cria e conclui a sessão real 12/08 → guia 2 → 3   [--confirm-real-session-1208]
 *
 *   Resultado obrigatório: usedSessions === 3
 *
 * ══ USO ════════════════════════════════════════════════════════════════════
 *
 *   node scripts/maintenance/repair-icaro-guide-16173377.js
 *   node scripts/maintenance/repair-icaro-guide-16173377.js --apply \
 *        --confirm-real-session-1208 \
 *        --evidence="Tabela de atendimento assinada — 3a linha: 12/08/26 18:20"
 *
 *   Flags: --skip-1809  --skip-specialty  --confirm-real-session-1208  --evidence="..."
 *
 * ══ GARANTIAS ══════════════════════════════════════════════════════════════
 *
 * - Dry-run é o padrão.
 * - Pré-checagem estrita ANTES de qualquer escrita: divergiu, aborta sem tocar em nada.
 * - Idempotente: segunda execução é no-op.
 * - Sem hard delete — tudo vira 'canceled' com motivo e trilha.
 * - Estorno de ledger por contrapartida, sem apagar histórico.
 * - Devolve sessão à guia pelo caminho canônico ($inc -1 + $pull), igual convenio.guard.js.
 * - A sessão real é criada pelo factory canônico e concluída por completeSessionV2 —
 *   nunca com status='completed' na mão.
 * - ABORTA se algum payment já estiver em lote ou recebido.
 * - Verifica no fim que usedSessions === 3.
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
import { completeSessionV2 } from '../../services/completeSessionService.v2.js';
import { transitionPaymentStatus } from '../../services/paymentStatusService.js';

const argv = process.argv;
const APPLY = argv.includes('--apply');
const SKIP_1809 = argv.includes('--skip-1809');
const SKIP_SPECIALTY = argv.includes('--skip-specialty');
const CONFIRM_1208 = argv.includes('--confirm-real-session-1208');
const EVIDENCE = (argv.find(a => a.startsWith('--evidence=')) || '').replace('--evidence=', '');

const TZ = 'America/Sao_Paulo';
const GUIDE_ID = '6a455d86494b0ecabb70dac7';
const PLAN_ID = '6a4576db02c3c83ca19de701';

/** Criadas pelo backfill de 12/08 21:10 — nenhuma aconteceu. */
const FABRICADAS = [
  '6a7ce130104f7d24794572e5', '6a7ce130104f7d24794572e6', '6a7ce130104f7d24794572e7',
  '6a7ce130104f7d24794572e8', '6a7ce130104f7d24794572e9',
];

/** Concluída em 07/08 para uma data de 18/09 que ainda não chegou. */
const ANOMALIA_1809 = '6a4576dc0b1d4720a17ef3b2';

/** Atendimentos REAIS (papel assinado). Só estes são reclassificados. */
const REAIS_EXISTENTES = [
  '6a4576dc0b1d4720a17ef3af', // 17/07 15:20
  '6a4576dc0b1d4720a17ef3b0', // 24/07 15:20
];

/** 3ª linha do papel — ausente do sistema. Identidade fixa, sem inferência. */
const SESSAO_REAL = {
  date: '2026-08-12',
  time: '18:20',
  patientId: '6a061e1300ff2e03fb40480f',
  doctorId: '698f09aa39d78a9c5746dc28', // Thayna Miranda
};

const USED_SESSIONS_ESPERADO = 3;
const MOTIVO_ESTORNO = 'Estorno: sessão marcada como realizada sem atendimento correspondente (incidente guia 16173377, 2026-08-13)';
const MOTIVO_ESPECIALIDADE = 'Correção cadastral: plano criado como fonoaudiologia contra guia autorizada em terapia_ocupacional (incidente guia 16173377, 2026-08-13)';

const oid = (s) => new mongoose.Types.ObjectId(s);
const brl = (n) => `R$ ${Number(n || 0).toFixed(2)}`;
const d10 = (d) => moment.tz(d, TZ).format('YYYY-MM-DD');

// ════════════════════════════════════════════════════════════════════════
// PRÉ-CHECAGEM — roda inteira antes de qualquer escrita
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

/**
 * PROVA DE CONSUMO — roda antes de qualquer decremento da guia.
 *
 * Decrementar `usedSessions` às cegas é perigoso: se o appointment não tiver
 * consumido nada, o $inc -1 rouba autorização de outra sessão legítima. Se
 * tiver consumido duas vezes (bug de duplicidade), um -1 deixa resíduo.
 *
 * Exige, para CADA appointment: exatamente 1 Session dele no consumptionHistory
 * da guia. Qualquer outro número aborta.
 */
async function provarConsumo(appts, guide) {
  const historico = guide.consumptionHistory || [];
  const evidencias = [];
  const problemas = [];

  // Índice: sessionId -> quantas vezes aparece no consumptionHistory
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

    if (sessions.length > 1) {
      // Não bloqueia: já sabemos que o gerador duplica Session (campo
      // `appointment` vs `appointmentId`). Só uma está no histórico.
      console.log(`     ℹ️  ${ref}: ${sessions.length} Sessions vinculadas (duplicidade conhecida), ${noHistorico.length} no histórico`);
    }
  }

  return { evidencias, problemas, totalNoHistorico: historico.length };
}

async function levantar() {
  const guide = await InsuranceGuide.findById(GUIDE_ID).lean();
  const plan = await InsurancePlan.findById(PLAN_ID).lean();
  const appts = await Appointment.find({ insurancePlan: oid(PLAN_ID) }).sort({ date: 1 }).lean();

  const byId = (id) => appts.find(a => String(a._id) === id);

  // Idempotência: só age no que ainda não foi tratado
  const pendentesA = FABRICADAS.map(byId).filter(a => a && a.operationalStatus === 'completed');
  const pendentesB = SKIP_1809 ? [] : [byId(ANOMALIA_1809)].filter(a => a && a.operationalStatus === 'completed');
  const reaisParaReclassificar = SKIP_SPECIALTY ? [] :
    REAIS_EXISTENTES.map(byId).filter(a => a && a.specialty !== guide.specialty);
  const planoPrecisaCorrigir = !SKIP_SPECIALTY && plan.specialty !== guide.specialty;

  // ── Retomabilidade da sessão real de 12/08 ──────────────────────────────
  // Se a conclusão falhar depois dos estornos, a próxima execução precisa
  // continuar de onde parou (2/10) e concluir o appointment que já existe —
  // não criar outro. Testar só "existe?" não distingue os casos.
  const candidatos1208 = appts.filter(a =>
    d10(a.date) === SESSAO_REAL.date && a.time === SESSAO_REAL.time && a.operationalStatus !== 'canceled'
  );

  let estado1208;
  if (candidatos1208.length === 0) {
    estado1208 = { situacao: 'AUSENTE', acao: 'criar e concluir', appt: null };
  } else if (candidatos1208.length > 1) {
    estado1208 = {
      situacao: 'DUPLICADO', acao: 'abortar', appt: null,
      detalhe: `${candidatos1208.length} appointments ativos em ${SESSAO_REAL.date} ${SESSAO_REAL.time}`,
    };
  } else {
    const a = candidatos1208[0];
    if (a.operationalStatus === 'completed') {
      estado1208 = { situacao: 'CONCLUIDO', acao: 'no-op', appt: a };
    } else if (['pre_agendado', 'scheduled', 'confirmed'].includes(a.operationalStatus)) {
      estado1208 = { situacao: 'PENDENTE', acao: 'reutilizar e concluir', appt: a };
    } else {
      estado1208 = {
        situacao: 'ESTADO_INESPERADO', acao: 'abortar', appt: a,
        detalhe: `operationalStatus='${a.operationalStatus}'`,
      };
    }
  }

  return { guide, plan, appts, pendentesA, pendentesB, reaisParaReclassificar, planoPrecisaCorrigir, estado1208 };
}

function projetarSaldo(e) {
  const revertidas = e.pendentesA.length + e.pendentesB.length;
  // Só soma +1 quando a conclusão ainda vai acontecer (ausente ou pendente).
  const vaiConcluir = CONFIRM_1208 && ['AUSENTE', 'PENDENTE'].includes(e.estado1208.situacao);
  const criadas = vaiConcluir ? 1 : 0;
  return { revertidas, criadas, final: e.guide.usedSessions - revertidas + criadas };
}

function relatorio(e) {
  const { guide, plan, appts, pendentesA, pendentesB, reaisParaReclassificar, planoPrecisaCorrigir, estado1208 } = e;
  console.log(`\n${APPLY ? '🔧 MODO APPLY (grava)' : '🔍 DRY-RUN (não grava nada)'}\n`);
  console.log('═'.repeat(80));
  console.log(`GUIA #${guide.number} · ${guide.insurance} · autoriza ${guide.specialty}`);
  console.log(`Plano: ${plan.specialty}${plan.specialty !== guide.specialty ? '   ⚠️ ERRO CADASTRAL' : '   ✅'}`);
  console.log(`Estado: ${guide.usedSessions}/${guide.totalSessions} usadas · ${brl(guide.sessionValue)}/sessão`);
  console.log('═'.repeat(80));

  console.log('\n── AGENDA ATUAL ──');
  for (const a of appts) {
    const id = String(a._id);
    const marca = FABRICADAS.includes(id) ? '🚨 fabricada'
      : id === ANOMALIA_1809 ? '⚠️ concluída antes da data'
        : REAIS_EXISTENTES.includes(id) ? '✅ real (papel)' : '';
    console.log(`  ${d10(a.date)} ${a.time}  ${String(a.operationalStatus).padEnd(11)} ${String(a.specialty).padEnd(20)} ${marca}`);
  }

  console.log('\n── 1. ESTORNO DAS 5 FABRICADAS ──');
  if (!pendentesA.length) console.log('  ✅ já estornadas (no-op)');
  else pendentesA.forEach(a => console.log(`  ${d10(a.date)} ${a.time} → cancelada · guia −1 · ledger ${brl(a.sessionValue)} estornado`));

  console.log('\n── 2. ESTORNO DO 18/09 ──');
  if (SKIP_1809) console.log('  ⏭️ pulado');
  else if (!pendentesB.length) console.log('  ✅ já estornada (no-op)');
  else pendentesB.forEach(a => console.log(`  ${d10(a.date)} ${a.time} → cancelada · guia −1 · ledger ${brl(a.sessionValue)} estornado`));

  console.log(`\n── 3. CORREÇÃO CADASTRAL → ${guide.specialty} ──`);
  if (SKIP_SPECIALTY) console.log('  ⏭️ pulado');
  else {
    console.log(`  plano: ${planoPrecisaCorrigir ? `${plan.specialty} → ${guide.specialty}` : '✅ já correto'}`);
    if (!reaisParaReclassificar.length) console.log('  sessões reais: ✅ já corretas');
    else reaisParaReclassificar.forEach(a =>
      console.log(`  ${d10(a.date)} ${a.time}: ${a.specialty} → ${guide.specialty}  (appointment + session + payment)`));
    console.log('  ℹ️  faltas, canceladas e fabricadas NÃO são reclassificadas');
  }

  console.log('\n── 4. SESSÃO REAL DE 12/08 18:20 ──');
  console.log(`  situação: ${estado1208.situacao}${estado1208.detalhe ? ' — ' + estado1208.detalhe : ''}`);
  if (estado1208.situacao === 'CONCLUIDO') {
    console.log('  ✅ já concluída — no-op');
  } else if (['DUPLICADO', 'ESTADO_INESPERADO'].includes(estado1208.situacao)) {
    console.log('  🚫 abortará: estado não tratável automaticamente');
  } else if (!CONFIRM_1208) {
    console.log('  ⏭️ requer --confirm-real-session-1208 (+ --evidence="...")');
  } else if (estado1208.situacao === 'PENDENTE') {
    console.log(`  ♻️  reutilizar o appointment existente (${String(estado1208.appt._id).slice(-6)}) e concluir → guia +1`);
  } else {
    console.log(`  ➕ criar ${guide.specialty} · Thayna · guia #${guide.number} → concluir → guia +1`);
  }

  const { revertidas, criadas, final } = projetarSaldo(e);
  console.log('\n' + '═'.repeat(80));
  console.log(`SALDO   agora ${guide.usedSessions}/${guide.totalSessions}` +
    `  →  estornos −${revertidas}  →  ${guide.usedSessions - revertidas}` +
    `  →  registro +${criadas}  →  ${final}/${guide.totalSessions}`);
  console.log(`\n  USADAS FINAIS: ${final}${final === USED_SESSIONS_ESPERADO ? ' ✅' : `  ⚠️ esperado ${USED_SESSIONS_ESPERADO}`}` +
    `   ·   AUTORIZAÇÕES RESTANTES: ${guide.totalSessions - final}`);
  console.log('\n  "restantes" = autorizações disponíveis (total − usadas), não agenda futura.');
  console.log('  A falta de 31/07 NÃO consome autorização neste sistema (usedSessions só');
  console.log('  incrementa na conclusão). Se a Unimed cobrar falta, é regra contratual.');
  console.log('═'.repeat(80));
}

// ════════════════════════════════════════════════════════════════════════
// ESCRITAS
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

  // Estado de convênio também precisa sair de "a faturar".
  // `status: 'canceled'` já exclui pelo filtro canônico
  // (buildInsuranceReceivableFilter usa `status: { $ne: 'canceled' }`), mas
  // deixar `insurance.status: 'pending_billing'` num payment cancelado é
  // estado incoerente — e há leitores que olham só o campo de convênio
  // (ex.: reconcileLegacyInsuranceBatch). O enum não tem 'canceled'/'voided';
  // `null` é o valor honesto: não há estado de convênio. 'rejected' seria
  // mentira, porque significa glosa.
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

    // A transição canônica é responsável por status + evento. Estes campos
    // registram o void específico do convênio na mesma transação.
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
        context: 'reparo_dados', details: { script: 'repair-icaro-guide-16173377', motivo: MOTIVO_ESTORNO }
      } } },
    { session: mongoSession });

  // Decremento dirigido pela EVIDÊNCIA: remove exatamente o consumo provado,
  // não uma lista genérica de sessions. O filtro exige que o consumo ainda
  // exista — se outro processo já removeu, o findOneAndUpdate não casa e o
  // decremento não acontece (evita tirar autorização duas vezes).
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

  // Prova pós-escrita: o $pull removeu exatamente 1 entrada
  const depois = guiaAtualizada.consumptionHistory?.length ?? null;
  if (antes !== null && depois !== null && antes - depois !== 1) {
    throw new Error(
      `ABORTADO em ${evidencia.ref}: $pull removeu ${antes - depois} entradas do consumptionHistory, ` +
      `esperado exatamente 1. Transação revertida.`
    );
  }

  // O objeto em memória precisa refletir o estado, senão a próxima iteração
  // compara contra um histórico desatualizado.
  guide.consumptionHistory = guiaAtualizada.consumptionHistory;
  guide.usedSessions = guiaAtualizada.usedSessions;

  return { ledgerRevertido: lancamentos.length, consumoRemovido: String(evidencia.sessionId) };
}

/** Reclassifica a cadeia inteira de UM atendimento real. */
async function reclassificar(appt, especialidade, mongoSession) {
  await Appointment.updateOne({ _id: appt._id },
    { $set: { specialty: especialidade, sessionType: especialidade, updatedAt: new Date() },
      $push: { history: {
        action: 'correcao_cadastral_especialidade', timestamp: new Date(), context: 'reparo_dados',
        details: { de: appt.specialty, para: especialidade, motivo: MOTIVO_ESPECIALIDADE }
      } } },
    { session: mongoSession });

  await Session.updateMany(
    { $or: [{ appointmentId: appt._id }, { appointment: appt._id }] },
    { $set: { specialty: especialidade, sessionType: especialidade, updatedAt: new Date() } },
    { session: mongoSession });

  // Payment guarda specialty e é o que o faturamento lê
  await Payment.updateMany(
    { appointment: appt._id, status: { $ne: 'canceled' } },
    { $set: { specialty: especialidade, updatedAt: new Date() } },
    { session: mongoSession });
}

async function criarSessaoReal(guide, plan, evidencia) {
  // Data no padrão do resto da agenda: meia-noite local + campo `time`
  const dateAtMidnightLocal = moment.tz(`${SESSAO_REAL.date} 00:00`, 'YYYY-MM-DD HH:mm', TZ).toDate();
  const nota = `Atendimento realizado, registrado retroativamente em reparo de dados. Evidência: ${evidencia}`;

  const mongoSession = await mongoose.startSession();
  let apptId;
  try {
    await mongoSession.withTransaction(async () => {
      const [appt] = await Appointment.create([{
        patient: oid(SESSAO_REAL.patientId),
        doctor: oid(SESSAO_REAL.doctorId),
        date: dateAtMidnightLocal,
        time: SESSAO_REAL.time,
        duration: plan.duration || 40,
        specialty: guide.specialty,
        sessionType: guide.specialty,
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
        metadata: { origin: { source: 'repair_script', script: 'repair-icaro-guide-16173377' } },
      }], { session: mongoSession });

      // Factory canônico — nasce 'scheduled', nunca 'completed'
      const [sess] = await Session.create([buildInsuranceSession({
        _id: appt._id,
        patient: appt.patient, doctor: appt.doctor, date: appt.date, time: appt.time,
        specialty: guide.specialty, serviceType: 'session', sessionType: guide.specialty,
        sessionValue: guide.sessionValue, insuranceGuide: guide._id, insurancePlan: plan._id,
      })], { session: mongoSession });

      const [pay] = await Payment.create([{
        patient: appt.patient, doctor: appt.doctor, appointment: appt._id, session: sess._id,
        specialty: guide.specialty, amount: 0, billingType: 'convenio', status: 'pending',
        financialDate: null, paymentDate: new Date(), paymentMethod: 'convenio',
        insurance: { provider: guide.insurance, status: 'pending_billing', grossAmount: guide.sessionValue, guideId: guide._id },
        insuranceGuide: guide._id, insurancePlan: plan._id, kind: 'session_payment', notes: nota,
      }], { session: mongoSession });

      await Appointment.updateOne({ _id: appt._id },
        { $set: { session: sess._id, payment: pay._id } }, { session: mongoSession });

      apptId = appt._id;
    });
  } finally {
    await mongoSession.endSession().catch(() => {});
  }

  // Conclusão pelo fluxo oficial — consome a guia, liquida o payment e lança
  // produção exatamente como um "Fechar Atendimento" normal. O guard de data
  // futura deixa passar porque 12/08 já aconteceu.
  await completeSessionV2(apptId, { notes: nota, correlationId: `repair_icaro_${Date.now()}` });
  return apptId;
}

// ════════════════════════════════════════════════════════════════════════
async function main() {
  await mongoose.connect(process.env.MONGO_URI);
  const estado = await levantar();
  relatorio(estado);

  const { guide, plan, pendentesA, pendentesB, reaisParaReclassificar, planoPrecisaCorrigir, estado1208 } = estado;
  const alvosEstorno = [...pendentesA, ...pendentesB];

  // ── PRÉ-CHECAGEM ESTRITA ──────────────────────────────────────────────
  console.log('\n── PRÉ-CHECAGEM ──');
  const problemas = [];

  try {
    const pays = await assertNothingBilled(alvosEstorno.map(a => a._id));
    console.log(`  ✅ ${pays.length} payment(s) dos estornos: pendentes e fora de lote`);
  } catch (err) { problemas.push(err.message); }

  // Prova de consumo ANTES de qualquer decremento
  const { evidencias, problemas: probConsumo, totalNoHistorico } = await provarConsumo(alvosEstorno, guide);
  problemas.push(...probConsumo);
  if (alvosEstorno.length > 0 && probConsumo.length === 0) {
    console.log(`  ✅ consumo provado: ${evidencias.length}/${alvosEstorno.length} appointments com exatamente 1 consumo` +
      ` (consumptionHistory tem ${totalNoHistorico} entradas)`);
  }

  // Estado do 12/08 precisa ser tratável
  if (['DUPLICADO', 'ESTADO_INESPERADO'].includes(estado1208.situacao)) {
    problemas.push(`sessão de 12/08 em estado não tratável: ${estado1208.situacao} — ${estado1208.detalhe}`);
  }

  if (CONFIRM_1208) {
    if (!EVIDENCE.trim()) problemas.push('--confirm-real-session-1208 exige --evidence="referência do papel assinado"');

    if (estado1208.situacao === 'CONCLUIDO') {
      console.log('  ℹ️  sessão de 12/08 já concluída — será no-op');
    } else if (estado1208.situacao === 'PENDENTE') {
      console.log(`  ♻️  sessão de 12/08 existe em '${estado1208.appt.operationalStatus}' — será reutilizada`);
    } else {
      console.log(`  ✅ nenhum appointment em ${SESSAO_REAL.date} ${SESSAO_REAL.time}`);
    }

    const doctor = await mongoose.model('Doctor').findById(SESSAO_REAL.doctorId).lean();
    if (!doctor) problemas.push('profissional da sessão real não encontrado');
    else if (doctor.specialty !== guide.specialty) {
      problemas.push(`profissional atende ${doctor.specialty}, guia autoriza ${guide.specialty}`);
    } else console.log(`  ✅ ${doctor.fullName} atende ${guide.specialty}`);

    if (String(plan.patient) !== SESSAO_REAL.patientId) problemas.push('paciente do plano difere do esperado');
  }

  const { final } = projetarSaldo(estado);
  if (final !== USED_SESSIONS_ESPERADO) {
    problemas.push(`projeção final é ${final}/${guide.totalSessions}, esperado ${USED_SESSIONS_ESPERADO}` +
      (CONFIRM_1208 ? '' : ' — falta --confirm-real-session-1208'));
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
    console.log('\nNada foi gravado. Para aplicar:');
    console.log('  --apply --confirm-real-session-1208 --evidence="..."\n');
    await mongoose.disconnect();
    return;
  }

  const nadaAFazer = !alvosEstorno.length && !reaisParaReclassificar.length
    && !planoPrecisaCorrigir && estado1208.situacao === 'CONCLUIDO';
  if (nadaAFazer) {
    console.log('\n✅ NO-OP — reparo já aplicado anteriormente.\n');
    await mongoose.disconnect();
    return;
  }

  // ── TRANSAÇÃO: estornos + correção cadastral ──────────────────────────
  const mongoSession = await mongoose.startSession();
  try {
    await mongoSession.withTransaction(async () => {
      await assertNothingBilled(alvosEstorno.map(a => a._id), mongoSession);

      for (const appt of alvosEstorno) {
        const ev = evidencias.find(e => String(e.appointmentId) === String(appt._id));
        if (!ev) throw new Error(`ABORTADO: sem evidência de consumo para ${d10(appt.date)} ${appt.time}`);
        const r = await estornar(appt, mongoSession, guide, ev);
        console.log(`  ↩️  ${d10(appt.date)} ${appt.time} estornada` +
          ` (ledger ×${r.ledgerRevertido}, consumo ${r.consumoRemovido.slice(-6)} removido)`);
      }

      if (planoPrecisaCorrigir) {
        await InsurancePlan.updateOne({ _id: plan._id },
          { $set: { specialty: guide.specialty, updatedAt: new Date() } }, { session: mongoSession });
        console.log(`  🔧 plano: ${plan.specialty} → ${guide.specialty}`);
      }

      for (const appt of reaisParaReclassificar) {
        await reclassificar(appt, guide.specialty, mongoSession);
        console.log(`  🔧 ${d10(appt.date)} ${appt.time}: ${appt.specialty} → ${guide.specialty} (cadeia completa)`);
      }
    });
  } finally {
    await mongoSession.endSession().catch(() => {});
  }

  // ── Sessão real (fora da transação: completeSessionV2 gerencia a sua) ──
  //
  // Retomável: se a execução anterior estornou mas falhou ao concluir, o
  // appointment já existe em pre_agendado. Aqui ele é REUTILIZADO, não
  // recriado — senão a guia fecharia em 4/10 com duas sessões no mesmo horário.
  if (CONFIRM_1208 && estado1208.situacao === 'PENDENTE') {
    console.log(`  ♻️  retomando appointment existente (${String(estado1208.appt._id).slice(-6)})`);
    await completeSessionV2(estado1208.appt._id, {
      notes: `Atendimento realizado, concluído em retomada de reparo. Evidência: ${EVIDENCE.trim()}`,
      correlationId: `repair_icaro_resume_${Date.now()}`,
    });
    console.log(`  ✅ sessão de ${SESSAO_REAL.date} ${SESSAO_REAL.time} concluída`);
  } else if (CONFIRM_1208 && estado1208.situacao === 'AUSENTE') {
    const id = await criarSessaoReal(guide, plan, EVIDENCE.trim());
    console.log(`  ➕ sessão real de ${SESSAO_REAL.date} ${SESSAO_REAL.time} criada e concluída (${String(id).slice(-6)})`);
  }

  const falhas = await reconciliar();
  await mongoose.disconnect();
  if (falhas > 0) process.exit(3);
}

/**
 * RECONCILIAÇÃO FINAL — prova os 8 pontos, um a um.
 * Não basta a guia bater: o estado precisa ser coerente ponta a ponta.
 */
async function reconciliar() {
  const guide = await InsuranceGuide.findById(GUIDE_ID).lean();
  const plan = await InsurancePlan.findById(PLAN_ID).lean();
  const appts = await Appointment.find({ insurancePlan: oid(PLAN_ID) }).lean();

  const reais = appts.filter(a => a.operationalStatus === 'completed');
  const indevidos = [...FABRICADAS, ANOMALIA_1809];

  const sessionIdsReais = [];
  for (const a of reais) {
    const ss = await Session.find({ $or: [{ appointmentId: a._id }, { appointment: a._id }] }, { _id: 1, status: 1, specialty: 1 }).lean();
    ss.filter(s => s.status === 'completed').forEach(s => sessionIdsReais.push(s));
  }

  const paysReais = await Payment.find({
    appointment: { $in: reais.map(a => a._id) }, status: { $ne: 'canceled' }
  }).lean();
  const paysIndevidos = await Payment.find({ appointment: { $in: indevidos.map(oid) } }).lean();

  const ledger = mongoose.connection.collection('financial_ledger');
  const lancamentos = await ledger.find({ appointment: { $in: appts.map(a => a._id) } }).toArray();
  const liquido = lancamentos
    .filter(l => !l.reversedAt)
    .reduce((s, l) => s + Number(l.amount ?? l.value ?? 0), 0);

  const especialidades = new Set([
    plan.specialty,
    ...reais.map(a => a.specialty),
    ...sessionIdsReais.map(s => s.specialty).filter(Boolean),
    ...paysReais.map(p => p.specialty).filter(Boolean),
  ]);

  const checks = [
    ['guia.usedSessions = 3', guide.usedSessions === 3, `${guide.usedSessions}`],
    ['consumptionHistory = 3 consumos', (guide.consumptionHistory || []).length === 3, `${(guide.consumptionHistory || []).length}`],
    ['3 appointments reais completed', reais.length === 3, `${reais.length}`],
    ['3 Sessions canônicas completed', sessionIdsReais.length === 3, `${sessionIdsReais.length}`],
    ['3 Payments legítimos pending_billing',
      paysReais.length === 3 && paysReais.every(p => p.insurance?.status === 'pending_billing'),
      `${paysReais.length} pagto(s), status: ${[...new Set(paysReais.map(p => p.insurance?.status))].join('/')}`],
    ['6 Payments indevidos cancelados e fora do faturamento',
      paysIndevidos.length > 0 && paysIndevidos.every(p => p.status === 'canceled' && !p.insurance?.status),
      `${paysIndevidos.filter(p => p.status === 'canceled').length}/${paysIndevidos.length} cancelados, ` +
      `${paysIndevidos.filter(p => p.insurance?.status).length} ainda com insurance.status`],
    ['ledger líquido = R$ 240', Math.abs(liquido - 240) < 0.01, brl(liquido)],
    ['plano e reais em terapia_ocupacional',
      especialidades.size === 1 && especialidades.has('terapia_ocupacional'),
      [...especialidades].join(', ')],
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
  console.log(falhas === 0
    ? '✅ Estado consistente. Liberado para faturamento.\n'
    : `🚫 ${falhas} verificação(ões) falharam. NÃO fature antes de resolver.\n`);
  return falhas;
}

main().catch(err => { console.error(err); process.exit(1); });
