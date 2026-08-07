/**
 * 💰 Correção: valor R$100 gravado por script errado na Unimed Anápolis
 *
 * Regra de negócio (definida pelo dono da clínica, 2026-08-07):
 *   - O valor da sessão na Unimed Anápolis é R$80.
 *   - EXCEÇÃO: o paciente Nicolas Lucca passou a R$100 a partir do meio de maio/2026.
 *     Maio dele fica como está (a virada foi no meio do mês).
 *   - Um script rodado errado gravou R$100 em pacientes que nunca foram R$100.
 *
 * Duas correções:
 *   A) Payment.amount 100 → 80 nos pacientes que nunca foram R$100
 *      (Benjamim Rocha Simão — 16 billed + 3 pending; Joaquim Rocha Simão — 4 pending)
 *   B) InsuranceGuide.sessionValue 100 → 80 nas guias que não são do Nicolas,
 *      e nas guias do Nicolas cujas sessões são todas anteriores a maio/2026.
 *      Guias do Nicolas que alcançam maio ou depois ficam em R$100.
 *
 * ⚠️ Não toca em FinancialLedger (imutável por design).
 *
 * Uso:
 *   node scripts/fix-anapolis-session-value-100-to-80.js           # dry-run
 *   node scripts/fix-anapolis-session-value-100-to-80.js --apply
 */

import mongoose from 'mongoose';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, '../.env') });

import Patient from '../models/Patient.js';
import Payment from '../models/Payment.js';
import Session from '../models/Session.js';
import InsuranceGuide from '../models/InsuranceGuide.js';
import InsuranceBatch from '../models/InsuranceBatch.js';

const APPLY = process.argv.includes('--apply');
const VALOR_ERRADO = 100;
const VALOR_CERTO = 80;
const PACIENTE_EXCECAO = 'Nicolas Lucca';
const VIRADA = new Date('2026-05-01T00:00:00.000Z');

const fmt = v => `R$ ${Number(v || 0).toFixed(2)}`;
const dt = d => (d && !isNaN(new Date(d))) ? new Date(d).toISOString().slice(0, 10) : '—';

async function main() {
  await mongoose.connect(process.env.MONGO_URI);
  console.log(`\n${APPLY ? '🔴 APLICANDO' : '🔵 DRY-RUN'} — R$100 → R$80 Unimed Anápolis\n`);

  const nicolas = await Patient.findOne({ fullName: PACIENTE_EXCECAO }).select('_id fullName').lean();
  if (!nicolas) throw new Error(`Paciente exceção "${PACIENTE_EXCECAO}" não encontrado — abortando`);

  // ── A. Payments ────────────────────────────────────────────────────
  const pmts = await Payment.find({
    'insurance.provider': /anapolis/i,
    status: { $nin: ['canceled', 'cancelled'] }
  }).populate('patient', 'fullName').select('_id amount status patient insurance session').lean();

  const alvoPmt = pmts.filter(p =>
    (p.insurance?.grossAmount || p.amount) === VALOR_ERRADO &&
    String(p.patient?._id) !== String(nicolas._id)
  );

  console.log('── A. Payments a corrigir ──');
  const porPac = {};
  alvoPmt.forEach(p => {
    const n = p.patient?.fullName || '(sem paciente)';
    porPac[n] = porPac[n] || { n: 0, st: {} };
    porPac[n].n++;
    porPac[n].st[p.status] = (porPac[n].st[p.status] || 0) + 1;
  });
  Object.entries(porPac).forEach(([n, v]) =>
    console.log(`   ${n.padEnd(30)} ${String(v.n).padStart(3)} payments ${JSON.stringify(v.st)}`));
  console.log(`   TOTAL: ${alvoPmt.length} payments | impacto ${fmt(alvoPmt.length * (VALOR_ERRADO - VALOR_CERTO))} a menos`);

  // Lotes afetados — alterar valor de payment 'billed' desincroniza total do lote
  const billedIds = alvoPmt.filter(p => p.status === 'billed').map(p => p._id);
  if (billedIds.length) {
    const lotes = await InsuranceBatch.find({ 'sessions.payment': { $in: billedIds } })
      .select('_id batchNumber totalAmount status').lean();
    console.log(`\n   ⚠️  ${billedIds.length} payments estão 'billed'. Lotes que os referenciam: ${lotes.length}`);
    lotes.forEach(l => console.log(`      lote ${l.batchNumber || l._id} | ${l.status} | total ${fmt(l.totalAmount)}`));
    if (!lotes.length) console.log(`      (nenhum lote referencia esses payments — só o Payment muda)`);
  }

  // ── B. Guias ───────────────────────────────────────────────────────
  const guias = await InsuranceGuide.find({ insurance: 'unimed-anapolis', sessionValue: VALOR_ERRADO })
    .populate('patientId', 'fullName').select('_id number specialty status sessionValue patientId').lean();

  const guiasCorrigir = [];
  const guiasManter = [];

  for (const g of guias) {
    const ehNicolas = String(g.patientId?._id) === String(nicolas._id);
    if (!ehNicolas) { guiasCorrigir.push({ g, motivo: 'paciente nunca foi R$100' }); continue; }

    const sess = await Session.find({ insuranceGuide: g._id }).select('date').lean();
    const datas = sess.map(s => s.date).filter(d => d && !isNaN(new Date(d))).map(d => new Date(d));
    const maxData = datas.length ? new Date(Math.max(...datas)) : null;

    if (maxData && maxData < VIRADA) {
      guiasCorrigir.push({ g, motivo: `Nicolas, sessões até ${dt(maxData)} (antes da virada)` });
    } else {
      guiasManter.push({ g, motivo: maxData ? `Nicolas, alcança ${dt(maxData)}` : 'Nicolas, sem sessão datada' });
    }
  }

  console.log('\n── B. Guias a corrigir (sessionValue 100 → 80) ──');
  guiasCorrigir.forEach(({ g, motivo }) =>
    console.log(`   ${String(g.number).padEnd(24)} ${(g.patientId?.fullName || '(sem paciente)').padEnd(30)} ${g.status.padEnd(10)} — ${motivo}`));
  console.log(`   TOTAL: ${guiasCorrigir.length}`);

  console.log('\n── B. Guias mantidas em R$100 ──');
  guiasManter.forEach(({ g, motivo }) =>
    console.log(`   ${String(g.number).padEnd(24)} ${(g.patientId?.fullName || '?').padEnd(30)} — ${motivo}`));
  console.log(`   TOTAL: ${guiasManter.length}`);

  if (!APPLY) {
    console.log('\n🔵 DRY-RUN — nada foi alterado. Rode com --apply para executar.');
    await mongoose.disconnect();
    return;
  }

  console.log('\n── Executando ──');

  let okPmt = 0;
  for (const p of alvoPmt) {
    const set = { amount: VALOR_CERTO };
    if (p.insurance?.grossAmount != null) set['insurance.grossAmount'] = VALOR_CERTO;
    await Payment.updateOne({ _id: p._id }, { $set: set });
    okPmt++;
  }
  console.log(`   payments corrigidos: ${okPmt}`);

  const resGuia = await InsuranceGuide.updateMany(
    { _id: { $in: guiasCorrigir.map(x => x.g._id) } },
    { $set: { sessionValue: VALOR_CERTO } }
  );
  console.log(`   guias corrigidas:    ${resGuia.modifiedCount}`);

  console.log('\n✅ Concluído. FinancialLedger não foi tocado.');
  await mongoose.disconnect();
}

main().catch(err => { console.error('❌', err.message); process.exit(1); });
