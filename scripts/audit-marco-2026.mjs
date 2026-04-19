/**
 * Diagnóstico financeiro de março 2026
 * Compara sessões realizadas vs pagamentos registrados
 * Uso: node back/scripts/audit-marco-2026.mjs
 */

import mongoose from 'mongoose';
import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: join(__dirname, '../../back/.env') });

const INICIO = '2026-03-01';
const FIM    = '2026-03-31';
const inicioDate = new Date('2026-03-01T00:00:00.000-03:00');
const fimDate    = new Date('2026-03-31T23:59:59.999-03:00');

await mongoose.connect(process.env.MONGO_URI);
console.log('✅ Conectado ao MongoDB\n');

const { default: Appointment } = await import('../models/Appointment.js');
const { default: Payment }     = await import('../models/Payment.js');
const { default: Session }     = await import('../models/Session.js');

// ─── 1. Sessões realizadas (Appointment) ────────────────────────────────────
const appts = await Appointment.find({
  date: { $gte: INICIO, $lte: FIM },
  operationalStatus: { $in: ['completed', 'confirmed'] },
}).populate('patient', 'fullName').lean();

const totalProducao = appts.reduce((s, a) => s + (a.sessionValue || 0), 0);
const pagas   = appts.filter(a => ['paid','package_paid'].includes(a.paymentStatus));
const pendentes = appts.filter(a => !['paid','package_paid'].includes(a.paymentStatus));

console.log('═══════════════════════════════════════');
console.log('📊 SESSÕES (Appointment) — março 2026');
console.log('═══════════════════════════════════════');
console.log(`Total de sessões realizadas: ${appts.length}`);
console.log(`Valor total produção:        R$ ${totalProducao.toFixed(2)}`);
console.log(`  ✅ Pagas (paymentStatus=paid): ${pagas.length} — R$ ${pagas.reduce((s,a)=>s+(a.sessionValue||0),0).toFixed(2)}`);
console.log(`  ⏳ Pendentes:                 ${pendentes.length} — R$ ${pendentes.reduce((s,a)=>s+(a.sessionValue||0),0).toFixed(2)}`);

// ─── 2. Payments registrados ─────────────────────────────────────────────────
const payments = await Payment.find({
  paymentDate: { $gte: INICIO, $lte: FIM },
  status: 'paid',
}).lean();

const totalCaixaPayments = payments.reduce((s, p) => s + (p.amount || 0), 0);
console.log('\n═══════════════════════════════════════');
console.log('💳 PAYMENTS registrados — março 2026');
console.log('═══════════════════════════════════════');
console.log(`Total payments paid:   ${payments.length}`);
console.log(`Valor total:           R$ ${totalCaixaPayments.toFixed(2)}`);

// Detalhe por tipo
const particular = payments.filter(p => p.billingType === 'particular');
const convenio   = payments.filter(p => p.billingType === 'convenio');
console.log(`  Particular: ${particular.length} — R$ ${particular.reduce((s,p)=>s+(p.amount||0),0).toFixed(2)}`);
console.log(`  Convênio:   ${convenio.length} — R$ ${convenio.reduce((s,p)=>s+(p.amount||0),0).toFixed(2)}`);

// Payments com paymentDate nulo/ausente (prováveis perdidos)
const paymentsSeData = await Payment.find({
  createdAt: { $gte: inicioDate, $lte: fimDate },
  status: 'paid',
  $or: [{ paymentDate: null }, { paymentDate: { $exists: false } }]
}).lean();
if (paymentsSeData.length > 0) {
  console.log(`\n⚠️  ATENÇÃO: ${paymentsSeData.length} payments PAID sem paymentDate (não entram no caixa!)`);
  console.log(`   Valor: R$ ${paymentsSeData.reduce((s,p)=>s+(p.amount||0),0).toFixed(2)}`);
}

// ─── 3. Sessões pendentes por paciente ──────────────────────────────────────
console.log('\n═══════════════════════════════════════');
console.log('⏳ PENDENTES — por paciente');
console.log('═══════════════════════════════════════');
const agrupado = {};
for (const a of pendentes) {
  const nome = a.patient?.fullName || a.patientName || a.patientInfo?.fullName || 'Desconhecido';
  if (!agrupado[nome]) agrupado[nome] = { count: 0, valor: 0, status: [] };
  agrupado[nome].count++;
  agrupado[nome].valor += a.sessionValue || 0;
  agrupado[nome].status.push(a.paymentStatus || 'sem_status');
}
const linhas = Object.entries(agrupado).sort((a,b) => b[1].valor - a[1].valor);
for (const [nome, d] of linhas) {
  const statuses = [...new Set(d.status)].join(', ');
  console.log(`  ${nome}: ${d.count} sessões — R$ ${d.valor.toFixed(2)} [${statuses}]`);
}

// ─── 4. Gap ──────────────────────────────────────────────────────────────────
const gap = totalProducao - totalCaixaPayments;
console.log('\n═══════════════════════════════════════');
console.log('📉 RESUMO DO GAP');
console.log('═══════════════════════════════════════');
console.log(`Produção total:    R$ ${totalProducao.toFixed(2)}`);
console.log(`Caixa (payments):  R$ ${totalCaixaPayments.toFixed(2)}`);
console.log(`GAP não registrado: R$ ${gap.toFixed(2)}`);
console.log(`\n→ Verifique: ${pendentes.length} sessões pendentes devem ser pagas ou marcadas como "a prazo"`);

await mongoose.disconnect();
