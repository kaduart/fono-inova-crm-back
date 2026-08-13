// back/services/insuranceGuide/migrateLegacyBatchesToInvoices.js
/**
 * Desmembra lotes legados em NFs por paciente + competência.
 *
 * PROBLEMA QUE RESOLVE
 * Os lotes legados criados por script agrupavam sessões por período de envio,
 * misturando pacientes e competências no mesmo documento — um deles reunia 4
 * pacientes e sessões de março e abril. Isso não é uma nota fiscal: uma NF é
 * emitida para UM paciente numa competência, podendo cobrir várias guias e
 * especialidades dele. Enquanto os lotes ficarem assim, não existe número de NF
 * que os represente, e sem `invoiceNumber` o `receiveInsuranceBatch` recusa a
 * baixa (INSURANCE_BATCH_INVOICE_REQUIRED).
 *
 * CHAVE DE AGRUPAMENTO
 *   insuranceProvider + patientId + YYYY-MM(Session.date)
 * A competência vem da data real da sessão, NUNCA de `sentDate` — o envio podia
 * acontecer meses depois do atendimento.
 *
 * O QUE ELE NÃO FAZ, POR DECISÃO
 *   - não chama transitionPaymentStatus, recordInsuranceBilled nem
 *     recordInsuranceReceived: os Payments já estão `billed` desde a época e
 *     refaturar geraria lançamento contábil novo sobre competência antiga
 *   - não escreve no FinancialLedger, caixa ou comissão
 *   - não cria, edita ou reativa Payment
 *   - não marca recebimento — a NF nasce faturada com saldo integral pendente
 *   - não reaproveita um lote antigo para o primeiro agrupamento: TODOS os lotes
 *     de origem viram `superseded`, e todos os novos são criados do zero. Reusar
 *     um e criar os outros deixaria a auditoria assimétrica.
 *
 * ISS
 * Os lotes novos gravam `issRate: 0` e `issAmount: 0` EXPLICITAMENTE. Não é
 * cosmético: `receiveInsuranceBatch` faz `if (issRate == null)` e busca a
 * alíquota ATUAL do convênio. Deixar null aplicaria a taxa de hoje sobre
 * faturamento de março e reduziria indevidamente o valor recebido.
 *
 * `dryRun` é o padrão. Nada é gravado sem `dryRun: false` explícito.
 */
import mongoose from 'mongoose';
import InsuranceBatch from '../../models/InsuranceBatch.js';
import Session from '../../models/Session.js';
import Payment from '../../models/Payment.js';
import Appointment from '../../models/Appointment.js';
import InsuranceGuide from '../../models/InsuranceGuide.js';
import Patient from '../../models/Patient.js';
import { resolveCanonicalPayment } from './reconcileLegacyInsuranceBatch.js';
import { saveToOutbox } from '../../infrastructure/outbox/outboxPattern.js';
import { createContextLogger } from '../../utils/logger.js';

const logger = createContextLogger('migrate_legacy_batches');

const MESES = ['JANEIRO', 'FEVEREIRO', 'MARCO', 'ABRIL', 'MAIO', 'JUNHO',
  'JULHO', 'AGOSTO', 'SETEMBRO', 'OUTUBRO', 'NOVEMBRO', 'DEZEMBRO'];

export const BLOCKING = {
  SESSION_NOT_FOUND: 'LEGACY_SESSION_NOT_FOUND',
  APPOINTMENT_INTEGRITY: 'LEGACY_APPOINTMENT_INTEGRITY_CONFLICT',
  GUIDE_NOT_FOUND: 'LEGACY_GUIDE_NOT_FOUND',
  PATIENT_NOT_FOUND: 'LEGACY_PATIENT_NOT_FOUND',
  PAYMENT_CONFLICT: 'LEGACY_PAYMENT_CONFLICT',
  PAYMENT_NOT_BILLED: 'LEGACY_PAYMENT_NOT_BILLED',
  SESSION_MOVED: 'LEGACY_SESSION_MOVED',
  INVOICE_NUMBER_DUPLICATE: 'LEGACY_INVOICE_NUMBER_DUPLICATE',
  VALUE_DECISION: 'NEEDS_HISTORICAL_VALUE_DECISION',
  PARTIAL_STATE: 'LEGACY_MIGRATION_PARTIAL_STATE',
  NO_ALLOWLIST: 'LEGACY_MIGRATION_ALLOWLIST_REQUIRED'
};

const idOf = v => (v?._id ?? v)?.toString() ?? null;
const round = v => Math.round((Number(v) + Number.EPSILON) * 100) / 100;

/** Nome do paciente no identificador provisório: 2 primeiros nomes, sem acento. */
export function patientSlug(fullName) {
  return String(fullName || '')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toUpperCase().replace(/[^A-Z ]/g, '')
    .trim().split(/\s+/).filter(Boolean).slice(0, 2).join('_');
}

/** PACIENTE-MES_ANO, ex.: DAVI_FELIPE-MARCO_2026 */
export function buildProvisionalInvoiceNumber(fullName, competence) {
  const [ano, mes] = String(competence).split('-');
  return `${patientSlug(fullName)}-${MESES[Number(mes) - 1]}_${ano}`;
}

/** Competência a partir da data da sessão, em UTC (as datas legadas são UTC). */
export function competenceOf(date) {
  const d = new Date(date);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

const CANCELADO = ['canceled', 'cancelled'];

/**
 * Valida que um Appointment realmente pertence à Session.
 *
 * Roda para TODOS os itens, inclusive os que já trazem `item.appointment`. Um id
 * que existe no banco não prova vínculo: o script legado podia ter copiado o
 * appointment de outra sessão, e a NF sairia apontando para o atendimento errado
 * sem nada acusar. Existência não é integridade.
 */
export function validateAppointmentAgainstSession(appt, session) {
  if (idOf(appt.patient) !== idOf(session.patient)) {
    return `paciente do Appointment (${idOf(appt.patient)}) difere da Session (${idOf(session.patient)})`;
  }
  if (session.doctor && appt.doctor && idOf(appt.doctor) !== idOf(session.doctor)) {
    return `profissional do Appointment (${idOf(appt.doctor)}) difere da Session (${idOf(session.doctor)})`;
  }
  const dS = new Date(session.date), dA = new Date(appt.date);
  if (dS.toISOString().slice(0, 10) !== dA.toISOString().slice(0, 10)) {
    return `data do Appointment (${dA.toISOString().slice(0, 10)}) difere da Session (${dS.toISOString().slice(0, 10)})`;
  }
  if (session.time && appt.time && String(session.time) !== String(appt.time)) {
    return `horário do Appointment (${appt.time}) difere da Session (${session.time})`;
  }
  if (CANCELADO.includes(appt.status) || CANCELADO.includes(appt.operationalStatus) || CANCELADO.includes(appt.clinicalStatus)) {
    return `Appointment cancelado (${appt.operationalStatus ?? appt.status})`;
  }
  // Quando a Session aponta para outro appointment, o do item é suspeito.
  const vinculo = idOf(session.appointmentId);
  if (vinculo && vinculo !== idOf(appt._id)) {
    return `Appointment ${idOf(appt._id)} conflita com Session.appointmentId (${vinculo})`;
  }
  return null;
}

/**
 * Appointment do item. O legado tem itens com `appointment: null`, e o campo é
 * `required` no subschema do lote — sem ele o lote novo nem valida.
 *
 * A recuperação é por vínculo EXATO (`Session.appointmentId`), nunca por
 * aproximação de data ou paciente: casar por proximidade vincularia a NF ao
 * atendimento errado, e o erro só apareceria numa auditoria futura.
 */
export async function resolveItemAppointment(item, session, mongoSession = null) {
  const direto = idOf(item.appointment);
  const alvo = direto || idOf(session.appointmentId);
  if (!alvo) {
    return { appointmentId: null, conflict: 'item sem appointment e Session.appointmentId ausente' };
  }

  const appt = await Appointment.findById(alvo).session(mongoSession).lean();
  if (!appt) {
    return {
      appointmentId: null,
      conflict: direto ? `appointment ${alvo} do item não existe` : `Session.appointmentId ${alvo} não existe`
    };
  }

  const erro = validateAppointmentAgainstSession(appt, session);
  if (erro) return { appointmentId: null, conflict: erro };

  return { appointmentId: appt._id, conflict: null, recovered: !direto };
}

/**
 * Monta os agrupamentos a partir dos lotes de origem. Somente leitura.
 *
 * @param {Object} opts
 * @param {string[]} [opts.sourceBatchIds] - lotes de origem; default = legados sem NF e com sessões
 * @returns {Promise<{groups: Array, conflicts: Array, totals: Object}>}
 */
export async function buildLegacyInvoiceGroups({ sourceBatchIds = null, mongoSession = null } = {}) {
  const query = sourceBatchIds?.length
    ? { _id: { $in: sourceBatchIds.map(id => new mongoose.Types.ObjectId(id)) } }
    : {
        $or: [{ invoiceNumber: { $exists: false } }, { invoiceNumber: null }, { invoiceNumber: '' }],
        'sessions.0': { $exists: true },
        status: { $nin: ['superseded', 'voided'] }
      };

  const batches = await InsuranceBatch.find(query).session(mongoSession).lean();
  const groups = new Map();
  const conflicts = [];
  let itemCount = 0;

  for (const batch of batches) {
    for (const item of batch.sessions || []) {
      itemCount++;
      const ctx = { sourceBatchId: idOf(batch._id), sessionId: idOf(item.session) };

      const session = await Session.findById(item.session).session(mongoSession).lean();
      if (!session) { conflicts.push({ ...ctx, code: BLOCKING.SESSION_NOT_FOUND }); continue; }

      // A sessão precisa continuar no lote de origem. Se saiu depois do dry-run,
      // migrar aqui a colocaria em duas NFs.
      if (idOf(session.billingBatchId) !== idOf(batch._id)) {
        conflicts.push({ ...ctx, code: BLOCKING.SESSION_MOVED, detail: `billingBatchId=${idOf(session.billingBatchId)}` });
        continue;
      }

      const { appointmentId, conflict: apptConflict, recovered } = await resolveItemAppointment(item, session, mongoSession);
      if (apptConflict) { conflicts.push({ ...ctx, code: BLOCKING.APPOINTMENT_INTEGRITY, detail: apptConflict }); continue; }

      // Guia ausente bloqueia: a NF precisa dizer sob qual autorização cobrou.
      // Item com `guide: null` gera nota que não se concilia com o convênio.
      if (!session.insuranceGuide) {
        conflicts.push({ ...ctx, code: BLOCKING.GUIDE_NOT_FOUND, detail: 'Session.insuranceGuide ausente' });
        continue;
      }
      const guide = await InsuranceGuide.findById(session.insuranceGuide).session(mongoSession).lean();
      if (!guide) {
        conflicts.push({ ...ctx, code: BLOCKING.GUIDE_NOT_FOUND, detail: `guia ${idOf(session.insuranceGuide)} não existe` });
        continue;
      }

      const candidates = await Payment.find({ session: session._id, billingType: 'convenio' }).session(mongoSession).lean();
      const { payment, conflict: payConflict } = resolveCanonicalPayment(candidates);
      if (payConflict) { conflicts.push({ ...ctx, code: BLOCKING.PAYMENT_CONFLICT, detail: payConflict }); continue; }
      if (payment.insurance?.status !== 'billed') {
        conflicts.push({ ...ctx, code: BLOCKING.PAYMENT_NOT_BILLED, detail: `insurance.status=${payment.insurance?.status}` });
        continue;
      }

      // Sem paciente com nome, o identificador provisório sairia como "-MARCO_2026".
      const patient = await Patient.findById(session.patient).select('fullName').session(mongoSession).lean();
      if (!patient || !patientSlug(patient.fullName)) {
        conflicts.push({ ...ctx, code: BLOCKING.PATIENT_NOT_FOUND, detail: `paciente ${idOf(session.patient)} ausente ou sem nome utilizável` });
        continue;
      }
      const competence = competenceOf(session.date);
      const key = `${batch.insuranceProvider}|${idOf(session.patient)}|${competence}`;

      if (!groups.has(key)) {
        groups.set(key, {
          key,
          provisionalInvoiceNumber: buildProvisionalInvoiceNumber(patient?.fullName, competence),
          provider: batch.insuranceProvider,
          patientId: idOf(session.patient),
          patientName: patient?.fullName ?? null,
          competence,
          sourceBatchIds: new Set(),
          guideIds: new Set(),
          items: [],
          recoveredAppointments: 0
        });
      }
      const g = groups.get(key);
      g.sourceBatchIds.add(idOf(batch._id));
      if (guide) g.guideIds.add(idOf(guide._id));
      if (recovered) g.recoveredAppointments++;

      // O valor vem do item congelado do lote — é o que foi cobrado à época.
      // netAmount é normalizado para o gross: os lotes não têm ISS e parte dos
      // itens legados trazia net divergente (140 sobre gross 80, e um com 0).
      const grossAmount = round(item.grossAmount || 0);
      const canonicalGross = round(
        payment.insurance?.grossAmount > 0 ? payment.insurance.grossAmount : (payment.amount || 0)
      );
      g.items.push({
        session: session._id,
        sessionDate: session.date,
        appointment: appointmentId,
        guide: guide._id,
        payment: payment._id,
        grossAmount,
        netAmount: grossAmount,
        status: 'sent',
        sentAt: batch.sentDate ?? batch.createdAt ?? null,
        // não vai para o documento — só alimenta a conferência abaixo
        _canonicalGross: canonicalGross,
        _sourceBatchId: idOf(batch._id)
      });
    }
  }

  const list = [...groups.values()].map(g => {
    const dates = g.items.map(i => new Date(i.sessionDate)).sort((a, b) => a - b);
    const totalGross = round(g.items.reduce((s, i) => s + i.grossAmount, 0));
    const canonicalGross = round(g.items.reduce((s, i) => s + i._canonicalGross, 0));
    return {
      ...g,
      sourceBatchIds: [...g.sourceBatchIds],
      guideIds: [...g.guideIds],
      sessionCount: g.items.length,
      totalGross,
      totalNet: totalGross,
      canonicalGross,
      valueDifference: round(totalGross - canonicalGross),
      startDate: dates[0] ?? null,
      endDate: dates[dates.length - 1] ?? null
    };
  }).sort((a, b) => a.competence.localeCompare(b.competence) || String(a.patientName).localeCompare(String(b.patientName)));

  // Divergência entre o valor congelado no lote e a soma dos Payments canônicos.
  // Nunca é resolvida em silêncio: o lote legado foi reconstruído por script, e o
  // valor embutido não prova sozinho o que foi faturado. Adotar um dos dois sem
  // decisão explícita significa emitir NF — e depois baixar — pelo valor errado.
  const valueDecisions = [];
  const porLoteOrigem = new Map();
  for (const g of list) {
    for (const it of g.items) {
      const bid = it._sourceBatchId;
      if (!porLoteOrigem.has(bid)) porLoteOrigem.set(bid, { documentedGross: 0, canonicalPaymentGross: 0 });
      const acc = porLoteOrigem.get(bid);
      acc.documentedGross = round(acc.documentedGross + it.grossAmount);
      acc.canonicalPaymentGross = round(acc.canonicalPaymentGross + it._canonicalGross);
    }
  }
  for (const [batchId, v] of porLoteOrigem) {
    const difference = round(v.documentedGross - v.canonicalPaymentGross);
    if (difference !== 0) {
      valueDecisions.push({
        sourceBatchId: batchId,
        documentedGross: v.documentedGross,
        canonicalPaymentGross: v.canonicalPaymentGross,
        difference,
        status: BLOCKING.VALUE_DECISION
      });
    }
  }

  return {
    groups: list,
    conflicts,
    valueDecisions,
    totals: {
      sourceBatches: batches.length,
      sourceItems: itemCount,
      groupedSessions: list.reduce((s, g) => s + g.sessionCount, 0),
      totalGross: round(list.reduce((s, g) => s + g.totalGross, 0)),
      canonicalGross: round(list.reduce((s, g) => s + g.canonicalGross, 0))
    }
  };
}

/**
 * Executa a migração. Tudo numa transação: ou os 15 lotes nascem e os 9 viram
 * superseded, ou nada acontece.
 *
 * @param {Object} opts
 * @param {string} opts.userId
 * @param {boolean} [opts.dryRun=true]
 * @param {string[]} [opts.sourceBatchIds]
 */
export async function migrateLegacyBatchesToInvoices({
  userId,
  dryRun = true,
  sourceBatchIds = null,
  historicalOverrides = {},
  reason = 'Desmembramento de lotes legados em NFs por paciente e competência'
} = {}) {
  // Escrita sem allowlist é proibida: a descoberta automática varre a base e
  // alcançaria lotes que ninguém revisou. Diagnóstico pode; produzir não.
  if (!dryRun && !sourceBatchIds?.length) {
    return {
      dryRun, written: false, blocked: true, groups: [], conflicts: [{
        code: BLOCKING.NO_ALLOWLIST,
        detail: 'execução com escrita exige sourceBatchIds explícitos'
      }], valueDecisions: [], totals: {}
    };
  }

  // ─── Idempotência: os lotes de origem já foram migrados? ────────────────────
  if (sourceBatchIds?.length) {
    const origens = await InsuranceBatch.find({ _id: { $in: sourceBatchIds.map(id => new mongoose.Types.ObjectId(id)) } })
      .select('_id status supersededByBatchIds').lean();
    const jaMigrados = origens.filter(b => b.status === 'superseded');

    if (jaMigrados.length === origens.length && origens.length > 0) {
      // Todos substituídos: confirma que os sucessores existem e seguram as sessões.
      const sucessores = [...new Set(jaMigrados.flatMap(b => (b.supersededByBatchIds || []).map(idOf)))];
      const vivos = await InsuranceBatch.countDocuments({
        _id: { $in: sucessores.map(id => new mongoose.Types.ObjectId(id)) },
        status: { $nin: ['superseded', 'voided'] }
      });
      const vinculadas = await Session.countDocuments({
        billingBatchId: { $in: sucessores.map(id => new mongoose.Types.ObjectId(id)) }
      });
      if (vivos !== sucessores.length) {
        return { dryRun, written: false, blocked: true, idempotent: false, groups: [], valueDecisions: [], totals: {},
          conflicts: [{ code: BLOCKING.PARTIAL_STATE, detail: `${vivos} de ${sucessores.length} sucessores ativos` }] };
      }
      return {
        dryRun, written: false, blocked: false, idempotent: true,
        supersededBatchIds: origens.map(b => idOf(b._id)),
        successorBatchIds: sucessores,
        linkedSessions: vinculadas,
        groups: [], conflicts: [], valueDecisions: [], totals: {}
      };
    }

    if (jaMigrados.length > 0) {
      return { dryRun, written: false, blocked: true, idempotent: false, groups: [], valueDecisions: [], totals: {},
        conflicts: [{
          code: BLOCKING.PARTIAL_STATE,
          detail: `${jaMigrados.length} de ${origens.length} lotes já estão superseded`,
          supersededBatchIds: jaMigrados.map(b => idOf(b._id))
        }] };
    }
  }

  const preview = await buildLegacyInvoiceGroups({ sourceBatchIds });

  if (preview.conflicts.length) {
    return { dryRun, written: false, blocked: true, idempotent: false, ...preview };
  }
  if (preview.totals.groupedSessions !== preview.totals.sourceItems) {
    return {
      dryRun, written: false, blocked: true, idempotent: false, ...preview,
      conflicts: [{ code: 'LEGACY_SESSION_COUNT_MISMATCH', detail: `${preview.totals.groupedSessions} agrupadas != ${preview.totals.sourceItems} de origem` }]
    };
  }

  // ─── Divergência de valor exige override explícito e auditável ──────────────
  const pendentes = preview.valueDecisions.filter(d => {
    const ov = historicalOverrides[d.sourceBatchId];
    if (!ov) return true;
    if (![d.documentedGross, d.canonicalPaymentGross].includes(ov.acceptedGross)) return true;
    return !ov.reason || !ov.evidence;
  });
  if (pendentes.length) {
    return {
      dryRun, written: false, blocked: true, idempotent: false, ...preview,
      conflicts: pendentes.map(d => ({
        code: BLOCKING.VALUE_DECISION,
        sourceBatchId: d.sourceBatchId,
        detail: `documentedGross=${d.documentedGross} canonicalPaymentGross=${d.canonicalPaymentGross} difference=${d.difference} — exige historicalOverrides com acceptedGross, reason e evidence`
      }))
    };
  }

  // Override que escolhe o canônico reescreve os ITENS, não só o total — a
  // invariante soma(itens) === totalGross não pode ser quebrada.
  for (const d of preview.valueDecisions) {
    const ov = historicalOverrides[d.sourceBatchId];
    if (ov.acceptedGross !== d.canonicalPaymentGross) continue;
    for (const g of preview.groups) {
      let mudou = false;
      for (const it of g.items) {
        if (it._sourceBatchId === d.sourceBatchId && it.grossAmount !== it._canonicalGross) {
          it.grossAmount = it._canonicalGross;
          it.netAmount = it._canonicalGross;
          mudou = true;
        }
      }
      if (mudou) {
        g.totalGross = round(g.items.reduce((s, i) => s + i.grossAmount, 0));
        g.totalNet = g.totalGross;
      }
    }
  }
  preview.totals.totalGross = round(preview.groups.reduce((s, g) => s + g.totalGross, 0));

  // Colisão do número provisório com NF ativa já existente.
  for (const g of preview.groups) {
    const dup = await InsuranceBatch.findOne({
      insuranceProvider: g.provider,
      invoiceNumber: g.provisionalInvoiceNumber,
      status: { $nin: ['superseded', 'voided'] }
    }).select('_id').lean();
    if (dup) {
      return {
        dryRun, written: false, blocked: true, idempotent: false, ...preview,
        conflicts: [{ code: BLOCKING.INVOICE_NUMBER_DUPLICATE, detail: `${g.provisionalInvoiceNumber} já existe (${dup._id})` }]
      };
    }
  }

  if (dryRun) return { dryRun: true, written: false, blocked: false, idempotent: false, ...preview };

  const sourceIds = [...new Set(preview.groups.flatMap(g => g.sourceBatchIds))];
  const mongoSession = await mongoose.startSession();
  // Só recebe os ids DEPOIS do commit. `withTransaction` pode repetir o callback
  // num erro transitório, e um array externo mutável acumularia ids de tentativas
  // abortadas junto com os da tentativa boa.
  let committed = null;
  try {
    await mongoSession.withTransaction(async () => {
      const now = new Date();
      const created = [];   // escopo POR TENTATIVA

      for (const g of preview.groups) {
        const correlationId = `legacy_invoice_${g.provider}_${g.patientId}_${g.competence}`;
        const docs = await InsuranceBatch.create([{
          batchNumber: `LEGACY-${g.provisionalInvoiceNumber}`,
          insuranceProvider: g.provider,
          patient: new mongoose.Types.ObjectId(g.patientId),
          startDate: g.startDate,
          endDate: g.endDate,
          sentDate: g.startDate,
          sessions: g.items.map(({ _canonicalGross, _sourceBatchId, ...item }) => item),
          totalGross: g.totalGross,
          totalNet: g.totalNet,
          totalSessions: g.sessionCount,
          // Explícito, nunca null: receiveInsuranceBatch buscaria a alíquota
          // ATUAL do convênio e a aplicaria sobre faturamento histórico.
          issRate: 0,
          issAmount: 0,
          totalGlosa: 0,
          receivedAmount: 0,
          receivedAt: null,
          invoiceNumber: g.provisionalInvoiceNumber,
          status: 'sent',
          origin: 'legacy_reconciliation',
          sourceLegacyBatchIds: g.sourceBatchIds.map(id => new mongoose.Types.ObjectId(id)),
          createdBy: new mongoose.Types.ObjectId(userId),
          correlationId
        }], { session: mongoSession });
        const batch = docs[0];
        created.push({ batchId: idOf(batch._id), invoiceNumber: g.provisionalInvoiceNumber, sessions: g.sessionCount, totalGross: g.totalGross });

        // O filtro exige que a sessão ainda esteja num dos lotes de origem.
        // Se saiu desde o preflight, modifiedCount não bate e tudo é revertido.
        const link = await Session.updateMany(
          { _id: { $in: g.items.map(i => i.session) }, billingBatchId: { $in: sourceIds.map(id => new mongoose.Types.ObjectId(id)) } },
          { $set: { billingBatchId: batch._id } },
          { session: mongoSession }
        );
        if (link.modifiedCount !== g.items.length) {
          throw new Error(`${BLOCKING.SESSION_MOVED}: ${g.provisionalInvoiceNumber} vinculou ${link.modifiedCount} de ${g.items.length}`);
        }
      }

      const novosIds = created.map(c => new mongoose.Types.ObjectId(c.batchId));
      for (const sid of sourceIds) {
        const origem = await InsuranceBatch.findById(sid).session(mongoSession).lean();
        const sucessores = created
          .filter(c => preview.groups.find(g => g.provisionalInvoiceNumber === c.invoiceNumber)?.sourceBatchIds.includes(sid))
          .map(c => new mongoose.Types.ObjectId(c.batchId));

        // `updateOne` e não `.save()`: o save valida o documento INTEIRO, e os
        // lotes legados têm itens que violam o schema atual (ex.: 69ea13db tem
        // `sessions[].appointment` nulo, e o campo é required). Marcar como
        // superseded não pode depender de o lote antigo estar íntegro — ele é
        // justamente o que está sendo aposentado por não estar.
        await InsuranceBatch.updateOne(
          { _id: origem._id },
          {
            $set: {
              statusBeforeInvalidation: origem.status,
              status: 'superseded',
              supersededByBatchIds: sucessores,
              supersededAt: now,
              supersededBy: new mongoose.Types.ObjectId(userId),
              supersededReason: reason
            }
          },
          { session: mongoSession }
        );

        await saveToOutbox({
          eventId: `insurance_batch_superseded_${sid}_${now.getTime()}`,
          eventType: 'INSURANCE_BATCH_SUPERSEDED',
          aggregateType: 'insurance_batch',
          aggregateId: origem._id,
          correlationId: `legacy_migration_${now.getTime()}`,
          payload: {
            batchId: sid,
            statusBeforeInvalidation: origem.status,
            supersededByBatchIds: sucessores.map(String),
            supersededAt: now,
            supersededBy: String(userId),
            reason
          }
        }, mongoSession);
      }

      // Revalidação pré-commit: nada além do previsto pode ter mudado.
      const totalNovo = created.reduce((s, c) => s + c.totalGross, 0);
      if (round(totalNovo) !== preview.totals.totalGross) {
        throw new Error(`LEGACY_TOTAL_MISMATCH: ${totalNovo} != ${preview.totals.totalGross}`);
      }
      const vinculadas = await Session.countDocuments({ billingBatchId: { $in: novosIds } }, { session: mongoSession });
      if (vinculadas !== preview.totals.sourceItems) {
        throw new Error(`LEGACY_LINK_MISMATCH: ${vinculadas} sessões vinculadas != ${preview.totals.sourceItems}`);
      }

      // Publica só no fim da tentativa que chegou até aqui. Se o driver repetir
      // o callback, `created` nasce vazio de novo e `committed` é sobrescrito —
      // nunca acumula ids de uma tentativa abortada.
      committed = created;
    });

    logger.info('migração legada concluída', { lotesCriados: committed.length, lotesSubstituidos: sourceIds.length });
    return { dryRun: false, written: true, blocked: false, idempotent: false, created: committed, supersededBatchIds: sourceIds, ...preview };
  } finally {
    await mongoSession.endSession();
  }
}

export const __testables = { patientSlug, buildProvisionalInvoiceNumber, competenceOf, resolveItemAppointment };
