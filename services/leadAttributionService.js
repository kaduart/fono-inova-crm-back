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

  const attr = await LeadAttribution.findOne({ phone: normalized }).lean();
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
      leadId: lead._id,
      from: 'lead',
    };
  }
  return lead ? { source: null, leadId: lead._id, from: 'lead' } : null;
}

export default { captureInboundAttribution, getAttributionByPhone };
