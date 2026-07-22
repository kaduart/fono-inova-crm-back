#!/usr/bin/env node
/**
 * Auditoria READ-ONLY: atendimentos particulares AVULSOS ou PER-SESSION
 * (completed + paid) SEM Payment vinculado.
 *
 * Exclui de propósito:
 *  - Pacotes prepaid/full (Payment NÃO é criado por design — dinheiro já entrou na compra)
 *  - billingType convenio/liminar (fluxos próprios, fora de escopo desta investigação)
 *
 * Não corrige nada — só lista e soma. Correção é sempre manual/pontual.
 *
 * Uso:
 *   node scripts/audit-paid-without-payment.js [diasParaTras]
 */

import mongoose from 'mongoose';
import moment from 'moment-timezone';
import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

dotenv.config({ path: join(__dirname, '../.env') });
dotenv.config();

import Payment from '../models/Payment.js';
import Appointment from '../models/Appointment.js';
import Package from '../models/Package.js';

const daysBack = parseInt(process.argv[2] || '180', 10);

async function audit() {
  console.log(`\n🔍 Auditoria: particular avulso/per-session completed+paid SEM Payment (últimos ${daysBack} dias)`);
  console.log('='.repeat(80));

  const mongoUri = process.env.MONGODB_URI || process.env.MONGO_URI;
  if (!mongoUri) {
    console.error('❌ MONGODB_URI/MONGO_URI não encontrado no .env');
    process.exit(1);
  }

  await mongoose.connect(mongoUri);
  console.log('✅ Conectado ao MongoDB\n');

  const since = moment().subtract(daysBack, 'days').toDate();

  const appts = await Appointment.find({
    billingType: 'particular',
    operationalStatus: 'completed',
    paymentStatus: 'paid',
    date: { $gte: since }
  })
    .select('_id patientName sessionValue paymentAmount paymentMethod date time payment package session serviceName type')
    .populate('patient', 'fullName')
    .lean();

  console.log(`Total appointments particular/completed/paid no período: ${appts.length}`);

  // Resolve packages prepaid/full para excluir do escopo (Payment não criado por design)
  const packageIds = appts.map(a => a.package).filter(Boolean);
  const packages = await Package.find({ _id: { $in: packageIds } }).select('_id model paymentType').lean();
  const prepaidPackageIds = new Set(
    packages.filter(p => p.model === 'prepaid' || p.paymentType === 'full').map(p => p._id.toString())
  );

  const inScope = appts.filter(a => {
    if (!a.package) return true; // avulso puro, sem pacote — sempre no escopo
    return !prepaidPackageIds.has(a.package.toString()); // per-session package entra; prepaid/full sai
  });

  console.log(`Fora de escopo (pacote prepaid/full, Payment não criado por design): ${appts.length - inScope.length}`);
  console.log(`Em escopo (avulso puro + per-session package): ${inScope.length}\n`);

  const apptIds = inScope.map(a => a._id);
  const payments = await Payment.find({
    $or: [
      { appointment: { $in: apptIds } },
      { appointmentId: { $in: apptIds.map(id => id.toString()) } }
    ]
  }).select('appointment appointmentId status').lean();

  const paidApptIds = new Set([
    ...payments.filter(p => p.status === 'paid').map(p => p.appointment?.toString()).filter(Boolean),
    ...payments.filter(p => p.status === 'paid').map(p => p.appointmentId).filter(Boolean)
  ]);

  const gaps = inScope.filter(a => !a.payment && !paidApptIds.has(a._id.toString()));

  console.log(`📊 RESULTADO: ${gaps.length} casos de particular avulso/per-session completed+paid SEM Payment\n`);

  const sum = gaps.reduce((s, x) => s + (x.sessionValue || x.paymentAmount || 0), 0);
  const byType = {};
  for (const a of gaps) {
    const key = a.type || a.serviceName || 'desconhecido';
    byType[key] = (byType[key] || 0) + 1;
  }
  console.log('Por tipo de atendimento:', JSON.stringify(byType, null, 2));
  console.log(`Soma sessionValue/paymentAmount: R$ ${sum.toFixed(2)}\n`);

  console.log('Casos (mais recentes primeiro):');
  gaps
    .sort((a, b) => new Date(b.date) - new Date(a.date))
    .forEach(a => {
      console.log(`   - ${moment(a.date).format('YYYY-MM-DD')} ${a.time || ''} | ${a.patient?.fullName || a.patientName || '?'} | tipo=${a.type || a.serviceName || '-'} | R$${a.sessionValue || a.paymentAmount || 0} | método=${a.paymentMethod} | pacote=${a.package ? 'per-session' : 'não'} | appointmentId=${a._id}`);
    });

  console.log(`\n${'='.repeat(80)}`);
  console.log(`TOTAL: ${gaps.length} casos | R$ ${sum.toFixed(2)}`);
  console.log('(Apenas leitura — nenhum dado foi alterado.)');

  await mongoose.disconnect();
}

audit().catch(err => {
  console.error('Erro:', err);
  process.exit(1);
});
