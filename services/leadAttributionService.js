// services/leadAttributionService.js
// Captura (first-touch) e consulta da origem de marketing por telefone.
import LeadAttribution from '../models/LeadAttribution.js';
import Lead from '../models/Leads.js';
import { normalizeE164BR } from '../utils/phone.js';
import { parseAttribution, toLeadTrackingSource } from '../utils/attributionParser.js';

const TAG = '[LeadAttribution]';

/**
 * Chamado a cada mensagem RECEBIDA no WhatsApp. Barato quando não há sinal de origem.
 * Nunca lança erro (não pode afetar o pipeline do WhatsApp).
 */
export async function captureInboundAttribution({ phone, text, ctwa = null, capturedBy = 'whatsapp_web' }) {
  try {
    const parsed = parseAttribution(text, ctwa);
    if (!parsed) return null;

    const normalized = normalizeE164BR(phone);
    if (!normalized) return null;
    // ID @lid vira 14-15 dígitos: gravar assim nunca casa com paciente/agendamento
    if (!/^55\d{10,11}$/.test(normalized)) {
      console.warn(`${TAG} ⚠️ telefone inválido (provável @lid), origem ignorada:`, { source: parsed.source, tail: normalized.slice(-4) });
      return null;
    }

    // First-touch: só grava se o telefone ainda não tem origem
    const res = await LeadAttribution.updateOne(
      { phone: normalized },
      { $setOnInsert: { phone: normalized, capturedBy, firstMessageAt: new Date(), ...parsed } },
      { upsert: true }
    );
    const created = res.upsertedCount > 0;

    // Sinal forte substitui sinal fraco (keyword) — nunca o contrário
    if (!created && parsed.confidence === 'high') {
      await LeadAttribution.updateOne(
        { phone: normalized, confidence: 'low' },
        { $set: { ...parsed, capturedBy } }
      );
    }

    // Completa o Lead existente SEM sobrescrever origem já definida
    if (created) {
      const set = { 'metaTracking.source': toLeadTrackingSource(parsed.source) };
      if (parsed.campaign) set['metaTracking.campaign'] = parsed.campaign;
      if (parsed.gclid) set['metaTracking.gclid'] = parsed.gclid;
      if (parsed.fbclid) set['metaTracking.fbclid'] = parsed.fbclid;
      if (parsed.ttclid) set['metaTracking.ttclid'] = parsed.ttclid;
      if (parsed.adId) set['metaTracking.adId'] = parsed.adId;
      await Lead.updateOne(
        { 'contact.phone': normalized, 'metaTracking.source': { $in: [null, '', undefined] } },
        { $set: set }
      );
      console.log(`${TAG} ✅ origem capturada`, { source: parsed.source, method: parsed.method, phoneTail: normalized.slice(-4) });
    }
    return { ...parsed, created };
  } catch (err) {
    if (err?.code === 11000) return null; // corrida entre 2 mensagens do mesmo número — ok
    console.error(`${TAG} ❌ erro ao capturar origem:`, err.message);
    return null;
  }
}

/**
 * Resolve a origem de um telefone: LeadAttribution → Lead.metaTracking → null
 */
export async function getAttributionByPhone(phone) {
  const normalized = normalizeE164BR(phone);
  if (!normalized) return null;

  // WhatsApp costuma entregar o número no formato antigo (sem o 9 após o DDD) e o cadastro tem o 9
  // (ou o contrário): busca as duas variantes, senão a origem nunca casa com o paciente.
  const variants = [normalized];
  const m = normalized.match(/^55(\d{2})(9?)(\d{8})$/);
  if (m) variants.push(m[2] ? `55${m[1]}${m[3]}` : `55${m[1]}9${m[3]}`);

  const attr = await LeadAttribution.findOne({ phone: { $in: variants } }).sort({ firstMessageAt: 1 }).lean();
  if (attr) return { ...attr, from: 'attribution' };

  const lead = await Lead.findOne({ 'contact.phone': normalized })
    .select('_id metaTracking origin')
    .lean();
  if (lead?.metaTracking?.source) {
    return {
      source: lead.metaTracking.source,
      method: 'lead',
      gclid: lead.metaTracking.gclid || null,
      fbclid: lead.metaTracking.fbclid || null,
      ttclid: lead.metaTracking.ttclid || null,
      leadId: lead._id,
      from: 'lead',
    };
  }
  return lead ? { source: null, leadId: lead._id, from: 'lead' } : null;
}

// Variantes com e sem o 9 após o DDD (mesma regra de getAttributionByPhone).
function phoneVariants(normalized) {
  const variants = [normalized];
  const m = normalized.match(/^55(\d{2})(9?)(\d{8})$/);
  if (m) variants.push(m[2] ? `55${m[1]}${m[3]}` : `55${m[1]}9${m[3]}`);
  return variants;
}

/**
 * Versão em LOTE de getAttributionByPhone: 2 consultas no total em vez de 2 por telefone.
 * Mesmo resultado por telefone (LeadAttribution mais antiga entre as variantes → Lead.metaTracking).
 * Devolve Map(telefone de entrada → atribuição | null).
 * 11/11: o cron de conversões chamava getAttributionByPhone 1 a 1 para até 300 docs a cada 10 min.
 */
export async function getAttributionsByPhones(phones = []) {
  const out = new Map();
  const byInput = new Map(); // entrada → { normalized, variants }
  for (const p of new Set((phones || []).filter(Boolean))) {
    const normalized = normalizeE164BR(p);
    if (!normalized) { out.set(p, null); continue; }
    byInput.set(p, { normalized, variants: phoneVariants(normalized) });
  }
  if (!byInput.size) return out;

  const allVariants = [...new Set([...byInput.values()].flatMap((v) => v.variants))];
  const allNormalized = [...new Set([...byInput.values()].map((v) => v.normalized))];

  const [attrs, leads] = await Promise.all([
    LeadAttribution.find({ phone: { $in: allVariants } }).sort({ firstMessageAt: 1 }).lean(),
    Lead.find({ 'contact.phone': { $in: allNormalized } }).select('_id contact.phone metaTracking origin').lean(),
  ]);

  const attrByPhone = new Map();
  for (const a of attrs) if (!attrByPhone.has(a.phone)) attrByPhone.set(a.phone, a); // 1º = mais antigo
  const leadByPhone = new Map();
  for (const l of leads) {
    const ph = l.contact?.phone;
    // Prefere o lead que já tem origem (findOne pegaria um qualquer)
    if (!leadByPhone.has(ph) || (!leadByPhone.get(ph).metaTracking?.source && l.metaTracking?.source)) leadByPhone.set(ph, l);
  }

  for (const [input, { normalized, variants }] of byInput) {
    const found = variants.map((v) => attrByPhone.get(v)).filter(Boolean)
      .sort((a, b) => new Date(a.firstMessageAt || 0) - new Date(b.firstMessageAt || 0))[0];
    if (found) { out.set(input, { ...found, from: 'attribution' }); continue; }
    const lead = leadByPhone.get(normalized);
    if (lead?.metaTracking?.source) {
      out.set(input, {
        source: lead.metaTracking.source,
        method: 'lead',
        gclid: lead.metaTracking.gclid || null,
        fbclid: lead.metaTracking.fbclid || null,
        ttclid: lead.metaTracking.ttclid || null,
        leadId: lead._id,
        from: 'lead',
      });
    } else {
      out.set(input, lead ? { source: null, leadId: lead._id, from: 'lead' } : null);
    }
  }
  return out;
}

export default { captureInboundAttribution, getAttributionByPhone, getAttributionsByPhones };
