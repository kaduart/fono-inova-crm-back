// back/scripts/backfill-payment-provider-guia-16007195.js
//
// Corrige Payment.insurance.provider desatualizado para a guia 16007195
// (Isabela Ferreira De Mendonca), que estava gravada como "unimed-goiania"
// e foi corrigida para "unimed-anapolis" via PUT /api/v2/insurance-guides/:id
// (que não tem efeito cascata em Payment — Payment.insurance.provider é
// snapshot write-once, copiado da guia só na criação, sem sincronização).
//
// Guarda de segurança (decisão do usuário 2026-07-21): só corrige Payment
// quando:
//   payment.insurance.provider !== guide.insurance (está divergente)
//   E (payment não pertence a nenhum InsuranceBatch
//      OU batch.insuranceProvider === guide.insurance)
// Ou seja: nunca corrige um Payment cujo lote já enviado discorde do valor
// novo da guia — isso indicaria um cenário legítimo diferente, não um erro
// de snapshot.
//
// Uso: node scripts/backfill-payment-provider-guia-16007195.js           (dry-run)
//      node scripts/backfill-payment-provider-guia-16007195.js --apply   (aplica)

import 'dotenv/config';
import './../models/index.js';
import './../models/InsuranceBatch.js';
import mongoose from 'mongoose';

const APPLY = process.argv.includes('--apply');
const GUIDE_ID = new mongoose.Types.ObjectId('69d67c4919c6571d8c76dae9');

async function main() {
  const MONGO_URI = process.env.MONGO_URI || process.env.MONGODB_URI;
  await mongoose.connect(MONGO_URI);

  const InsuranceGuide = mongoose.model('InsuranceGuide');
  const Payment = mongoose.model('Payment');
  const InsuranceBatch = mongoose.model('InsuranceBatch');
  const Patient = mongoose.model('Patient');

  const guide = await InsuranceGuide.findById(GUIDE_ID).lean();
  if (!guide) throw new Error('Guia não encontrada');

  const patient = await Patient.findById(guide.patientId).select('fullName').lean();

  const payments = await Payment.find({ 'insurance.guideId': GUIDE_ID }).lean();

  const rows = [];
  for (const p of payments) {
    const currentProvider = p.insurance?.provider || null;
    const batch = await InsuranceBatch.findOne({ 'sessions.session': p.session })
      .select('batchNumber insuranceProvider status')
      .lean();

    const alreadyCorrect = currentProvider === guide.insurance;
    const batchAgrees = !batch || batch.insuranceProvider === guide.insurance;
    const eligible = !alreadyCorrect && batchAgrees;

    rows.push({
      paymentId: p._id.toString(),
      patient: patient?.fullName || guide.patientId.toString(),
      guideNumber: guide.number,
      providerAtual: currentProvider,
      providerNovo: guide.insurance,
      lote: batch ? batch.batchNumber : '(nenhum)',
      loteProvider: batch ? batch.insuranceProvider : null,
      loteStatus: batch ? batch.status : null,
      paymentStatus: p.status,
      valor: p.amount,
      eligible,
      motivo: alreadyCorrect
        ? 'já está correto, ignorado'
        : !batchAgrees
        ? `EXCLUÍDO — lote diverge (batch=${batch.insuranceProvider} != guia=${guide.insurance}), requer revisão manual`
        : 'snapshot desatualizado, lote (se houver) concorda com a guia — elegível'
    });
  }

  console.log(`\n=== Dry-run: guia ${guide.number} (${patient?.fullName}) — insurance atual da guia: ${guide.insurance} ===\n`);
  rows.forEach(r => {
    console.log(JSON.stringify(r, null, 2));
  });

  const toFix = rows.filter(r => r.eligible);
  console.log(`\nTotal de Payments encontrados: ${rows.length}`);
  console.log(`Elegíveis para correção: ${toFix.length}`);
  console.log(`Excluídos por divergência de lote: ${rows.filter(r => r.motivo.startsWith('EXCLUÍDO')).length}`);
  console.log(`Já corretos: ${rows.filter(r => r.motivo.startsWith('já')).length}`);

  if (APPLY) {
    if (toFix.length === 0) {
      console.log('\nNada a aplicar.');
    } else {
      const ids = toFix.map(r => new mongoose.Types.ObjectId(r.paymentId));
      const result = await Payment.updateMany(
        { _id: { $in: ids } },
        { $set: { 'insurance.provider': guide.insurance } }
      );
      console.log(`\n✅ APPLY: ${result.modifiedCount} Payments atualizados para provider="${guide.insurance}".`);
      console.log(`Log: ${new Date().toISOString()} | guia=${guide.number} | ${result.modifiedCount} payments | motivo: Sincronização do insurance.provider após correção da guia`);
    }
  } else {
    console.log('\n(Dry-run — nada foi alterado. Rode com --apply para aplicar.)');
  }

  await mongoose.disconnect();
}

main().catch(err => {
  console.error('Erro:', err);
  process.exit(1);
});
