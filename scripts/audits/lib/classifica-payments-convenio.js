import Payment from '../../../models/Payment.js';
import Session from '../../../models/Session.js';
import InsuranceGuide from '../../../models/InsuranceGuide.js';
import InsuranceBatch from '../../../models/InsuranceBatch.js';

const ACTIVE_STATUSES = { $nin: ['canceled', 'cancelled', 'refunded'] };

function toStringId(value) {
  return value?.toString?.() || value;
}

async function loadClassificationData() {
  // Base: todos os payments de convênio ativos em algum estado recebível
  const candidates = await Payment.find({
    billingType: 'convenio',
    status: ACTIVE_STATUSES,
    'insurance.status': { $in: ['pending_billing', 'billed'] }
  })
    .select('amount status kind insurance.status insurance.billedAt insurance.receivedAt session appointment insuranceGuide createdAt')
    .populate({ path: 'session', select: 'status billingBatchId insuranceGuide appointmentId date time' })
    .lean();

  // Pré-carrega todas as sessões, guias e lotes relevantes para evitar N+1
  const sessionIds = new Set();
  const guideIds = new Set();
  for (const p of candidates) {
    if (p.session?._id) sessionIds.add(toStringId(p.session._id));
    if (p.session?.insuranceGuide) guideIds.add(toStringId(p.session.insuranceGuide));
    if (p.insuranceGuide) guideIds.add(toStringId(p.insuranceGuide));
  }

  const allSessions = await Session.find({ _id: { $in: Array.from(sessionIds) } })
    .select('status billingBatchId insuranceGuide appointmentId')
    .lean();
  const sessionMap = new Map(allSessions.map(s => [toStringId(s._id), s]));

  const allGuides = await InsuranceGuide.find({ _id: { $in: Array.from(guideIds) } })
    .select('status number usedSessions totalSessions')
    .lean();
  const guideMap = new Map(allGuides.map(g => [toStringId(g._id), g]));

  // Todos os Payments ativos por session (para detectar duplicatas)
  const paymentsBySession = await Payment.find({
    billingType: 'convenio',
    status: ACTIVE_STATUSES,
    session: { $exists: true, $ne: null }
  })
    .select('amount status kind insurance.status session createdAt')
    .lean();
  const sessionPayments = new Map();
  for (const p of paymentsBySession) {
    const sid = toStringId(p.session);
    if (!sessionPayments.has(sid)) sessionPayments.set(sid, []);
    sessionPayments.get(sid).push(p);
  }

  // Todos os lotes com os payments referenciados
  const batches = await InsuranceBatch.find({ 'sessions.payment': { $exists: true, $ne: null } })
    .select('batchNumber status sessions.payment sessions.session sentDate')
    .lean();
  const paymentInBatch = new Map();
  for (const b of batches) {
    for (const item of b.sessions || []) {
      if (item.payment) {
        paymentInBatch.set(toStringId(item.payment), {
          batchId: b._id,
          batchNumber: b.batchNumber,
          status: b.status,
          sentDate: b.sentDate
        });
      }
    }
  }

  return { candidates, sessionMap, guideMap, sessionPayments, paymentInBatch };
}

export async function classifyConvenioPayments() {
  const { candidates, sessionMap, guideMap, sessionPayments, paymentInBatch } = await loadClassificationData();

  const groups = {
    acaoSegura: [],
    revisaoManual: [],
    decisaoNegocio: [],
    naoTocar: []
  };

  for (const p of candidates) {
    const amount = p.amount || 0;
    const pId = toStringId(p._id);
    const session = sessionMap.get(toStringId(p.session)) || p.session;
    const sessionId = session ? toStringId(session._id) : null;
    const siblings = sessionId
      ? (sessionPayments.get(sessionId) || []).filter(x => toStringId(x._id) !== pId)
      : [];

    const guideId = session?.insuranceGuide || p.insuranceGuide;
    const guide = guideMap.get(toStringId(guideId));
    const guideStatus = guide?.status || 'sem_guia';

    const classification = {
      paymentId: pId,
      amount,
      status: p.status,
      insuranceStatus: p.insurance?.status,
      kind: p.kind,
      sessionId,
      appointmentId: p.appointment ? toStringId(p.appointment) : null,
      guideId: toStringId(guideId),
      guideStatus,
      reasons: [],
      group: null,
      raw: p
    };

    // 1. AÇÃO SEGURA: sessão cancelada + payment ativo pending_billing
    if (session?.status === 'canceled' && p.status !== 'canceled') {
      classification.group = 'acaoSegura';
      classification.reasons.push('sessão está cancelada, mas Payment ativo ainda representa débito de convênio');
      // Validação adicional: se há irmão billed, não deveria acontecer para sessão cancelada — manda pra revisão
      if (siblings.some(s => s.status === 'billed' || s.insurance?.status === 'billed')) {
        classification.group = 'revisaoManual';
        classification.reasons.push('sessão cancelada possui irmão billed — inconsistência grave, requer revisão');
      }
    }

    // 2. AÇÃO SEGURA: duplicata com irmão billed e lote referenciando o irmão
    else if (siblings.length > 0) {
      const billedSibling = siblings.find(s => s.status === 'billed' || s.insurance?.status === 'billed');
      if (billedSibling) {
        const siblingBatch = paymentInBatch.get(toStringId(billedSibling._id));
        const otherActive = siblings.length > 0;
        const siblingBilled = billedSibling.status === 'billed' || billedSibling.insurance?.status === 'billed';
        const siblingInBatch = !!siblingBatch;
        const valuesMatch = Math.abs((p.amount || 0) - (billedSibling.amount || 0)) < 0.01;

        const validations = [
          { ok: otherActive, text: otherActive ? 'existe outro Payment ativo para a mesma session' : 'não existe outro Payment ativo para a mesma session' },
          { ok: siblingBilled, text: siblingBilled ? 'irmão está em billed' : 'irmão billed não possui status billed' },
          { ok: siblingInBatch, text: siblingInBatch ? 'lote referencia o Payment billed' : 'lote não referencia o Payment billed' },
          { ok: valuesMatch, text: valuesMatch ? 'valores coincidem' : 'valores divergem entre duplicatas' }
        ];

        const allOk = validations.every(v => v.ok);
        if (allOk) {
          classification.group = 'acaoSegura';
          classification.reasons.push('duplicata: irmão billed já é referenciado pelo lote; este Payment é resíduo');
          classification.billedSiblingId = toStringId(billedSibling._id);
          classification.batch = siblingBatch;
        } else {
          classification.group = 'revisaoManual';
          classification.reasons.push('duplicata com irmão billed, mas validações não passaram');
          classification.validationFailures = validations.filter(v => !v.ok).map(v => v.text);
          classification.billedSiblingId = toStringId(billedSibling._id);
        }
      }
    }

    // 3. DECISÃO DE NEGÓCIO: guia expired/superseded/cancelled
    if (!classification.group && ['expired', 'superseded', 'cancelled'].includes(guideStatus)) {
      classification.group = 'decisaoNegocio';
      classification.reasons.push(`guia está com status '${guideStatus}' — decisão de negócio sobre cobrança`);
    }

    // 4. NÃO TOCAR: casos íntegros (ampliado)
    if (!classification.group) {
      const isLegit =
        (['scheduled', 'confirmed'].includes(session?.status) && p.insurance?.status === 'pending_billing') ||
        (session?.status === 'completed' && siblings.length === 0 && ['active', 'exhausted', 'linked', 'sem_guia'].includes(guideStatus)) ||
        (p.insurance?.status === 'billed' && siblings.length === 0) ||
        amount === 0;

      if (isLegit) {
        classification.group = 'naoTocar';
        if (amount === 0) classification.reasons.push('amount zero — sem impacto financeiro');
        else if (p.insurance?.status === 'billed' && siblings.length === 0) classification.reasons.push('Payment billed legítimo e único para a session');
        else if (['scheduled', 'confirmed'].includes(session?.status)) classification.reasons.push('sessão ainda não completada — Payment esperado');
        else classification.reasons.push('Payment legítimo de convênio sem duplicata');
      }
    }

    // 5. Fallback: REVISÃO MANUAL
    if (!classification.group) {
      classification.group = 'revisaoManual';
      if (siblings.length > 1) classification.reasons.push(`mais de um Payment ativo para a mesma session (${siblings.length + 1} total)`);
      if (!['session_payment', 'convenio_receivable', 'package_consumed', null].includes(p.kind)) classification.reasons.push(`kind inesperado: ${p.kind}`);
      if (!sessionId) classification.reasons.push('Payment sem session vinculada');
      if (!p.appointment) classification.reasons.push('Payment sem appointment vinculado');
      if (siblings.length > 0 && siblings.some(s => Math.abs((s.amount || 0) - amount) > 0.01)) classification.reasons.push('divergência de valores entre Payments da mesma session');
      if (classification.reasons.length === 0) classification.reasons.push('caso não se encaixa nos critérios automáticos');
    }

    groups[classification.group].push(classification);
  }

  // Ordena por valor descendente
  for (const key of Object.keys(groups)) {
    groups[key].sort((a, b) => b.amount - a.amount);
  }

  return { candidates, groups };
}

export default classifyConvenioPayments;
