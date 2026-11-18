/**
 * Backfill ÚNICO de origem (18/11/2026, pedido do Kadu): agendados aparecendo como "Não identificado".
 *
 * Desde --since (padrão 01/11/2026 00:00 Brasília):
 *   A) leadattribution com gclid  → Lead do telefone ganha gclid/origem google_ads/campanha (só campo vazio
 *      ou origem fraca). Igual ao _backfill-gclid-leadattribution.js, agora desde 01/11.
 *   B) leadattribution de anúncio (ctwa) → Lead do telefone ganha origem meta_ads (só sobre origem fraca),
 *      adId, link do anúncio e ctwa_clid (só campo vazio).
 *   C) Agendamento SEM lead → liga ao Lead do mesmo telefone (só se houver exatamente 1 lead; só grava
 *      o campo `lead` quando ele está vazio — nenhum campo financeiro é tocado).
 *   D) AdConversion "unknown" → telefone (se faltava), origem pela leadattribution/Lead; gclid, ctwa_clid,
 *      ttclid e fbc SÓ na aquisição (o google-offline.csv lista toda AdConversion com gclid). Reabre o Google
 *      pulado por sem_gclid (até 90 dias) e a Meta pulada por sem_telefone quando ganha clid (até 7 dias).
 *      Nunca reabre o que já foi aceito (sent).
 *   No fim lista CADA AdConversion que continua "Não identificado" com o motivo.
 *
 * Uso (PowerShell, um comando por vez, na pasta back):
 *   node scripts/_backfill-origem-adconversions.js                                → SIMULAÇÃO (só lê)
 *   node scripts/_backfill-origem-adconversions.js --uri-env=NOME_DA_ENV --apply --prod-ok
 *
 * Regras: sem --apply não escreve nada. URI do Atlas exige --prod-ok. Idempotente (só preenche vazio).
 * Não imprime telefone, gclid nem clid (só os 4 últimos dígitos do telefone).
 */
import 'dotenv/config';
import mongoose from 'mongoose';
import { normalizeE164BR } from '../utils/phone.js';
import { phoneVariants, leadPhoneFormats } from '../services/leadAttributionService.js';
import { toLeadTrackingSource } from '../utils/attributionParser.js';
import { resolveMainPhone, shouldReopenMetaForClid, buildFbc } from '../crons/adsConversion.logic.js';

const args = process.argv.slice(2);
const arg = (k) => args.find((a) => a.startsWith(`--${k}=`))?.split('=').slice(1).join('=');
const APPLY = args.includes('--apply');
const PROD_OK = args.includes('--prod-ok');
const URI_ENV = arg('uri-env') || 'PROD_URI_READONLY';
const URI = process.env[URI_ENV];
const SINCE = new Date(arg('since') || '2026-11-01T03:00:00Z');
const WEAK_GCLID = [null, '', 'website', 'organic'];
const WEAK_META = [null, '', 'website', 'organic', 'instagram', 'facebook'];
const tail = (p) => String(p || '').replace(/\D/g, '').slice(-4);
const day = (d) => (d ? new Date(d).toLocaleDateString('pt-BR', { timeZone: 'America/Sao_Paulo' }) : '-');

async function main() {
  if (!URI) throw new Error(`env ${URI_ENV} vazia`);
  if (APPLY && /mongodb\+srv|mongodb\.net/.test(URI) && !PROD_OK) throw new Error('URI do Atlas: passe --prod-ok');
  await mongoose.connect(URI, { serverSelectionTimeoutMS: 20000 });
  const db = mongoose.connection.db;
  const LA = db.collection('leadattributions');
  const L = db.collection('leads');
  const AC = db.collection('adconversions');
  const AP = db.collection('appointments');
  const PT = db.collection('patients');
  console.log(`Banco: ${db.databaseName} | modo: ${APPLY ? 'APLICAR' : 'SIMULAÇÃO'} | desde: ${SINCE.toISOString()}`);
  const write = async (col, filter, update) => (APPLY ? (await col.updateOne(filter, update)).modifiedCount : 1);

  const tot = { A_leadsGclid: 0, B_leadsAnuncio: 0, C_agendamentosLigados: 0, C_semLeadVariosLeads: 0, D_unknown: 0, D_reclassificadas: 0, D_telefonePreenchido: 0, D_googleReaberto: 0, D_metaReaberta: 0 };

  // ── A + B: leadattributions → Lead ──────────────────────────────────────────
  const las = await LA.find({ $or: [{ gclid: { $nin: [null, ''] } }, { method: 'ctwa' }] }).toArray();
  for (const a of las) {
    const leads = await L.find({ 'contact.phone': { $in: leadPhoneFormats(a.phone) } }).project({ metaTracking: 1 }).toArray();
    for (const l of leads) {
      const mt = l.metaTracking || {};
      const set = {};
      if (a.gclid) {
        if (!mt.gclid) set['metaTracking.gclid'] = a.gclid;
        if (WEAK_GCLID.includes(mt.source ?? null)) set['metaTracking.source'] = 'google_ads';
        if (a.campaign && !mt.campaign) set['metaTracking.campaign'] = a.campaign;
      }
      if (a.method === 'ctwa') {
        if (WEAK_META.includes(mt.source ?? null) && !set['metaTracking.source']) set['metaTracking.source'] = toLeadTrackingSource(a.source);
        if (a.adId && !mt.adId) set['metaTracking.adId'] = a.adId;
        if (a.adSourceUrl && !mt.adSourceUrl) set['metaTracking.adSourceUrl'] = a.adSourceUrl;
        if (a.ctwaClid && !mt.ctwaClid) set['metaTracking.ctwaClid'] = a.ctwaClid;
      }
      if (!Object.keys(set).length) continue;
      const n = await write(L, { _id: l._id }, { $set: set });
      if (a.gclid) tot.A_leadsGclid += n; else tot.B_leadsAnuncio += n;
    }
  }

  // ── C: agendamento sem lead → Lead do mesmo telefone ────────────────────────
  const orphan = await AP.find({ createdAt: { $gte: SINCE }, $or: [{ lead: null }, { lead: { $exists: false } }] })
    .project({ patient: 1, 'patientInfo.phone': 1 }).toArray();
  const patientPhone = new Map();
  const pIds = [...new Set(orphan.map((o) => String(o.patient || '')).filter(Boolean))];
  if (pIds.length) {
    for (const p of await PT.find({ _id: { $in: pIds.map((id) => new mongoose.Types.ObjectId(id)) } }).project({ phone: 1 }).toArray()) {
      patientPhone.set(String(p._id), p.phone);
    }
  }
  const phoneOfAppt = (ap) => resolveMainPhone({ patientInfoPhone: ap.patientInfo?.phone, patientPhone: patientPhone.get(String(ap.patient)) });
  for (const ap of orphan) {
    const phone = phoneOfAppt(ap);
    if (!phone) continue;
    const leads = await L.find({ 'contact.phone': { $in: leadPhoneFormats(phone) } }).project({ _id: 1 }).limit(3).toArray();
    if (leads.length !== 1) { if (leads.length > 1) tot.C_semLeadVariosLeads++; continue; }
    tot.C_agendamentosLigados += await write(AP, { _id: ap._id, $or: [{ lead: null }, { lead: { $exists: false } }] }, { $set: { lead: leads[0]._id } });
  }

  // ── D: AdConversion "unknown" ───────────────────────────────────────────────
  const acs = await AC.find({ source: 'unknown', eventTime: { $gte: SINCE } }).toArray();
  tot.D_unknown = acs.length;
  const ignored = [];
  for (const c of acs) {
    const ap = await AP.findOne({ _id: c.appointment }, { projection: { patient: 1, lead: 1, 'patientInfo.phone': 1 } });
    if (ap?.patient && !patientPhone.has(String(ap.patient))) {
      const p = await PT.findOne({ _id: ap.patient }, { projection: { phone: 1 } });
      patientPhone.set(String(ap.patient), p?.phone || null);
    }
    const phone = c.phone || (ap ? phoneOfAppt(ap) : null);
    if (!phone) { ignored.push({ c, reason: ap ? 'sem_telefone' : 'agendamento_nao_encontrado' }); continue; }

    const norm = normalizeE164BR(phone);
    const variants = norm ? phoneVariants(norm) : [phone];
    let attr = await LA.find({ phone: { $in: variants } }).sort({ firstMessageAt: 1 }).limit(1).next();
    let method = attr ? `backfill_${attr.method}` : null;
    if (!attr) {
      const lead = await L.findOne({
        $or: [...(ap?.lead ? [{ _id: ap.lead }] : []), { 'contact.phone': { $in: leadPhoneFormats(phone) } }],
        'metaTracking.source': { $nin: [null, ''] },
      }, { projection: { metaTracking: 1 } });
      if (lead) { attr = { source: lead.metaTracking.source, ...lead.metaTracking }; method = 'backfill_lead'; }
    }
    if (!attr?.source) {
      const anyLead = await L.findOne({ 'contact.phone': { $in: leadPhoneFormats(phone) } }, { projection: { origin: 1 } });
      const reason = anyLead ? `lead_sem_origem (${anyLead.origin || 'sem origem'})` : 'sem_origem_capturada';
      ignored.push({ c, reason, phone });
      if (!c.phone) tot.D_telefonePreenchido += await write(AC, { _id: c._id, phone: null }, { $set: { phone } });
      await write(AC, { _id: c._id, unknownReason: null }, { $set: { unknownReason: anyLead ? 'lead_sem_origem' : 'sem_origem_capturada' } });
      continue;
    }

    const set = { source: attr.source, attributionMethod: method, unknownReason: null };
    if (!c.phone) { set.phone = phone; tot.D_telefonePreenchido++; }
    if (attr.adId && !c.adId) set.adId = attr.adId;
    if (attr.campaign && !c.campaign) set.campaign = attr.campaign;
    if (c.isAcquisition) {
      if (attr.gclid && !c.gclid) set.gclid = attr.gclid;
      if (attr.ctwaClid && !c.ctwaClid) set.ctwaClid = attr.ctwaClid;
      if (attr.ttclid && !c.ttclid) set.ttclid = attr.ttclid;
      if (attr.fbclid && !c.fbc) set.fbc = buildFbc(attr);
      const within90 = Date.now() - new Date(c.eventTime).getTime() < 90 * 864e5;
      if (set.gclid && c.google?.status === 'skipped' && c.google?.reason === 'sem_gclid' && within90) {
        Object.assign(set, { 'google.status': 'pending', 'google.reason': null, done: false, nextAttemptAt: new Date() });
        tot.D_googleReaberto++;
      }
      if (set.ctwaClid && shouldReopenMetaForClid(c)) {
        Object.assign(set, { meta: { status: 'pending' }, done: false, nextAttemptAt: new Date() });
        tot.D_metaReaberta++;
      }
    }
    tot.D_reclassificadas += await write(AC, { _id: c._id, source: 'unknown' }, { $set: set });
    console.log(`- AC …${String(c._id).slice(-6)} | ${day(c.eventTime)} | tel …${tail(phone)} | ${c.isAcquisition ? 'aquisição' : 'retorno'} → ${attr.source} (${method})`);
  }

  console.log(`\nContinuam "Não identificado" (${ignored.length}):`);
  const byReason = {};
  for (const { c, reason, phone } of ignored) {
    const key = reason.split(' ')[0];
    byReason[key] = (byReason[key] || 0) + 1;
    console.log(`- AC …${String(c._id).slice(-6)} | ${day(c.eventTime)} | tel …${tail(phone || c.phone)} | ${c.isAcquisition ? 'aquisição' : 'retorno'} | motivo: ${reason}`);
  }
  console.log(JSON.stringify({ ...tot, ignoradasPorMotivo: byReason, simulacao: !APPLY }, null, 1));
  await mongoose.disconnect();
}

main().catch(async (e) => { console.error('ERRO', e.message); await mongoose.disconnect().catch(() => {}); process.exit(1); });
