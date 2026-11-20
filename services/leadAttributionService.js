// services/leadAttributionService.js
// Captura (first-touch) e consulta da origem de marketing por telefone.
import LeadAttribution from '../models/LeadAttribution.js';
import Lead from '../models/Leads.js';
import { normalizeE164BR } from '../utils/phone.js';
import { parseAttribution, toLeadTrackingSource } from '../utils/attributionParser.js';

const TAG = '[LeadAttribution]';
export const MAX_TOUCHES = 20;

/** Um toque do histórico: só o que identifica a origem (sem click id, sem texto). */
export function touchOf(parsed = {}, at = new Date()) {
  return {
    at,
    source: parsed.source || null,
    method: parsed.method || null,
    confidence: parsed.confidence || null,
    campaign: parsed.campaign || null,
    temClique: Boolean(parsed.gclid || parsed.fbclid || parsed.ttclid || parsed.ctwaClid),
  };
}

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

    // Correção 7 (20/11): registra o toque no histórico (últimos 20), sem trocar a origem.
    const touch = touchOf(parsed);
    await LeadAttribution.updateOne(
      { phone: normalized },
      { $push: { touches: { $each: [touch], $slice: -MAX_TOUCHES } }, $set: { lastTouchAt: touch.at } }
    );

    // Sinal forte substitui sinal fraco (keyword) — nunca o contrário
    if (!created && parsed.confidence === 'high') {
      await LeadAttribution.updateOne(
        { phone: normalized, confidence: 'low' },
        { $set: { ...parsed, capturedBy } }
      );
    }

    // 18/11: o gclid de uma mensagem posterior era descartado quando o telefone já tinha origem
    // "forte" sem gclid (first-touch). Completa SÓ o gclid (e a campanha vazia), sem trocar a origem.
    if (!created && parsed.gclid) {
      const fill = { gclid: parsed.gclid };
      await LeadAttribution.updateOne({ phone: normalized, gclid: { $in: [null, ''] } }, { $set: fill });
      if (parsed.campaign) {
        await LeadAttribution.updateOne({ phone: normalized, campaign: { $in: [null, ''] } }, { $set: { campaign: parsed.campaign } });
      }
    }

    // 18/11: anúncio (ctwa) chegou depois de um registro que já tinha anúncio mas não tinha o clid/link:
    // completa SÓ os campos vazios do anúncio, sem trocar a origem (first-touch).
    if (!created && parsed.method === 'ctwa') {
      const fill = {};
      for (const k of ['ctwaClid', 'adId', 'adSourceUrl', 'adTitle']) if (parsed[k]) fill[k] = parsed[k];
      for (const [k, v] of Object.entries(fill)) {
        await LeadAttribution.updateOne({ phone: normalized, [k]: { $in: [null, ''] } }, { $set: { [k]: v } });
      }
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

    // 18/11: leadattribution com gclid → grava gclid, origem e campanha no Lead do mesmo telefone
    // (todas as variantes de formato). Antes só acontecia na criação e só se o lead não tivesse
    // origem, então nenhum lead de produção tinha gclid e o google-offline.csv saía vazio.
    if (parsed.gclid) await syncLeadGclid({ phone: normalized, gclid: parsed.gclid, campaign: parsed.campaign });
    // 18/11: anúncio da Meta (com ou sem clid) → origem meta_ads, adId, link e clid no Lead do telefone.
    if (parsed.method === 'ctwa') await syncLeadCtwa({ phone: normalized, ...parsed });
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
      ctwaClid: lead.metaTracking.ctwaClid || null,
      adId: lead.metaTracking.adId || null,
      leadId: lead._id,
      from: 'lead',
    };
  }
  return lead ? { source: null, leadId: lead._id, from: 'lead' } : null;
}

// Variantes com e sem o 9 após o DDD (mesma regra de getAttributionByPhone).
export function phoneVariants(normalized) {
  const variants = [normalized];
  const m = normalized.match(/^55(\d{2})(9?)(\d{8})$/);
  if (m) variants.push(m[2] ? `55${m[1]}${m[3]}` : `55${m[1]}9${m[3]}`);
  return variants;
}

// Formatos em que o telefone aparece em Lead.contact.phone: 55DD9…, +55DD9…, DD9… (com e sem o 9).
export function leadPhoneFormats(phone) {
  const normalized = normalizeE164BR(phone);
  if (!normalized) return [];
  return [...new Set(phoneVariants(normalized).flatMap((v) => [v, `+${v}`, v.slice(2)]))];
}

// Origens que um gclid (clique comprovado no Google Ads) pode substituir no Lead.
const WEAK_LEAD_SOURCES = [null, '', 'website', 'organic'];

/**
 * Grava gclid (+ origem google_ads e campanha) nos leads do telefone ou no lead informado.
 * Nunca apaga gclid existente nem troca origem paga de outra plataforma (meta/tiktok).
 * Idempotente. Devolve quantos leads mudaram. Nunca lança.
 */
export async function syncLeadGclid({ phone = null, leadId = null, gclid, campaign = null }) {
  try {
    if (!gclid) return 0;
    const or = [];
    if (leadId) or.push({ _id: leadId });
    const formats = phone ? leadPhoneFormats(phone) : [];
    if (formats.length) or.push({ 'contact.phone': { $in: formats } });
    if (!or.length) return 0;

    const leads = await Lead.find({ $or: or }).select('_id metaTracking').lean();
    let changed = 0;
    for (const l of leads) {
      const mt = l.metaTracking || {};
      const set = {};
      if (!mt.gclid) set['metaTracking.gclid'] = gclid;
      if (WEAK_LEAD_SOURCES.includes(mt.source ?? null)) set['metaTracking.source'] = 'google_ads';
      if (campaign && !mt.campaign) set['metaTracking.campaign'] = campaign;
      if (!Object.keys(set).length) continue;
      const r = await Lead.updateOne({ _id: l._id }, { $set: set });
      changed += r.modifiedCount || 0;
    }
    if (changed) console.log(`${TAG} ✅ gclid gravado no lead`, { leads: changed });
    return changed;
  } catch (err) {
    console.error(`${TAG} ❌ erro ao gravar gclid no lead:`, err.message);
    return 0;
  }
}

// Origens que um anúncio comprovado da Meta (ctwa) pode substituir no Lead: vazia, site, orgânico
// e palavra-chave de rede social ("vim pelo Instagram" sem anúncio).
const WEAK_FOR_META_AD = [null, '', 'website', 'organic', 'instagram', 'facebook'];

/**
 * Grava o anúncio click-to-WhatsApp no Lead do telefone (todas as variantes de formato):
 * origem meta_ads (só sobre origem fraca), adId, link do anúncio e ctwa_clid (só campo vazio).
 * Nunca troca origem paga de outra plataforma (google/tiktok). Idempotente. Nunca lança.
 */
export async function syncLeadCtwa({ phone = null, leadId = null, adId = null, ctwaClid = null, adSourceUrl = null }) {
  try {
    if (!adId && !ctwaClid && !adSourceUrl) return 0;
    const or = [];
    if (leadId) or.push({ _id: leadId });
    const formats = phone ? leadPhoneFormats(phone) : [];
    if (formats.length) or.push({ 'contact.phone': { $in: formats } });
    if (!or.length) return 0;

    const leads = await Lead.find({ $or: or }).select('_id metaTracking').lean();
    let changed = 0;
    for (const l of leads) {
      const mt = l.metaTracking || {};
      const set = {};
      if (WEAK_FOR_META_AD.includes(mt.source ?? null)) set['metaTracking.source'] = 'meta_ads';
      const sameAd = !mt.adId || !adId || String(mt.adId) === String(adId);
      if (adId && !mt.adId) set['metaTracking.adId'] = adId;
      if (sameAd && ctwaClid && !mt.ctwaClid) set['metaTracking.ctwaClid'] = ctwaClid;
      if (sameAd && adSourceUrl && !mt.adSourceUrl) set['metaTracking.adSourceUrl'] = String(adSourceUrl).slice(0, 300);
      if (!Object.keys(set).length) continue;
      const r = await Lead.updateOne({ _id: l._id }, { $set: set });
      changed += r.modifiedCount || 0;
    }
    if (changed) console.log(`${TAG} ✅ anúncio Meta gravado no lead`, { leads: changed, clid: !!ctwaClid });
    return changed;
  } catch (err) {
    console.error(`${TAG} ❌ erro ao gravar anúncio no lead:`, err.message);
    return 0;
  }
}

/**
 * gclid para a conversão de um agendamento quando a atribuição por telefone não trouxe:
 * 1º Lead do agendamento (ou do telefone) com metaTracking.gclid;
 * 2º LeadAttribution MAIS RECENTE com gclid do mesmo telefone (ou do telefone do lead).
 * Devolve { gclid, campaign, method } ou null.
 */
export async function findGclidForConversion({ leadId = null, phone = null }) {
  const or = [];
  if (leadId) or.push({ _id: leadId });
  const formats = phone ? leadPhoneFormats(phone) : [];
  if (formats.length) or.push({ 'contact.phone': { $in: formats } });

  let leadPhones = [];
  if (or.length) {
    const leads = await Lead.find({ $or: or }).select('_id contact.phone metaTracking').lean();
    const withGclid = leads.find((l) => l.metaTracking?.gclid);
    if (withGclid) return { gclid: withGclid.metaTracking.gclid, campaign: withGclid.metaTracking.campaign || null, method: 'lead' };
    leadPhones = leads.map((l) => l.contact?.phone).filter(Boolean);
  }

  const variants = [...new Set([phone, ...leadPhones].filter(Boolean)
    .map((p) => normalizeE164BR(p)).filter(Boolean).flatMap(phoneVariants))];
  if (!variants.length) return null;
  const attr = await LeadAttribution.findOne({ phone: { $in: variants }, gclid: { $nin: [null, ''] } })
    .sort({ updatedAt: -1, firstMessageAt: -1 }).select('gclid campaign method').lean();
  return attr ? { gclid: attr.gclid, campaign: attr.campaign || null, method: attr.method || 'attribution' } : null;
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
        ctwaClid: lead.metaTracking.ctwaClid || null,
        adId: lead.metaTracking.adId || null,
        leadId: lead._id,
        from: 'lead',
      });
    } else {
      out.set(input, lead ? { source: null, leadId: lead._id, from: 'lead' } : null);
    }
  }
  return out;
}

export default { captureInboundAttribution, getAttributionByPhone, getAttributionsByPhones, syncLeadGclid, syncLeadCtwa, findGclidForConversion };
