/**
 * Backfill ÚNICO (18/11/2026, pedido do Kadu): o gclid capturado em `leadattributions`
 * nunca chegava ao Lead nem à AdConversion, então o /api/ads-feed/google-offline.csv
 * saía só com a linha de exemplo.
 *
 * Para cada leadattribution com gclid:
 *   1) Lead do mesmo telefone (todas as variantes de formato): grava metaTracking.gclid,
 *      origem google_ads (só se vazia/website/organic) e campanha (só se vazia).
 *   2) AdConversion de AQUISIÇÃO desses telefones/leads com eventTime >= --since (padrão 12/11/2026
 *      00:00 Brasília) e sem gclid: grava gclid, origem google_ads (se "unknown") e campanha;
 *      se o Google estava "skipped/sem_gclid", reabre como pending (igual ao cron).
 * No fim conta as linhas reais que o google-offline.csv passa a ter (mesma query da rota).
 *
 * Uso (PowerShell, um comando por vez, na pasta back):
 *   node scripts/_backfill-gclid-leadattribution.js                   → SIMULAÇÃO (só lê)
 *   node scripts/_backfill-gclid-leadattribution.js --uri-env=NOME_DA_ENV --apply --prod-ok
 *
 * Regras: sem --apply não escreve nada. URI do Atlas exige --prod-ok. Idempotente
 * (só preenche campo vazio). Não imprime telefone nem gclid (só os 4 últimos dígitos).
 */
import 'dotenv/config';
import mongoose from 'mongoose';
import { normalizeE164BR } from '../utils/phone.js';
import { phoneVariants, leadPhoneFormats } from '../services/leadAttributionService.js';

const args = process.argv.slice(2);
const arg = (k) => args.find((a) => a.startsWith(`--${k}=`))?.split('=').slice(1).join('=');
const APPLY = args.includes('--apply');
const PROD_OK = args.includes('--prod-ok');
const URI_ENV = arg('uri-env') || 'PROD_URI_READONLY';
const URI = process.env[URI_ENV];
const SINCE = new Date(arg('since') || '2026-11-12T03:00:00Z');
const WEAK = [null, '', 'website', 'organic'];
const tail = (p) => String(p || '').slice(-4);

async function main() {
  if (!URI) throw new Error(`env ${URI_ENV} vazia`);
  if (APPLY && /mongodb\+srv|mongodb\.net/.test(URI) && !PROD_OK) throw new Error('URI do Atlas: passe --prod-ok');
  await mongoose.connect(URI, { serverSelectionTimeoutMS: 20000 });
  const db = mongoose.connection.db;
  const LA = db.collection('leadattributions');
  const L = db.collection('leads');
  const AC = db.collection('adconversions');
  const AP = db.collection('appointments');
  console.log(`Banco: ${db.databaseName} | modo: ${APPLY ? 'APLICAR' : 'SIMULAÇÃO'} | desde: ${SINCE.toISOString()}`);

  const csvQuery = { gclid: { $nin: [null, ''] }, eventTime: { $gte: new Date(Date.now() - 60 * 864e5) } };
  const csvBefore = await AC.countDocuments(csvQuery);

  const attrs = await LA.find({ gclid: { $nin: [null, ''] } }).project({ phone: 1, gclid: 1, campaign: 1, source: 1, firstMessageAt: 1 }).toArray();
  console.log(`leadattributions com gclid: ${attrs.length}`);

  const tot = { leads: 0, leadsAlterados: 0, acAquisicao: 0, acAlteradas: 0, acNaoAquisicao: 0, acJaComGclid: 0 };
  for (const a of attrs) {
    const norm = normalizeE164BR(a.phone);
    const formats = leadPhoneFormats(a.phone);
    const variants = norm ? phoneVariants(norm) : [a.phone];

    // 1) Leads
    const leads = await L.find({ 'contact.phone': { $in: formats } }).project({ metaTracking: 1 }).toArray();
    tot.leads += leads.length;
    let leadsChanged = 0;
    for (const l of leads) {
      const mt = l.metaTracking || {};
      const set = {};
      if (!mt.gclid) set['metaTracking.gclid'] = a.gclid;
      if (WEAK.includes(mt.source ?? null)) set['metaTracking.source'] = 'google_ads';
      if (a.campaign && !mt.campaign) set['metaTracking.campaign'] = a.campaign;
      if (!Object.keys(set).length) continue;
      leadsChanged++;
      if (APPLY) await L.updateOne({ _id: l._id }, { $set: set });
    }
    tot.leadsAlterados += leadsChanged;

    // 2) AdConversion: pelo telefone ou por agendamento ligado a um desses leads
    const leadIds = leads.map((l) => l._id);
    const apptIds = leadIds.length ? (await AP.find({ lead: { $in: leadIds } }).project({ _id: 1 }).toArray()).map((x) => x._id) : [];
    const acs = await AC.find({
      eventTime: { $gte: SINCE },
      $or: [{ phone: { $in: variants } }, ...(apptIds.length ? [{ appointment: { $in: apptIds } }] : [])],
    }).project({ isAcquisition: 1, gclid: 1, source: 1, campaign: 1, google: 1, eventTime: 1 }).toArray();

    let acChanged = 0;
    for (const c of acs) {
      if (c.gclid) { tot.acJaComGclid++; continue; }
      if (!c.isAcquisition) { tot.acNaoAquisicao++; continue; } // não é 1º agendamento: não vira conversão
      tot.acAquisicao++;
      const set = { gclid: a.gclid };
      if (!c.source || c.source === 'unknown') { set.source = 'google_ads'; set.attributionMethod = 'backfill_gclid'; }
      if (a.campaign && !c.campaign) set.campaign = a.campaign;
      const within90 = Date.now() - new Date(c.eventTime).getTime() < 90 * 864e5;
      if (c.google?.status === 'skipped' && c.google?.reason === 'sem_gclid' && within90) {
        Object.assign(set, { 'google.status': 'pending', 'google.reason': null, done: false, nextAttemptAt: new Date() });
      }
      acChanged++;
      if (APPLY) await AC.updateOne({ _id: c._id, gclid: { $in: [null, ''] } }, { $set: set });
    }
    tot.acAlteradas += acChanged;
    console.log(`- tel …${tail(norm || a.phone)} | origem ${a.source} | leads ${leads.length} (alterar ${leadsChanged}) | adconversions desde 12/11 ${acs.length} (alterar ${acChanged})`);
  }

  const csvAfter = APPLY ? await AC.countDocuments(csvQuery) : csvBefore + tot.acAlteradas;
  console.log(JSON.stringify({ ...tot, csvLinhasReaisAntes: csvBefore, csvLinhasReaisDepois: csvAfter, simulacao: !APPLY }, null, 1));
  await mongoose.disconnect();
}

main().catch(async (e) => { console.error('ERRO', e.message); await mongoose.disconnect().catch(() => {}); process.exit(1); });
