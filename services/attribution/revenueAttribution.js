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
// Origem (por LANÇAMENTO, first-touch com data):
//   Cada recebimento só vai para uma campanha se houver prova de que o contato pela campanha
//   aconteceu ATÉ a data do recebimento (occurredAt). Data do contato:
//     - AdConversion de aquisição: eventTime (momento do agendamento, que vem depois do contato);
//       se uma LeadAttribution do telefone for do MESMO contato publicitário (mesmo canal e
//       mesmo click id, anúncio ou campanha), vale o firstMessageAt dela quando for anterior.
//       Mesmo canal sozinho NÃO antecipa: a LeadAttribution fica como candidata própria;
//     - LeadAttribution: firstMessageAt.
//   Ordem: 1) AdConversion com isAcquisition=true do paciente (source/campaign/adId/método/click ids);
//          2) LeadAttribution pelo telefone do paciente (variantes com/sem o 9 — phoneKey), da mais
//             antiga para a mais nova;
//          3) senão: linha "sem vínculo", com o motivo (ex.: contato_da_campanha_depois_do_recebimento).
//   Estorno/reversão desfaz o recebimento ORIGINAL: usa a campanha e o nível daquele recebimento
//   (resolvidos na data dele), nunca a origem atual do paciente.
// Nível de evidência:
//   comprovada  = click id (gclid/fbc/ttclid/ctwaClid) ou método ctwa/site_signature/token,
//                 num telefone usado por UM só paciente;
//   provavel    = sinal forte num telefone compartilhado (irmãos, mãe com 2 filhos), ou só
//                 palavra-chave/manual/lead/método desconhecido;
//   sem_vinculo = nenhuma origem com contato até a data do recebimento.
// Telefone compartilhado é SEMPRE "provável": o CRM não tem prova individual da aquisição.
//   - AdConversion.patient é por agendamento, mas source/click ids vêm do TELEFONE
//     (getAttributionByPhone no crons/adsConversion.cron.js) ou do Lead do agendamento;
//   - o Lead é ligado ao paciente pelo telefone (ensureLeadForAppointment procura
//     Leads por contact.phone e só preenche convertedToPatient se estiver vazio).
//   Ou seja: nenhum campo lido aqui diz QUAL irmão clicou no anúncio.
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

// Mesmo contato publicitário: mesmo canal E (mesmo click id, ou mesmo anúncio, ou mesma campanha).
// O fbc da AdConversion carrega o fbclid (fb.1.<ts>.<fbclid>), então compara pelo final.
function sameTouch(acq = {}, a = {}) {
  if (!acq.source || acq.source !== a.source) return false;
  const eq = (x, y) => Boolean(x) && Boolean(y) && String(x) === String(y);
  const fbclidOf = (fbc) => (fbc ? String(fbc).split('.').pop() : null);
  if (eq(acq.gclid, a.gclid) || eq(acq.ttclid, a.ttclid) || eq(acq.ctwaClid, a.ctwaClid)) return true;
  if (eq(fbclidOf(acq.fbc), a.fbclid)) return true;
  if (eq(acq.adId, a.adId)) return true;
  if (eq(acq.campaign, a.campaign)) return true;
  return false;
}

function hasClickId(o = {}) {
  return Boolean(o.gclid || o.fbc || o.fbclid || o.ttclid || o.ctwaClid);
}

const toMs = (d) => {
  if (d == null) return null;
  const t = new Date(d).getTime();
  return Number.isNaN(t) ? null : t;
};
const minMs = (...vals) => {
  const ok = vals.filter((v) => v != null);
  return ok.length ? Math.min(...ok) : null;
};

/**
 * Núcleo PURO. Não toca em banco.
 *
 * @param {object} input
 * @param {Array} input.ledgerEntries      lançamentos do período (lean): _id type direction amount patient payment reversalOfEntryId occurredAt
 * @param {Array} [input.referenceEntries] lançamentos FORA do período só para achar o recebimento original de uma
 *                                         reversão/estorno (paciente e data; não entram na soma)
 * @param {Array} [input.adConversions]    AdConversion (lean) de aquisição dos pacientes (com eventTime)
 * @param {Array} [input.leadAttributions] LeadAttribution (lean) dos telefones envolvidos (com firstMessageAt)
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
  // LeadAttribution por telefone (variantes juntas), da mais antiga para a mais nova (first-touch)
  const attrsByPhone = new Map();
  for (const a of leadAttributions) {
    const k = keyOfPhone(a.phone);
    if (!k) continue;
    if (!attrsByPhone.has(k)) attrsByPhone.set(k, []);
    attrsByPhone.get(k).push(a);
  }
  for (const list of attrsByPhone.values()) {
    list.sort((x, y) => (toMs(x.firstMessageAt) ?? Infinity) - (toMs(y.firstMessageAt) ?? Infinity));
  }

  // ── 2. Origem + nível de um paciente NA DATA de um recebimento ───────────────
  // Candidatas em ordem de prioridade; vale a primeira cujo contato tem data <= recebimento.
  const candidatesCache = new Map();
  function candidatesOf(pid) {
    if (candidatesCache.has(pid)) return candidatesCache.get(pid);
    const acq = acquisitionByPatient.get(pid) || null;
    const phone = phoneByPatient.get(pid) || keyOfPhone(acq?.phone);
    const shared = phone ? (ownersByPhone.get(phone)?.size || 0) > 1 : false;
    const attrs = (phone && attrsByPhone.get(phone)) || [];
    const list = [];
    if (acq && acq.source && acq.source !== 'unknown') {
      // Só antecipa a data com contato que comprovadamente é da MESMA campanha/anúncio/clique.
      // Coincidência só de canal (source) não basta: a LeadAttribution A continua como
      // candidata própria logo abaixo, e o pagamento entre os contatos fica com ela.
      const sameSourceAttr = attrs.filter((a) => sameTouch(acq, a)).map((a) => toMs(a.firstMessageAt));
      list.push({
        via: 'adConversion', source: acq.source, campaign: acq.campaign || null, adId: acq.adId || null,
        method: acq.attributionMethod || null, strong: hasClickId(acq) || STRONG_METHODS.includes(acq.attributionMethod),
        contactAt: minMs(toMs(acq.eventTime), ...sameSourceAttr),
      });
    }
    for (const a of attrs) {
      if (!a.source) continue;
      list.push({
        via: 'leadAttribution', source: a.source, campaign: a.campaign || null, adId: a.adId || null,
        method: a.method || null, strong: hasClickId(a) || STRONG_METHODS.includes(a.method),
        contactAt: toMs(a.firstMessageAt),
      });
    }
    const out = { acq, phone, shared, list };
    candidatesCache.set(pid, out);
    return out;
  }

  function resolveOrigin(pid, atMs) {
    if (!pid) return { nivel: 'sem_vinculo', motivo: 'lancamento_sem_paciente' };
    const { acq, phone, shared, list } = candidatesOf(pid);
    const origin = atMs == null ? null : list.find((c) => c.contactAt != null && c.contactAt <= atMs) || null;
    if (!origin) {
      let motivo;
      if (list.length && atMs == null) motivo = 'recebimento_sem_data';
      else if (list.some((c) => c.contactAt != null)) motivo = 'contato_da_campanha_depois_do_recebimento';
      else if (list.length) motivo = 'origem_sem_data_de_contato';
      else motivo = acq?.unknownReason || (!phone ? 'sem_telefone' : (acq ? 'sem_origem_capturada' : 'sem_aquisicao_e_sem_origem_no_telefone'));
      return { nivel: 'sem_vinculo', motivo, telefoneCompartilhado: shared };
    }
    const nivel = origin.strong && !shared ? 'comprovada' : 'provavel';
    const motivo = nivel === 'comprovada' ? 'sinal_forte_telefone_exclusivo'
      : origin.strong ? 'sinal_forte_em_telefone_compartilhado' : 'so_sinal_fraco';
    return { ...origin, nivel, motivo, telefoneCompartilhado: shared };
  }

  // ── 3. Recebimento original de cada estorno/reversão ─────────────────────────
  const byId = new Map();
  const creditByPayment = new Map(); // payment -> crédito de caixa mais antigo daquele pagamento
  for (const e of [...referenceEntries, ...ledgerEntries]) {
    byId.set(id(e._id), e);
    if (e.payment && CASH_CREDIT_TYPES.includes(e.type)) {
      const k = id(e.payment);
      const cur = creditByPayment.get(k);
      if (!cur || (toMs(e.occurredAt) ?? Infinity) < (toMs(cur.occurredAt) ?? Infinity)) creditByPayment.set(k, e);
    }
  }
  const originalOf = (e) => (e.reversalOfEntryId ? byId.get(id(e.reversalOfEntryId)) : null)
    || (e.payment ? creditByPayment.get(id(e.payment)) : null)
    || null;

  // Crédito: origem na data dele. Débito: a MESMA origem/nível do recebimento que ele desfaz.
  function attributionOf(e, signedCents) {
    if (signedCents >= 0) {
      const pid = id(e.patient);
      return { pid, o: resolveOrigin(pid, toMs(e.occurredAt)) };
    }
    const orig = originalOf(e);
    const pid = id(e.patient) || id(orig?.patient) || null;
    if (!orig) return { pid, o: { nivel: 'sem_vinculo', motivo: 'estorno_sem_recebimento_original' } };
    return { pid, o: resolveOrigin(id(orig.patient) || pid, toMs(orig.occurredAt)) };
  }

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
    const { pid, o } = attributionOf(e, c.signedCents);
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
  'Origem por recebimento: AdConversion de aquisição; senão LeadAttribution pelo telefone; senão "sem vínculo". Só vale origem com contato (eventTime/firstMessageAt) até a data do recebimento.',
  'Estorno/reversão desfaz o recebimento original: mesma campanha e nível daquele recebimento, não a origem atual do paciente.',
  'Comprovada = click id ou ctwa/assinatura do site/token em telefone de um só paciente. Provável = sinal forte em telefone compartilhado (não há prova individual de qual irmão veio), ou só palavra-chave/manual.',
  'Invariante: comprovada + provável + sem vínculo = total líquido do ledger.',
]);

// ─────────────────────────────────────────────────────────────────────────────
// Loader: SOMENTE LEITURA (find().select().lean(); nenhuma escrita).
// Os models são injetáveis para teste; por padrão importa os reais sob demanda.
// ─────────────────────────────────────────────────────────────────────────────

// Variantes normalizadas (só dígitos, com 55): com e sem o 9.
export function phoneVariantsOf(raw) {
  const n = normalizeE164BR(raw);
  if (!n) return [];
  const out = [n];
  const m = n.match(/^55(\d{2})(9?)(\d{8})$/);
  if (m) out.push(m[2] ? `55${m[1]}${m[3]}` : `55${m[1]}9${m[3]}`);
  return out;
}

// Grafias em que o telefone costuma estar gravado em Patient.phone (campo livre, com máscara ou não):
// 62999990000, 5562999990000, +5562999990000, (62) 99999-0000, 62 99999-0000, +55 62 99999-0000,
// +55 (62) 99999-0000 … cada uma com e sem o 9. Patient.phone tem índice ({ phone: 1 }), então a
// busca é `$in` exato nessas grafias (pontos no índice), nunca regex nem varredura da coleção.
// Grafia fora desta lista (ex.: "62.99999.0000", "0xx62…") não é achada: ver Limitações no doc.
const COUNTRY_PREFIXES = ['', '55', '55 ', '+55', '+55 '];
const AREA_FORMATS = [(d) => d, (d) => `${d} `, (d) => `(${d})`, (d) => `(${d}) `];
export function phoneFormatsOf(raw) {
  const out = new Set();
  for (const v of phoneVariantsOf(raw)) {
    const m = v.match(/^55(\d{2})(\d{8,9})$/);
    if (!m) { out.add(v); out.add(`+${v}`); continue; }
    const [, ddd, local] = m;
    const locals = [local, `${local.slice(0, -4)}-${local.slice(-4)}`];
    for (const cc of COUNTRY_PREFIXES) {
      for (const area of AREA_FORMATS) {
        for (const l of locals) out.add(`${cc}${area(ddd)}${l}`);
      }
    }
  }
  return [...out];
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
const REFERENCE_FIELDS = '_id type patient payment occurredAt';
const ADCONV_FIELDS = '_id patient phone isAcquisition source attributionMethod campaign adId gclid fbc ttclid ctwaClid unknownReason eventTime';
const ATTR_FIELDS = '_id phone source method campaign adId gclid fbclid ttclid ctwaClid firstMessageAt';

/**
 * Carrega do Mongo (read-only) e calcula. `since`/`until` filtram FinancialLedger.occurredAt.
 *
 * Todas as consultas usam índice (nenhuma varre a coleção):
 *   FinancialLedger: occurredAt (período), _id (recebimento original), { payment, type } (crédito do estorno)
 *   Patient:         _id e { phone } com `$in` nas grafias de phoneFormatsOf
 *   AdConversion:    índice parcial uniq_acquisition_per_patient — a consulta repete o filtro dele
 *                    (patient $type objectId + isAcquisition: true) para o planner poder usá-lo
 *   LeadAttribution: phone (único), nas variantes normalizadas
 * AdConversion.phone NÃO tem índice: por isso o loader não procura irmãos pelo telefone da
 * AdConversion (só pelo Patient.phone). Ver Limitações em docs/RECEITA_POR_CAMPANHA.md.
 */
export async function loadRevenueAttribution({ since, until, models } = {}) {
  const M = models || await defaultModels();
  const range = {};
  if (since) range.$gte = since;
  if (until) range.$lte = until;
  const ledgerFilter = Object.keys(range).length ? { occurredAt: range } : {};

  const ledgerEntries = await M.FinancialLedger.find(ledgerFilter).select(LEDGER_FIELDS).lean();

  // Recebimento original de estornos/reversões cujo crédito está fora do período
  // (o estorno usa a campanha/nível do recebimento original, na data dele).
  const inPeriod = new Set(ledgerEntries.map((e) => id(e._id)));
  const creditPaymentsInPeriod = new Set(ledgerEntries
    .filter((e) => e.payment && CASH_CREDIT_TYPES.includes(e.type)).map((e) => id(e.payment)));
  const cashDebits = ledgerEntries.filter((e) => CASH_DEBIT_TYPES.includes(e.type) && (e.payment || e.reversalOfEntryId));
  const missingTargets = [...new Set(cashDebits
    .filter((e) => e.reversalOfEntryId && !inPeriod.has(id(e.reversalOfEntryId)))
    .map((e) => id(e.reversalOfEntryId)))];
  const missingPayments = [...new Set(cashDebits
    .filter((e) => e.payment && !creditPaymentsInPeriod.has(id(e.payment)))
    .map((e) => id(e.payment)))];
  const refOr = [];
  if (missingTargets.length) refOr.push({ _id: { $in: missingTargets } });
  if (missingPayments.length) refOr.push({ payment: { $in: missingPayments }, type: { $in: [...CASH_CREDIT_TYPES] } });
  const referenceEntries = refOr.length
    ? await M.FinancialLedger.find({ $or: refOr }).select(REFERENCE_FIELDS).lean()
    : [];

  const patientIds = [...new Set([...ledgerEntries, ...referenceEntries].map((e) => id(e.patient)).filter(Boolean))];
  if (!patientIds.length) {
    return attributeReceivedRevenue({ ledgerEntries, referenceEntries });
  }

  const [ledgerPatients, adConversions] = await Promise.all([
    M.Patient.find({ _id: { $in: patientIds } }).select('_id phone').lean(),
    M.AdConversion.find({ patient: { $in: patientIds, $type: 'objectId' }, isAcquisition: true }).select(ADCONV_FIELDS).lean(),
  ]);

  const rawPhones = [...ledgerPatients.map((p) => p.phone), ...adConversions.map((c) => c.phone)].filter(Boolean);
  const variants = [...new Set(rawPhones.flatMap(phoneVariantsOf))];
  const formats = [...new Set(rawPhones.flatMap(phoneFormatsOf))];

  const [sharingPatients, leadAttributions] = variants.length
    ? await Promise.all([
        M.Patient.find({ phone: { $in: formats } }).select('_id phone').lean(),
        M.LeadAttribution.find({ phone: { $in: variants } }).select(ATTR_FIELDS).lean(),
      ])
    : [[], []];

  const seenPatients = new Set();
  const patients = [...ledgerPatients, ...sharingPatients].filter((p) => {
    const k = id(p._id); if (seenPatients.has(k)) return false; seenPatients.add(k); return true;
  });

  return attributeReceivedRevenue({ ledgerEntries, referenceEntries, adConversions, leadAttributions, patients });
}
