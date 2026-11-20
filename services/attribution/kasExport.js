// services/attribution/kasExport.js
// Exporta os dados da receita por campanha do CRM para as 4 entradas GENÉRICAS do
// KAS Attribution (kas-core, contract/v1/attribution.md): customers, contacts, receipts, refunds.
// Somente leitura: parte exatamente das mesmas entradas que attributeReceivedRevenue usa
// (loadRevenueInputs), então o relatório do KAS, filtrado pelo MESMO período, fecha com o do CRM.
//
// Mapeamento:
//   Patient              -> customers  (external_id = _id, phone = telefone do cadastro; o KAS
//                                         guarda só a impressão digital, nunca o número)
//   AdConversion aquis.  -> contacts   (acquisition=true, contacted_at = eventTime, click ids, método)
//   LeadAttribution      -> contacts   (ligada a um paciente com aquele telefone; se nenhum
//                                         paciente tem o telefone, vira um cliente só de telefone)
//   FinancialLedger crédito de caixa   -> receipts (amount em centavos, payment_ref)
//   FinancialLedger débito de caixa com pagamento ou reversalOfEntryId -> refunds
//   Fica fora o que o CRM também deixa fora (revenue_recognition, package_consumed,
//   insurance_billed, reversão sem pagamento etc.). Os créditos de referência (recebimento
//   original de um estorno, fora do período) também são exportados: o KAS guarda o histórico e o
//   relatório é sempre pedido com from/to.
//
// Nada aqui conhece o KAS por rede: só monta linhas e CSV.

import { CASH_CREDIT_TYPES, CASH_DEBIT_TYPES } from './revenueAttribution.js';
import { phoneKey } from '../../routes/analytics/funnel.logic.js';
import { normalizeE164BR } from '../../utils/phone.js';

// Origens aceitas pelo KAS; o resto vira "other" (e "unknown" não vira contato).
export const KAS_SOURCES = Object.freeze(['google_ads', 'meta_ads', 'tiktok_ads', 'instagram', 'organic', 'referral', 'other']);
const SOURCE_ALIASES = Object.freeze({ instagram_ads: 'meta_ads', facebook_ads: 'meta_ads', facebook: 'meta_ads', google: 'google_ads', tiktok: 'tiktok_ads', indicacao: 'referral' });

// Colunas exatas do contrato (ordem livre no KAS; fixamos esta).
export const KAS_COLUMNS = Object.freeze({
  customers: ['external_id', 'phone'],
  contacts: ['external_id', 'customer_ref', 'source', 'contacted_at', 'campaign', 'ad_id', 'gclid', 'fbclid', 'ttclid', 'ctwa_clid', 'method', 'acquisition'],
  receipts: ['external_id', 'customer_ref', 'amount_cents', 'received_at', 'payment_ref'],
  refunds: ['external_id', 'amount_cents', 'refunded_at', 'receipt_ref', 'payment_ref', 'customer_ref'],
});

const REF = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const TEXT = /^[A-Za-z0-9][A-Za-z0-9 ._:/-]{0,127}$/;
const METHOD = /^[a-z][a-z0-9_]{0,31}$/;

const str = (v) => (v == null ? '' : String(v));
const ref = (v) => (REF.test(str(v)) ? str(v) : '');
const text = (v) => (TEXT.test(str(v).trim()) ? str(v).trim() : '');
const iso = (v) => {
  if (!v) return '';
  const d = v instanceof Date ? v : new Date(v);
  return Number.isNaN(d.getTime()) ? '' : d.toISOString();
};
const cents = (amount) => Math.round(Number(amount || 0) * 100);
// Mesma chave de telefone da receita do CRM (keyOfPhone em revenueAttribution.js).
const keyOf = (raw) => phoneKey(normalizeE164BR(raw) || null);
// Telefone vai só com dígitos (o KAS normaliza para 55 + DDD + 8 dígitos e guarda a impressão digital).
const digits = (raw) => str(normalizeE164BR(raw) || raw).replace(/\D/g, '');

export function kasSource(source) {
  const s = str(source).trim().toLowerCase();
  if (!s || s === 'unknown') return null;
  if (KAS_SOURCES.includes(s)) return s;
  return SOURCE_ALIASES[s] || 'other';
}

/**
 * Converte as entradas cruas (formato de loadRevenueInputs) nas 4 listas do KAS.
 * Devolve também `ignorados` (contagem por motivo) para o relatório do script.
 */
export function toKasInputs({ ledgerEntries = [], referenceEntries = [], adConversions = [], leadAttributions = [], patients = [] } = {}) {
  const ignorados = {};
  const skip = (motivo) => { ignorados[motivo] = (ignorados[motivo] || 0) + 1; };

  // customers
  const customers = new Map();
  const patientByPhoneKey = new Map();
  for (const p of patients) {
    const pid = ref(p._id);
    if (!pid) { skip('paciente_id_invalido'); continue; }
    customers.set(pid, { external_id: pid, phone: digits(p.phone) });
    const k = keyOf(p.phone);
    if (k && !patientByPhoneKey.has(k)) patientByPhoneKey.set(k, pid);
  }
  // Paciente de um lançamento sem cadastro carregado: entra sem telefone (o KAS aceita).
  const ensureCustomer = (pid) => { if (pid && !customers.has(pid)) customers.set(pid, { external_id: pid, phone: '' }); };

  // contacts
  const contacts = [];
  for (const c of adConversions) {
    if (!c.isAcquisition) continue;
    const pid = ref(c.patient);
    const source = kasSource(c.source);
    const at = iso(c.eventTime);
    if (!pid || !source || !at) { skip(source ? 'conversao_sem_paciente_ou_data' : 'conversao_sem_origem'); continue; }
    ensureCustomer(pid);
    contacts.push({
      external_id: `adconv-${ref(c._id)}`, customer_ref: pid, source, contacted_at: at,
      campaign: text(c.campaign), ad_id: ref(c.adId), gclid: ref(c.gclid), fbclid: ref(c.fbc), ttclid: ref(c.ttclid),
      ctwa_clid: ref(c.ctwaClid), method: METHOD.test(str(c.attributionMethod)) ? c.attributionMethod : '', acquisition: 'true',
    });
  }
  for (const a of leadAttributions) {
    const source = kasSource(a.source);
    const at = iso(a.firstMessageAt);
    const k = keyOf(a.phone);
    if (!source || !at || !k) { skip('atribuicao_sem_origem_data_ou_telefone'); continue; }
    let pid = patientByPhoneKey.get(k);
    if (!pid) {
      // Ninguém cadastrado com o telefone: cliente só de telefone, para a família bater no KAS.
      pid = `tel-${ref(a._id)}`;
      customers.set(pid, { external_id: pid, phone: digits(a.phone) });
      patientByPhoneKey.set(k, pid);
    }
    contacts.push({
      external_id: `leadattr-${ref(a._id)}`, customer_ref: pid, source, contacted_at: at,
      campaign: text(a.campaign), ad_id: ref(a.adId), gclid: ref(a.gclid), fbclid: ref(a.fbclid), ttclid: ref(a.ttclid),
      ctwa_clid: ref(a.ctwaClid), method: METHOD.test(str(a.method)) ? a.method : '', acquisition: 'false',
    });
  }

  // receipts e refunds
  const receipts = new Map();
  const refunds = [];
  for (const e of [...ledgerEntries, ...referenceEntries]) {
    const eid = ref(e._id);
    const credit = CASH_CREDIT_TYPES.includes(e.type) && (e.direction === 'credit' || e.direction == null);
    const debit = CASH_DEBIT_TYPES.includes(e.type) && e.direction === 'debit' && (e.payment || e.reversalOfEntryId);
    if (!credit && !debit) { if (ledgerEntries.includes(e)) skip(`fora_do_caixa:${e.type}`); continue; }
    const amount = cents(e.amount);
    const at = iso(e.occurredAt);
    if (!eid || amount <= 0 || !at) { skip('lancamento_invalido'); continue; }
    const pid = ref(e.patient);
    if (pid) ensureCustomer(pid);
    if (credit) {
      if (receipts.has(eid)) continue; // o mesmo crédito pode vir no período e como referência
      // Sem paciente: o KAS exige customer_ref; um cliente sem contato cai em "sem vínculo".
      const customer = pid || `sem-cliente-${eid}`;
      ensureCustomer(customer);
      receipts.set(eid, { external_id: eid, customer_ref: customer, amount_cents: String(amount), received_at: at, payment_ref: ref(e.payment) });
    } else {
      refunds.push({ external_id: eid, amount_cents: String(amount), refunded_at: at,
        receipt_ref: ref(e.reversalOfEntryId), payment_ref: e.reversalOfEntryId ? '' : ref(e.payment), customer_ref: pid });
    }
  }

  return { customers: [...customers.values()], contacts, receipts: [...receipts.values()], refunds, ignorados };
}

// CSV RFC 4180 com o cabeçalho do contrato. Nenhuma célula começa fórmula de planilha: ids e
// textos passam pelos padrões do KAS (começam com letra ou dígito) e telefone vai só com dígitos.
export function toCsv(kind, rows) {
  const cols = KAS_COLUMNS[kind];
  if (!cols) throw new Error(`tipo desconhecido: ${kind}`);
  const cell = (v) => {
    const s = str(v);
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [cols.join(','), ...rows.map((r) => cols.map((c) => cell(r[c])).join(','))].join('\n') + '\n';
}
