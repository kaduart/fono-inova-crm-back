// services/attribution/revenueAttribution.js
// Frente 2 — Attribution: receita RECEBIDA por campanha (somente leitura).
//
// Fonte do dinheiro: FinancialLedger (livro-razão imutável), NUNCA AdConversion.value nem
// Appointment.sessionValue (que é o que os painéis antigos somam). Conta só CAIXA efetivo,
// líquido de estornos/reversões — mesma definição de caixa do workers/reconciliationWorker.js
// (CASH_LEDGER_TYPES / CASH_ADJUSTMENT_TYPES):
//
//   entra (+) : payment_received  (pagamento confirmado; amount = valor pago)
//               package_purchase  (1 lançamento por Payment de pacote com status 'paid';
//                                  amount = payment.amount, NÃO o valor total do pacote —
//                                  ver services/financialLedgerService.js#recordPackagePurchase e
//                                  controllers/packageController.v2.js#createPrepaidPayments)
//               insurance_received (repasse do convênio; amount = valor líquido recebido,
//                                  após ISS/glosa — services/billing/insuranceBilling.js)
//   sai  (-)  : refund / reversal / write_off SÓ quando vinculados a um pagamento
//               (campo `payment` ou `reversalOfEntryId`). A reversão de cancelamento de sessão
//               (recordSessionCancellationReversal) não tem `payment`: ela desfaz
//               revenue_recognition (contábil), não devolve dinheiro — fica fora.
//   fora      : revenue_recognition, package_consumed (reconhecimento contábil), payment_pending,
//               insurance_billed (conta a receber), adjustment, transfer. Aparecem em `excluidos`.
//
// O sinal vem de `direction` (credit/debit), nunca do nome do tipo.
//
// Origem (por PACIENTE, first-touch):
//   1) AdConversion com isAcquisition=true do paciente (source/campaign/adId/método/click ids);
//   2) se não houver origem ali (ou source='unknown'): LeadAttribution pelo telefone do paciente
//      (variantes com/sem o 9 — phoneKey), a mais antiga;
//   3) senão: linha "sem vínculo", com o motivo.
// Nível de evidência:
//   comprovada  = click id (gclid/fbc/ttclid/ctwaClid) ou método ctwa/site_signature/token,
//                 num telefone usado por UM só paciente;
//   provavel    = sinal forte num telefone compartilhado (irmãos, mãe com 2 filhos), ou só
//                 palavra-chave/manual/lead/método desconhecido;
//   sem_vinculo = nenhuma origem.
// Invariante: comprovada + provavel + sem_vinculo === total líquido do ledger no período.
//
// Tudo em centavos inteiros por dentro (sem erro de ponto flutuante); a saída é em reais.

import { normalizeE164BR } from '../../utils/phone.js';
import { phoneKey } from '../../routes/analytics/funnel.logic.js';

export const CASH_CREDIT_TYPES = Object.freeze(['payment_received', 'package_purchase', 'insurance_received']);
export const CASH_DEBIT_TYPES = Object.freeze(['refund', 'reversal', 'write_off']);
export const STRONG_METHODS = Object.freeze(['ctwa', 'site_signature', 'token']);
export const LEVELS = Object.freeze(['comprovada', 'provavel', 'sem_vinculo']);

const id = (v) => (v == null ? null : String(v));
const toCents = (n) => Math.round(Number(n || 0) * 100);
const toReais = (c) => c / 100;
const keyOfPhone = (raw) => phoneKey(normalizeE164BR(raw) || null);

/**
 * Decide se um lançamento do ledger é CAIXA e com qual sinal.
 * @returns {{ counted: true, signedCents: number } | { counted: false, reason: string }}
 */
export function classifyLedgerEntry(e = {}) {
  const amount = toCents(e.amount);
  const sign = e.direction === 'debit' ? -1 : 1;
  if (CASH_CREDIT_TYPES.includes(e.type)) return { counted: true, signedCents: sign * amount };
  if (CASH_DEBIT_TYPES.includes(e.type)) {
    if (e.payment || e.reversalOfEntryId) return { counted: true, signedCents: sign * amount };
    return { counted: false, reason: `${e.type}_sem_vinculo_de_caixa` };
  }
  return { counted: false, reason: e.type || 'tipo_ausente' };
}

function hasClickId(o = {}) {
  return Boolean(o.gclid || o.fbc || o.fbclid || o.ttclid || o.ctwaClid);
}

/**
 * Núcleo PURO. Não toca em banco.
 *
 * @param {object} input
 * @param {Array} input.ledgerEntries      lançamentos do período (lean): _id type direction amount patient payment reversalOfEntryId
 * @param {Array} [input.referenceEntries] lançamentos FORA do período só para achar o paciente de uma
 *                                         reversão/estorno (não entram na soma)
 * @param {Array} [input.adConversions]    AdConversion (lean) dos pacientes e dos telefones envolvidos
 * @param {Array} [input.leadAttributions] LeadAttribution (lean) dos telefones envolvidos
 * @param {Array} [input.patients]         [{ _id, phone }] — pacientes do ledger E quem divide telefone com eles
 */
export function attributeReceivedRevenue({
  ledgerEntries = [],
  referenceEntries = [],
  adConversions = [],
  leadAttributions = [],
  patients = [],
} = {}) {
  // ── 1. Telefone de cada paciente e quantos pacientes usam cada telefone ──────
  const phoneByPatient = new Map();
  const ownersByPhone = new Map(); // phoneKey -> Set(patientId)
  const addOwner = (k, pid) => {
    if (!k || !pid) return;
    if (!ownersByPhone.has(k)) ownersByPhone.set(k, new Set());
    ownersByPhone.get(k).add(pid);
  };
  for (const p of patients) {
    const k = keyOfPhone(p.phone);
    if (k) phoneByPatient.set(id(p._id), k);
    addOwner(k, id(p._id));
  }
  const acquisitionByPatient = new Map();
  for (const c of adConversions) {
    const pid = id(c.patient);
    addOwner(keyOfPhone(c.phone), pid);
    if (pid && c.isAcquisition && !acquisitionByPatient.has(pid)) acquisitionByPatient.set(pid, c);
  }
  // LeadAttribution: a mais antiga entre as variantes do telefone (first-touch)
  const attrByPhone = new Map();
  for (const a of leadAttributions) {
    const k = keyOfPhone(a.phone);
    if (!k) continue;
    const cur = attrByPhone.get(k);
    const t = a.firstMessageAt ? new Date(a.firstMessageAt).getTime() : Infinity;
    const tc = cur?.firstMessageAt ? new Date(cur.firstMessageAt).getTime() : Infinity;
    if (!cur || t < tc) attrByPhone.set(k, a);
  }

  // ── 2. Origem + nível por paciente ───────────────────────────────────────────
  const originCache = new Map();
  function resolveOrigin(pid) {
    if (!pid) return { nivel: 'sem_vinculo', motivo: 'lancamento_sem_paciente' };
    if (originCache.has(pid)) return originCache.get(pid);
    const acq = acquisitionByPatient.get(pid) || null;
    const phone = phoneByPatient.get(pid) || keyOfPhone(acq?.phone);
    const shared = phone ? (ownersByPhone.get(phone)?.size || 0) > 1 : false;

    let origin = null;
    if (acq && acq.source && acq.source !== 'unknown') {
      origin = {
        via: 'adConversion', source: acq.source, campaign: acq.campaign || null, adId: acq.adId || null,
        method: acq.attributionMethod || null, strong: hasClickId(acq) || STRONG_METHODS.includes(acq.attributionMethod),
      };
    } else if (phone && attrByPhone.has(phone)) {
      const a = attrByPhone.get(phone);
      origin = {
        via: 'leadAttribution', source: a.source, campaign: a.campaign || null, adId: a.adId || null,
        method: a.method || null, strong: hasClickId(a) || STRONG_METHODS.includes(a.method),
      };
    }

    let out;
    if (!origin || !origin.source) {
      const motivo = acq?.unknownReason || (!phone ? 'sem_telefone' : (acq ? 'sem_origem_capturada' : 'sem_aquisicao_e_sem_origem_no_telefone'));
      out = { nivel: 'sem_vinculo', motivo, telefoneCompartilhado: shared };
    } else {
      const nivel = origin.strong && !shared ? 'comprovada' : 'provavel';
      const motivo = nivel === 'comprovada' ? 'sinal_forte_telefone_exclusivo'
        : origin.strong ? 'sinal_forte_em_telefone_compartilhado' : 'so_sinal_fraco';
      out = { ...origin, nivel, motivo, telefoneCompartilhado: shared };
    }
    originCache.set(pid, out);
    return out;
  }

  // ── 3. Paciente de cada lançamento (reversão/estorno herdam do crédito) ──────
  const byId = new Map();
  const creditPatientByPayment = new Map();
  for (const e of [...referenceEntries, ...ledgerEntries]) {
    byId.set(id(e._id), e);
    if (e.payment && e.patient && CASH_CREDIT_TYPES.includes(e.type)) creditPatientByPayment.set(id(e.payment), id(e.patient));
  }
  const patientOf = (e) => id(e.patient)
    || (e.reversalOfEntryId ? id(byId.get(id(e.reversalOfEntryId))?.patient) : null)
    || (e.payment ? creditPatientByPayment.get(id(e.payment)) || null : null);

  // ── 4. Soma ──────────────────────────────────────────────────────────────────
  let netCents = 0;
  const levelCents = { comprovada: 0, provavel: 0, sem_vinculo: 0 };
  const excluded = {};
  const lines = new Map();
  const semVinculo = { recebidoCents: 0, estornosCents: 0, liquidoCents: 0, pacientes: new Set(), lancamentos: 0, motivos: {} };

  for (const e of ledgerEntries) {
    const c = classifyLedgerEntry(e);
    if (!c.counted) {
      const x = excluded[c.reason] || (excluded[c.reason] = { lancamentos: 0, valorCents: 0 });
      x.lancamentos += 1; x.valorCents += toCents(e.amount);
      continue;
    }
    netCents += c.signedCents;
    const pid = patientOf(e);
    const o = resolveOrigin(pid);
    levelCents[o.nivel] += c.signedCents;
    const credit = c.signedCents > 0 ? c.signedCents : 0;
    const debit = c.signedCents < 0 ? -c.signedCents : 0;

    if (o.nivel === 'sem_vinculo') {
      semVinculo.recebidoCents += credit; semVinculo.estornosCents += debit; semVinculo.liquidoCents += c.signedCents;
      semVinculo.lancamentos += 1; if (pid) semVinculo.pacientes.add(pid);
      semVinculo.motivos[o.motivo] = (semVinculo.motivos[o.motivo] || 0) + c.signedCents;
      continue;
    }
    const campaignKey = o.campaign || o.adId || null;
    const k = `${o.nivel}|${o.source}|${campaignKey || ''}`;
    const line = lines.get(k) || {
      nivel: o.nivel, origem: o.source, campanha: o.campaign, adId: o.adId,
      recebidoCents: 0, estornosCents: 0, liquidoCents: 0, pacientes: new Set(), lancamentos: 0, motivos: {},
    };
    line.recebidoCents += credit; line.estornosCents += debit; line.liquidoCents += c.signedCents;
    line.lancamentos += 1; if (pid) line.pacientes.add(pid);
    line.motivos[o.motivo] = (line.motivos[o.motivo] || 0) + 1;
    lines.set(k, line);
  }

  const somaNiveis = levelCents.comprovada + levelCents.provavel + levelCents.sem_vinculo;
  const rank = { comprovada: 0, provavel: 1 };
  const linhas = [...lines.values()]
    .sort((a, b) => rank[a.nivel] - rank[b.nivel] || b.liquidoCents - a.liquidoCents || String(a.origem).localeCompare(String(b.origem)))
    .map((l) => ({
      nivel: l.nivel, origem: l.origem, campanha: l.campanha || null, adId: l.adId || null,
      recebido: toReais(l.recebidoCents), estornos: toReais(l.estornosCents), liquido: toReais(l.liquidoCents),
      pacientes: l.pacientes.size, lancamentos: l.lancamentos, motivosPorLancamento: l.motivos,
    }));

  return {
    totalLiquidoLedger: toReais(netCents),
    porNivel: {
      comprovada: toReais(levelCents.comprovada),
      provavel: toReais(levelCents.provavel),
      sem_vinculo: toReais(levelCents.sem_vinculo),
    },
    linhas,
    semVinculo: {
      recebido: toReais(semVinculo.recebidoCents), estornos: toReais(semVinculo.estornosCents),
      liquido: toReais(semVinculo.liquidoCents), pacientes: semVinculo.pacientes.size,
      lancamentos: semVinculo.lancamentos,
      motivos: Object.fromEntries(Object.entries(semVinculo.motivos).map(([m, v]) => [m, toReais(v)])),
    },
    invariante: { somaNiveis: toReais(somaNiveis), totalLiquidoLedger: toReais(netCents), fecha: somaNiveis === netCents },
    excluidos: Object.fromEntries(Object.entries(excluded).map(([t, x]) => [t, { lancamentos: x.lancamentos, valor: toReais(x.valorCents) }])),
  };
}

export const REGRAS = Object.freeze([
  'Dinheiro vem do FinancialLedger (occurredAt no período), nunca de AdConversion.value ou sessionValue.',
  'Conta: payment_received, package_purchase e insurance_received (créditos), menos refund/reversal/write_off vinculados a um pagamento.',
  'package_purchase = valor de cada Payment de pacote já pago (não o total do pacote). insurance_received = repasse líquido do convênio.',
  'Fora: revenue_recognition, package_consumed, payment_pending, insurance_billed, adjustment, transfer e reversão de sessão sem pagamento.',
  'Origem por paciente: AdConversion de aquisição; senão LeadAttribution pelo telefone; senão "sem vínculo".',
  'Comprovada = click id ou ctwa/assinatura do site/token em telefone de um só paciente. Provável = sinal forte em telefone compartilhado, ou só palavra-chave/manual.',
  'Invariante: comprovada + provável + sem vínculo = total líquido do ledger.',
]);

// ─────────────────────────────────────────────────────────────────────────────
// Loader: SOMENTE LEITURA (find().select().lean(); nenhuma escrita).
// Os models são injetáveis para teste; por padrão importa os reais sob demanda.
// ─────────────────────────────────────────────────────────────────────────────

function phoneVariantsOf(raw) {
  const n = normalizeE164BR(raw);
  if (!n) return [];
  const out = [n];
  const m = n.match(/^55(\d{2})(9?)(\d{8})$/);
  if (m) out.push(m[2] ? `55${m[1]}${m[3]}` : `55${m[1]}9${m[3]}`);
  return out;
}
// Formatos em que o telefone costuma estar gravado (55DD9…, +55DD9…, DD9…, com e sem o 9).
function phoneFormatsOf(raw) {
  return phoneVariantsOf(raw).flatMap((v) => [v, `+${v}`, v.slice(2)]);
}

async function defaultModels() {
  const [FinancialLedger, AdConversion, LeadAttribution, Patient] = await Promise.all([
    import('../../models/FinancialLedger.js'),
    import('../../models/AdConversion.js'),
    import('../../models/LeadAttribution.js'),
    import('../../models/Patient.js'),
  ]);
  return {
    FinancialLedger: FinancialLedger.default, AdConversion: AdConversion.default,
    LeadAttribution: LeadAttribution.default, Patient: Patient.default,
  };
}

const LEDGER_FIELDS = '_id type direction amount patient payment reversalOfEntryId occurredAt';
const ADCONV_FIELDS = '_id patient phone isAcquisition source attributionMethod campaign adId gclid fbc ttclid ctwaClid unknownReason';
const ATTR_FIELDS = '_id phone source method campaign adId gclid fbclid ttclid ctwaClid firstMessageAt';

/**
 * Carrega do Mongo (read-only) e calcula. `since`/`until` filtram FinancialLedger.occurredAt.
 */
export async function loadRevenueAttribution({ since, until, models } = {}) {
  const M = models || await defaultModels();
  const range = {};
  if (since) range.$gte = since;
  if (until) range.$lte = until;
  const ledgerFilter = Object.keys(range).length ? { occurredAt: range } : {};

  const ledgerEntries = await M.FinancialLedger.find(ledgerFilter).select(LEDGER_FIELDS).lean();

  // Paciente de reversão/estorno cujo crédito está fora do período
  const inPeriod = new Set(ledgerEntries.map((e) => id(e._id)));
  const missingTargets = [...new Set(ledgerEntries
    .filter((e) => !e.patient && e.reversalOfEntryId && !inPeriod.has(id(e.reversalOfEntryId)))
    .map((e) => id(e.reversalOfEntryId)))];
  const orphanPayments = [...new Set(ledgerEntries
    .filter((e) => !e.patient && e.payment && CASH_DEBIT_TYPES.includes(e.type))
    .map((e) => id(e.payment)))];
  const refOr = [];
  if (missingTargets.length) refOr.push({ _id: { $in: missingTargets } });
  if (orphanPayments.length) refOr.push({ payment: { $in: orphanPayments }, type: { $in: [...CASH_CREDIT_TYPES] } });
  const referenceEntries = refOr.length
    ? await M.FinancialLedger.find({ $or: refOr }).select('_id type patient payment').lean()
    : [];

  const patientIds = [...new Set([...ledgerEntries, ...referenceEntries].map((e) => id(e.patient)).filter(Boolean))];
  if (!patientIds.length) {
    return attributeReceivedRevenue({ ledgerEntries, referenceEntries });
  }

  const [ledgerPatients, ownConversions] = await Promise.all([
    M.Patient.find({ _id: { $in: patientIds } }).select('_id phone').lean(),
    M.AdConversion.find({ patient: { $in: patientIds } }).select(ADCONV_FIELDS).lean(),
  ]);

  const rawPhones = [...ledgerPatients.map((p) => p.phone), ...ownConversions.map((c) => c.phone)].filter(Boolean);
  const variants = [...new Set(rawPhones.flatMap(phoneVariantsOf))];
  const formats = [...new Set(rawPhones.flatMap(phoneFormatsOf))];

  const [sharingPatients, sharingConversions, leadAttributions] = variants.length
    ? await Promise.all([
        M.Patient.find({ phone: { $in: formats } }).select('_id phone').lean(),
        M.AdConversion.find({ phone: { $in: variants } }).select('_id patient phone').lean(),
        M.LeadAttribution.find({ phone: { $in: variants } }).select(ATTR_FIELDS).lean(),
      ])
    : [[], [], []];

  const seenPatients = new Set();
  const patients = [...ledgerPatients, ...sharingPatients].filter((p) => {
    const k = id(p._id); if (seenPatients.has(k)) return false; seenPatients.add(k); return true;
  });
  // Conversões de terceiros (outro paciente no mesmo telefone) só servem para detectar
  // compartilhamento: nunca como aquisição de quem pagou.
  const own = new Set(ownConversions.map((c) => id(c._id)));
  const adConversions = [
    ...ownConversions,
    ...sharingConversions.filter((c) => !own.has(id(c._id))).map((c) => ({ ...c, isAcquisition: false })),
  ];

  return attributeReceivedRevenue({ ledgerEntries, referenceEntries, adConversions, leadAttributions, patients });
}
