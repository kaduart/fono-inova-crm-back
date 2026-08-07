/**
 * 📸 Snapshot de reconciliação por profissional (antes/depois)
 *
 * Congela produção, recebido, comissão e sessões órfãs por profissional/mês,
 * para comparar o estado ANTES e DEPOIS da correção do ADR-015
 * (`Payment.doctor` deixa de filtrar pagamentos; profissional resolvido por
 * `Payment → Session → Session.doctor`).
 *
 * O universo padrão são os profissionais afetados: os que têm ao menos um
 * Payment pago com `session` preenchida e `doctor` ausente — resolvidos pela
 * Session, nunca pelo Payment (INVARIANTE 16).
 *
 * NÃO altera nada. Só lê e grava o JSON de snapshot.
 *
 * Uso:
 *   node scripts/snapshot-professional-reconciliation.js --label=antes
 *   node scripts/snapshot-professional-reconciliation.js --label=depois
 *   node scripts/snapshot-professional-reconciliation.js --compare=antes,depois
 *
 * Opções: --year=2026  --months=1-8  --out=./snapshots
 */

import fs from 'fs';
import mongoose from 'mongoose';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, '../.env') });

import Payment from '../models/Payment.js';
import Session from '../models/Session.js';
import Doctor from '../models/Doctor.js';
import { getDoctorReconciliation } from '../services/reconciliation.service.js';

const arg = (name, fallback) => {
  const hit = process.argv.find(a => a.startsWith(`--${name}=`));
  return hit ? hit.split('=').slice(1).join('=') : fallback;
};

const year = Number(arg('year', new Date().getFullYear()));
const label = arg('label', null);
const compare = arg('compare', null);
const outDir = path.resolve(__dirname, arg('out', '../snapshots'));
const [mFrom, mTo] = arg('months', `1-${new Date().getMonth() + 1}`).split('-').map(Number);

const brl = v => `R$ ${Number(v || 0).toFixed(2)}`;
const monthRange = m => {
  const start = `${year}-${String(m).padStart(2, '0')}-01`;
  const end = new Date(year, m, 0).toISOString().slice(0, 10);
  return { start, end };
};

/** Profissionais afetados — resolvidos pela Session, nunca pelo Payment.doctor */
async function affectedDoctorIds() {
  const pagos = await Payment.find({
    session: { $ne: null },
    status: 'paid',
    $or: [{ doctor: null }, { doctor: { $exists: false } }]
  }).select('session').lean();

  const sessions = await Session.find({ _id: { $in: pagos.map(p => p.session) } })
    .select('_id doctor').lean();

  return [...new Set(sessions.map(s => s.doctor).filter(Boolean).map(String))]
    .filter(id => /^[a-f0-9]{24}$/i.test(id));
}

async function capture() {
  const ids = await affectedDoctorIds();
  const doctors = await Doctor.find({ _id: { $in: ids } }).select('fullName').lean();
  const nome = new Map(doctors.map(d => [String(d._id), d.fullName]));

  console.log(`📸 Snapshot "${label}" — ${ids.length} profissionais, meses ${mFrom}–${mTo}/${year}\n`);

  const snapshot = { label, year, months: [mFrom, mTo], capturedAt: new Date().toISOString(), doctors: {} };

  for (const id of ids) {
    const entry = { name: nome.get(id) || id, months: {} };
    for (let m = mFrom; m <= mTo; m++) {
      const { start, end } = monthRange(m);
      let rec;
      try {
        rec = await getDoctorReconciliation(id, start, end);
      } catch (err) {
        entry.months[m] = { error: err.message };
        continue;
      }
      const r = rec?.reconciliation || {};
      entry.months[m] = {
        production: r.production || 0,
        received: r.received || 0,
        commission: r.commission || 0,
        orphanSessions: r.orphanSessions || 0,
        orphanSessionIds: (r.orphanSessionsList || []).map(s => String(s.sessionId))
      };
    }
    const tot = Object.values(entry.months).filter(x => !x.error);
    entry.total = {
      production: tot.reduce((a, x) => a + x.production, 0),
      received: tot.reduce((a, x) => a + x.received, 0),
      commission: tot.reduce((a, x) => a + x.commission, 0),
      orphanSessions: tot.reduce((a, x) => a + x.orphanSessions, 0)
    };
    snapshot.doctors[id] = entry;
    console.log(
      `  ${entry.name.padEnd(34)} prod ${brl(entry.total.production).padStart(13)} | ` +
      `receb ${brl(entry.total.received).padStart(13)} | com ${brl(entry.total.commission).padStart(11)} | ` +
      `órfãs ${String(entry.total.orphanSessions).padStart(3)}`
    );
  }

  const geral = Object.values(snapshot.doctors).reduce((a, d) => ({
    production: a.production + d.total.production,
    received: a.received + d.total.received,
    commission: a.commission + d.total.commission,
    orphanSessions: a.orphanSessions + d.total.orphanSessions
  }), { production: 0, received: 0, commission: 0, orphanSessions: 0 });
  snapshot.geral = geral;

  console.log(`\n  ${'TOTAL'.padEnd(34)} prod ${brl(geral.production).padStart(13)} | ` +
    `receb ${brl(geral.received).padStart(13)} | com ${brl(geral.commission).padStart(11)} | ` +
    `órfãs ${String(geral.orphanSessions).padStart(3)}`);

  fs.mkdirSync(outDir, { recursive: true });
  const file = path.join(outDir, `reconciliation-${year}-${label}.json`);
  fs.writeFileSync(file, JSON.stringify(snapshot, null, 2));
  console.log(`\n💾 ${file}`);
}

function compareSnapshots(a, b) {
  const load = l => {
    const f = path.join(outDir, `reconciliation-${year}-${l}.json`);
    if (!fs.existsSync(f)) throw new Error(`Snapshot "${l}" não encontrado: ${f}`);
    return JSON.parse(fs.readFileSync(f, 'utf8'));
  };
  const sa = load(a), sb = load(b);

  console.log(`\n══════ Comparativo ${a} → ${b} (${year}) ══════\n`);
  const diff = (x, y) => {
    const d = (y || 0) - (x || 0);
    return d === 0 ? '  =' : (d > 0 ? `+${d.toFixed(2)}` : d.toFixed(2));
  };

  const ids = [...new Set([...Object.keys(sa.doctors), ...Object.keys(sb.doctors)])];
  let mudou = 0;
  for (const id of ids) {
    const da = sa.doctors[id]?.total || { production: 0, received: 0, commission: 0, orphanSessions: 0 };
    const db = sb.doctors[id]?.total || { production: 0, received: 0, commission: 0, orphanSessions: 0 };
    const nome = sb.doctors[id]?.name || sa.doctors[id]?.name || id;
    const igual = ['production', 'received', 'commission', 'orphanSessions'].every(k => da[k] === db[k]);
    if (igual) continue;
    mudou++;
    console.log(`  ${nome}`);
    console.log(`     produção   ${brl(da.production)} → ${brl(db.production)}   (${diff(da.production, db.production)})`);
    console.log(`     recebido   ${brl(da.received)} → ${brl(db.received)}   (${diff(da.received, db.received)})`);
    console.log(`     comissão   ${brl(da.commission)} → ${brl(db.commission)}   (${diff(da.commission, db.commission)})`);
    console.log(`     órfãs      ${da.orphanSessions} → ${db.orphanSessions}   (${db.orphanSessions - da.orphanSessions})\n`);
  }
  if (!mudou) console.log('  Nenhuma diferença.\n');

  console.log(`  ── Geral ──`);
  console.log(`     produção   ${brl(sa.geral.production)} → ${brl(sb.geral.production)}  (${diff(sa.geral.production, sb.geral.production)})`);
  console.log(`     recebido   ${brl(sa.geral.received)} → ${brl(sb.geral.received)}  (${diff(sa.geral.received, sb.geral.received)})`);
  console.log(`     comissão   ${brl(sa.geral.commission)} → ${brl(sb.geral.commission)}  (${diff(sa.geral.commission, sb.geral.commission)})`);
  console.log(`     órfãs      ${sa.geral.orphanSessions} → ${sb.geral.orphanSessions}  (${sb.geral.orphanSessions - sa.geral.orphanSessions})`);
  console.log(`\n  ⚠️  Esperado pelo ADR-015:`);
  console.log(`       • órfãs CAEM  • recebido SOBE (payments antes invisíveis)`);
  console.log(`       • produção e comissão NÃO MUDAM — ambas derivam de Session, não de Payment.`);
  console.log(`     Produção ou comissão diferente = produção mudou de dono. Investigar antes de aceitar.`);
}

async function main() {
  if (compare) {
    const [a, b] = compare.split(',');
    compareSnapshots(a, b);
    return;
  }
  if (!label) {
    console.error('❌ Informe --label=antes|depois (ou --compare=antes,depois)');
    process.exit(1);
  }
  await mongoose.connect(process.env.MONGO_URI);
  await capture();
  await mongoose.disconnect();
}

main().catch(err => { console.error('❌', err.message); process.exit(1); });
