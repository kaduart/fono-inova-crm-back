/**
 * 🔧 Migração: backfill de InsuranceGuide.sessionValue em guias legadas
 *
 * Contexto: guias criadas antes da arquitetura de convênio atual ficaram sem
 * `sessionValue`. Como o histórico usa `guide.sessionValue || session.sessionValue || 0`,
 * essas sessões entram na CONTAGEM valendo R$0 — quebrando a aritmética
 * (ex: 14 sessões exibindo R$1.540 em vez de R$1.960).
 *
 * NÃO altera regra de negócio nem o controller — só preenche dado faltante.
 *
 * Prioridade de reconstrução (para na primeira que resolver):
 *   1. Payment.insurance.grossAmount da sessão
 *   2. Payment.amount da sessão (convênio, não cancelado)
 *   3. Session.sessionValue
 *   → nenhuma: fica para análise manual, nada é gravado
 *
 * Uso:
 *   node scripts/migrate-legacy-guide-session-value.js            # DRY-RUN (padrão)
 *   node scripts/migrate-legacy-guide-session-value.js --apply    # grava
 */

import mongoose from 'mongoose';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, '../.env') });

import InsuranceGuide from '../models/InsuranceGuide.js';
import Session from '../models/Session.js';
import Payment from '../models/Payment.js';

const APPLY = process.argv.includes('--apply');

/** Valor mais frequente (moda) entre os candidatos — evita que um outlier defina a guia. */
function mostFrequent(values) {
  const count = new Map();
  for (const v of values) count.set(v, (count.get(v) || 0) + 1);
  let best = null, bestN = 0;
  for (const [v, n] of count) if (n > bestN) { best = v; bestN = n; }
  return best;
}

async function resolveSessionValue(guide) {
  const sessions = await Session.find({ insuranceGuide: guide._id })
    .select('_id sessionValue').lean();

  if (!sessions.length) return { value: null, source: 'sem-sessoes', sessions: 0 };

  const sessionIds = sessions.map(s => s._id);
  const payments = await Payment.find({
    session: { $in: sessionIds },
    billingType: 'convenio',
    status: { $ne: 'canceled' }
  }).select('session amount insurance.grossAmount').lean();

  const bySession = new Map(payments.map(p => [String(p.session), p]));

  const candidates = [];
  let source = null;

  for (const s of sessions) {
    const pmt = bySession.get(String(s._id));
    const gross = pmt?.insurance?.grossAmount;
    if (gross > 0) { candidates.push(gross); source = source || 'payment.insurance.grossAmount'; continue; }
    if (pmt?.amount > 0) { candidates.push(pmt.amount); source = source || 'payment.amount'; continue; }
    if (s.sessionValue > 0) { candidates.push(s.sessionValue); source = source || 'session.sessionValue'; }
  }

  if (!candidates.length) return { value: null, source: 'manual', sessions: sessions.length };
  return { value: mostFrequent(candidates), source, sessions: sessions.length };
}

async function main() {
  await mongoose.connect(process.env.MONGO_URI);

  const guides = await InsuranceGuide.find({
    $or: [{ sessionValue: null }, { sessionValue: { $exists: false } }, { sessionValue: 0 }]
  }).select('number insurance specialty sessionValue issuedAt createdAt').lean();

  console.log(`\n${APPLY ? '⚠️  MODO APPLY — vai gravar' : '🧪 DRY-RUN — nada será gravado'}`);
  console.log(`Guias sem sessionValue: ${guides.length}\n`);

  const resolved = [];
  const manual = [];

  for (const g of guides) {
    const r = await resolveSessionValue(g);
    const emissao = new Date(g.issuedAt || g.createdAt).toISOString().slice(0, 10);
    const line = `  Guia ${String(g.number).padEnd(10)} | ${String(g.insurance).padEnd(16)} | ${String(g.specialty).padEnd(18)} | emit ${emissao} | ${r.sessions} sess`;

    if (r.value == null) {
      manual.push({ ...g, ...r });
      console.log(`${line} | ❓ SEM FONTE (${r.source}) → análise manual`);
    } else {
      resolved.push({ ...g, ...r });
      console.log(`${line} | ✅ R$${r.value} (fonte: ${r.source})`);
    }
  }

  console.log(`\n── Resumo ──`);
  console.log(`  Corrigíveis automaticamente: ${resolved.length}`);
  console.log(`  Precisam de análise manual:  ${manual.length}`);

  const porFonte = {};
  resolved.forEach(r => { porFonte[r.source] = (porFonte[r.source] || 0) + 1; });
  Object.entries(porFonte).forEach(([s, n]) => console.log(`     ${s}: ${n}`));

  if (APPLY && resolved.length) {
    const ops = resolved.map(r => ({
      updateOne: { filter: { _id: r._id }, update: { $set: { sessionValue: r.value } } }
    }));
    const res = await InsuranceGuide.bulkWrite(ops);
    console.log(`\n✅ Gravado: ${res.modifiedCount} guia(s) atualizada(s).`);
  } else if (!APPLY) {
    console.log(`\nNada gravado. Rode com --apply para aplicar.`);
  }

  await mongoose.disconnect();
}

main().catch(err => { console.error('❌', err.message); process.exit(1); });
