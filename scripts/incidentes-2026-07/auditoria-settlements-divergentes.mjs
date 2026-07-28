import mongoose from 'mongoose';
import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import path from 'path';
import fs from 'fs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
dotenv.config({ path: path.resolve(__dirname, '../.env') });

const MONGO_URI = process.env.MONGODB_URI || process.env.MONGO_URI;
if (!MONGO_URI) { console.error('❌ MONGODB_URI não configurada'); process.exit(1); }

const DRY_RUN = process.env.DRY_RUN !== 'false';

async function main() {
  await mongoose.connect(MONGO_URI);
  const Payment = (await import('../models/Payment.js')).default;

  const settlements = await Payment.find({
    kind: 'monthly_settlement',
    status: { $nin: ['cancelled', 'canceled'] }
  })
  .populate('settledPaymentIds', 'amount status kind')
  .populate('patient', 'fullName')
  .sort({ createdAt: -1 })
  .lean();

  const divergentes = [];
  const consistentes = [];

  for (const ms of settlements) {
    const settled = ms.settledPaymentIds || [];
    const sumSettled = settled
      .filter(p => p && !['cancelled', 'canceled'].includes(p.status))
      .reduce((acc, p) => acc + (p.amount || 0), 0);
    const diff = (ms.amount || 0) - sumSettled;

    const record = {
      settlementId: ms._id.toString(),
      patient: ms.patient?.fullName || 'N/A',
      patientId: ms.patient?._id?.toString(),
      amount: ms.amount || 0,
      sumSettled,
      diff,
      status: ms.status,
      paymentMethod: ms.paymentMethod,
      paidAt: ms.paidAt,
      financialDate: ms.financialDate,
      createdAt: ms.createdAt,
      settledPaymentIds: settled.map(p => p?._id?.toString()).filter(Boolean),
      settledDetails: settled.map(p => ({
        id: p?._id?.toString(),
        amount: p?.amount || 0,
        status: p?.status,
        kind: p?.kind
      }))
    };

    if (Math.abs(diff) > 0.009) {
      divergentes.push(record);
    } else {
      consistentes.push(record);
    }
  }

  console.log('══════════════════════════════════════════════════════════');
  console.log('  AUDITORIA: SETTLEMENTS COM VALOR DIVERGENTE DOS PAGAMENTOS');
  console.log('══════════════════════════════════════════════════════════');
  console.log(`Total de settlements analisados: ${settlements.length}`);
  console.log(`Consistentes: ${consistentes.length}`);
  console.log(`Divergentes: ${divergentes.length}`);
  console.log(`DRY_RUN: ${DRY_RUN}`);
  console.log('');

  if (divergentes.length === 0) {
    console.log('✅ Nenhum settlement divergente encontrado.');
    await mongoose.disconnect();
    return;
  }

  for (const d of divergentes) {
    console.log(`\n👤 Paciente: ${d.patient} | ID: ${d.patientId}`);
    console.log(`💰 Settlement: ${d.settlementId}`);
    console.log(`   Valor do settlement: R$ ${d.amount.toFixed(2)}`);
    console.log(`   Soma dos settledPaymentIds: R$ ${d.sumSettled.toFixed(2)}`);
    console.log(`   Diferença: R$ ${d.diff.toFixed(2)}`);
    console.log(`   Status: ${d.status} | Método: ${d.paymentMethod}`);
    console.log(`   paidAt: ${d.paidAt ? new Date(d.paidAt).toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' }) : '—'}`);
    console.log(`   settledPaymentIds (${d.settledPaymentIds.length}):`);
    for (const sd of d.settledDetails) {
      console.log(`      → ${sd.id} | R$ ${sd.amount.toFixed(2)} | ${sd.status} | ${sd.kind}`);
    }
  }

  const totalDivergencia = divergentes.reduce((acc, d) => acc + Math.abs(d.diff), 0);
  console.log(`\n💵 Total absoluto em divergência: R$ ${totalDivergencia.toFixed(2)}`);

  const outputPath = path.resolve(__dirname, '../../auditoria-output/auditoria-settlements-divergentes.json');
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, JSON.stringify({
    generatedAt: new Date().toISOString(),
    dryRun: DRY_RUN,
    totalSettlements: settlements.length,
    consistentes: consistentes.length,
    divergentes: divergentes.length,
    divergentes,
    consistentes
  }, null, 2));
  console.log(`\n📝 Relatório salvo em: ${outputPath}`);

  await mongoose.disconnect();
}

main().catch(err => { console.error(err); process.exit(1); });
