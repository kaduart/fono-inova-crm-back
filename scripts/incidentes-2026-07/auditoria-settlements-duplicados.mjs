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

async function main() {
  await mongoose.connect(MONGO_URI);
  const Payment = (await import('../models/Payment.js')).default;

  const settlements = await Payment.find({
    kind: 'monthly_settlement',
    status: { $nin: ['cancelled', 'canceled'] }
  })
  .populate('patient', 'fullName')
  .sort({ createdAt: -1 })
  .lean();

  // Agrupar por chave composta: patientId + sorted settledPaymentIds + amount
  const groups = new Map();
  for (const ms of settlements) {
    const patientId = ms.patient?._id?.toString() || 'unknown';
    const settledIds = (ms.settledPaymentIds || [])
      .map(id => id.toString())
      .sort()
      .join(',');
    const key = `${patientId}::${ms.amount || 0}::${settledIds}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(ms);
  }

  const duplicates = [];
  for (const [key, items] of groups.entries()) {
    if (items.length > 1) {
      duplicates.push({ key, count: items.length, items });
    }
  }

  console.log('══════════════════════════════════════════════════════════');
  console.log('  AUDITORIA: SETTLEMENTS DUPLICADOS HISTÓRICOS');
  console.log('══════════════════════════════════════════════════════════');
  console.log(`Total de settlements analisados: ${settlements.length}`);
  console.log(`Grupos com duplicatas: ${duplicates.length}`);
  console.log('');

  if (duplicates.length === 0) {
    console.log('✅ Nenhum settlement duplicado encontrado.');
  } else {
    for (const d of duplicates) {
      const [patientId, amount] = d.key.split('::');
      console.log(`\n👤 Paciente ID: ${patientId} | Valor: R$ ${parseFloat(amount).toFixed(2)} | Ocorrências: ${d.count}`);
      for (const ms of d.items) {
        console.log(`  💰 ${ms._id.toString()} | ${ms.status} | ${ms.paymentMethod} | paidAt: ${ms.paidAt ? new Date(ms.paidAt).toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' }) : '—'} | createdAt: ${new Date(ms.createdAt).toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' })}`);
      }
    }
  }

  // Também detectar settlements do mesmo paciente no mesmo dia com mesmos settledPaymentIds
  const dayGroups = new Map();
  for (const ms of settlements) {
    const patientId = ms.patient?._id?.toString() || 'unknown';
    const day = ms.paidAt
      ? new Date(ms.paidAt).toISOString().split('T')[0]
      : ms.financialDate
        ? new Date(ms.financialDate).toISOString().split('T')[0]
        : ms.createdAt
          ? new Date(ms.createdAt).toISOString().split('T')[0]
          : 'unknown';
    const settledIds = (ms.settledPaymentIds || [])
      .map(id => id.toString())
      .sort()
      .join(',');
    const key = `${patientId}::${day}::${settledIds}`;
    if (!dayGroups.has(key)) dayGroups.set(key, []);
    dayGroups.get(key).push(ms);
  }

  const sameDayDups = [];
  for (const [key, items] of dayGroups.entries()) {
    if (items.length > 1) sameDayDups.push({ key, count: items.length, items });
  }

  console.log('\n══════════════════════════════════════════════════════════');
  console.log('  SETTLEMENTS DUPLICADOS NO MESMO DIA (mesmo paciente + mesmos pagamentos)');
  console.log('══════════════════════════════════════════════════════════');
  console.log(`Grupos com duplicatas no mesmo dia: ${sameDayDups.length}`);

  if (sameDayDups.length === 0) {
    console.log('✅ Nenhum settlement duplicado no mesmo dia encontrado.');
  } else {
    for (const d of sameDayDups) {
      const [patientId, day] = d.key.split('::');
      console.log(`\n👤 Paciente ID: ${patientId} | Dia: ${day} | Ocorrências: ${d.count}`);
      for (const ms of d.items) {
        console.log(`  💰 ${ms._id.toString()} | R$ ${(ms.amount || 0).toFixed(2)} | ${ms.status} | ${ms.paymentMethod} | paidAt: ${ms.paidAt ? new Date(ms.paidAt).toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' }) : '—'} | createdAt: ${new Date(ms.createdAt).toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' })}`);
      }
    }
  }

  const outputPath = path.resolve(__dirname, '../../auditoria-output/auditoria-settlements-duplicados.json');
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, JSON.stringify({
    generatedAt: new Date().toISOString(),
    totalSettlements: settlements.length,
    duplicates: duplicates.map(d => ({
      key: d.key,
      count: d.count,
      items: d.items.map(ms => ({
        id: ms._id.toString(),
        patient: ms.patient?.fullName,
        patientId: ms.patient?._id?.toString(),
        amount: ms.amount,
        status: ms.status,
        paymentMethod: ms.paymentMethod,
        paidAt: ms.paidAt,
        financialDate: ms.financialDate,
        createdAt: ms.createdAt,
        settledPaymentIds: (ms.settledPaymentIds || []).map(id => id.toString())
      }))
    })),
    sameDayDuplicates: sameDayDups.map(d => ({
      key: d.key,
      count: d.count,
      items: d.items.map(ms => ({
        id: ms._id.toString(),
        patient: ms.patient?.fullName,
        patientId: ms.patient?._id?.toString(),
        amount: ms.amount,
        status: ms.status,
        paymentMethod: ms.paymentMethod,
        paidAt: ms.paidAt,
        financialDate: ms.financialDate,
        createdAt: ms.createdAt,
        settledPaymentIds: (ms.settledPaymentIds || []).map(id => id.toString())
      }))
    }))
  }, null, 2));
  console.log(`\n📝 Relatório salvo em: ${outputPath}`);

  await mongoose.disconnect();
}

main().catch(err => { console.error(err); process.exit(1); });
