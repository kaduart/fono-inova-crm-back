import mongoose from 'mongoose';
import moment from 'moment-timezone';

const MONGO_URI = 'mongodb+srv://kaduart:%40Soundcar10@cluster0.g2c3sdk.mongodb.net/fono_inova_prod?retryWrites=true&w=majority&appName=Cluster0';

async function connect() {
  await mongoose.connect(MONGO_URI);
  console.log('Conectado ao MongoDB');
}

function fmtMoney(v) {
  return `R$ ${(v || 0).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function fmtDate(d) {
  if (!d) return '-';
  return moment(d).tz('America/Sao_Paulo').format('DD/MM/YYYY HH:mm');
}

async function main() {
  try {
    await connect();
    const db = mongoose.connection.db;

    const start = moment.tz('2026-06-01T00:00:00', 'America/Sao_Paulo').toDate();
    const end = moment.tz('2026-06-03T23:59:59.999', 'America/Sao_Paulo').toDate();

    console.log('\n========================================');
    console.log('AUDITORIA CAIXA 01-03/06/2026');
    console.log('========================================');

    // 1. TODOS os payments paid no período por paymentDate
    const byPaymentDate = await db.collection('payments').find({
      status: 'paid',
      amount: { $gt: 0 },
      paymentDate: { $gte: start, $lte: end }
    }).sort({ paymentDate: 1 }).toArray();

    console.log(`\n1. Payments PAID com paymentDate entre 01-03/06: ${byPaymentDate.length} registros`);
    let totalPaymentDate = 0;
    for (const p of byPaymentDate) {
      totalPaymentDate += p.amount;
      console.log(`  ${fmtDate(p.paymentDate)} | ${fmtMoney(p.amount)} | ${p.billingType || '-'} | ${p.paymentMethod || '-'} | kind:${p.kind || '-'} | isFromPackage:${p.isFromPackage} | financialDate:${fmtDate(p.financialDate)} | patient:${p.patientId || p.patient}`);
    }
    console.log(`  TOTAL por paymentDate: ${fmtMoney(totalPaymentDate)}`);

    // 2. TODOS os payments paid no período por financialDate
    const byFinancialDate = await db.collection('payments').find({
      status: 'paid',
      amount: { $gt: 0 },
      financialDate: { $gte: start, $lte: end }
    }).sort({ financialDate: 1 }).toArray();

    console.log(`\n2. Payments PAID com financialDate entre 01-03/06: ${byFinancialDate.length} registros`);
    let totalFinancialDate = 0;
    for (const p of byFinancialDate) {
      totalFinancialDate += p.amount;
      console.log(`  fin:${fmtDate(p.financialDate)} pay:${fmtDate(p.paymentDate)} | ${fmtMoney(p.amount)} | ${p.billingType || '-'} | ${p.paymentMethod || '-'} | kind:${p.kind || '-'} | isFromPackage:${p.isFromPackage}`);
    }
    console.log(`  TOTAL por financialDate: ${fmtMoney(totalFinancialDate)}`);

    // 3. Payments paid com createdAt no período mas paymentDate/financialDate fora
    const byCreatedAt = await db.collection('payments').find({
      status: 'paid',
      amount: { $gt: 0 },
      createdAt: { $gte: start, $lte: end },
      $or: [
        { paymentDate: { $lt: start } },
        { paymentDate: { $gt: end } },
        { paymentDate: { $exists: false } },
        { paymentDate: null }
      ],
      $or: [
        { financialDate: { $lt: start } },
        { financialDate: { $gt: end } },
        { financialDate: { $exists: false } },
        { financialDate: null }
      ]
    }).sort({ createdAt: 1 }).toArray();

    console.log(`\n3. Payments PAID criados entre 01-03/06 mas com paymentDate/financialDate FORA do período: ${byCreatedAt.length} registros`);
    for (const p of byCreatedAt) {
      console.log(`  criado:${fmtDate(p.createdAt)} pay:${fmtDate(p.paymentDate)} fin:${fmtDate(p.financialDate)} | ${fmtMoney(p.amount)} | ${p.billingType || '-'} | ${p.paymentMethod || '-'} | kind:${p.kind || '-'} | isFromPackage:${p.isFromPackage}`);
    }

    // 4. A query EXATA do unifiedFinancialService.calculateCash
    const matchUnified = {
      status: 'paid',
      amount: { $gt: 0 },
      kind: { $ne: 'package_consumed' },
      $and: [
        {
          $or: [
            { isFromPackage: { $ne: true } },
            { kind: 'session_payment' }
          ]
        },
        {
          $or: [
            { financialDate: { $gte: start, $lte: end } },
            { financialDate: { $exists: false }, paymentDate: { $gte: start, $lte: end } },
            { financialDate: null, paymentDate: { $gte: start, $lte: end } },
            { financialDate: { $exists: false }, paymentDate: { $exists: false }, createdAt: { $gte: start, $lte: end } },
            { financialDate: null, paymentDate: null, createdAt: { $gte: start, $lte: end } }
          ]
        }
      ]
    };

    const unifiedResults = await db.collection('payments').find(matchUnified).sort({ financialDate: 1, paymentDate: 1 }).toArray();
    console.log(`\n4. Query UNIFICADA (calculateCash) entre 01-03/06: ${unifiedResults.length} registros`);
    let totalUnified = 0;
    for (const p of unifiedResults) {
      totalUnified += p.amount;
      console.log(`  fin:${fmtDate(p.financialDate)} pay:${fmtDate(p.paymentDate)} | ${fmtMoney(p.amount)} | ${p.billingType || '-'} | ${p.paymentMethod || '-'} | kind:${p.kind || '-'} | isFromPackage:${p.isFromPackage}`);
    }
    console.log(`  TOTAL UNIFICADO: ${fmtMoney(totalUnified)}`);

    // 5. Quais payments paid do período foram EXCLUÍDOS pela query unificada?
    const unifiedIds = new Set(unifiedResults.map(p => p._id.toString()));
    const excluidos = byPaymentDate.filter(p => !unifiedIds.has(p._id.toString()));
    console.log(`\n5. Payments EXCLUÍDOS pela query unificada (status=paid, paymentDate no período): ${excluidos.length}`);
    for (const p of excluidos) {
      console.log(`  pay:${fmtDate(p.paymentDate)} fin:${fmtDate(p.financialDate)} | ${fmtMoney(p.amount)} | ${p.billingType || '-'} | ${p.paymentMethod || '-'} | kind:${p.kind || '-'} | isFromPackage:${p.isFromPackage}`);
    }

    // 6. Por dia usando a lógica do calculateCashByDay
    const aggByDay = await db.collection('payments').aggregate([
      { $match: matchUnified },
      { $group: {
        _id: { $dateToString: { format: '%Y-%m-%d', date: { $ifNull: ['$financialDate', '$paymentDate'] }, timezone: 'America/Sao_Paulo' } },
        caixa: { $sum: '$amount' },
        transacoes: { $sum: 1 }
      }}
    ]).toArray();

    console.log(`\n6. Caixa por dia (usando $ifNull[financialDate, paymentDate]):`);
    for (const r of aggByDay.sort((a,b) => a._id.localeCompare(b._id))) {
      console.log(`  ${r._id}: ${fmtMoney(r.caixa)} (${r.transacoes} transações)`);
    }

    // 7. Por dia usando paymentDate
    const aggByDayPayment = await db.collection('payments').aggregate([
      { $match: { status: 'paid', amount: { $gt: 0 }, paymentDate: { $gte: start, $lte: end } } },
      { $group: {
        _id: { $dateToString: { format: '%Y-%m-%d', date: '$paymentDate', timezone: 'America/Sao_Paulo' } },
        caixa: { $sum: '$amount' },
        transacoes: { $sum: 1 }
      }}
    ]).toArray();

    console.log(`\n7. Caixa por dia (usando paymentDate):`);
    for (const r of aggByDayPayment.sort((a,b) => a._id.localeCompare(b._id))) {
      console.log(`  ${r._id}: ${fmtMoney(r.caixa)} (${r.transacoes} transações)`);
    }

    // 8. Verificar se há payments com billingType='particular' e status='paid' mas que não entram no caixa
    console.log(`\n8. Verificação de inconsistências:`);
    const particularPaid = await db.collection('payments').find({
      status: 'paid',
      billingType: 'particular',
      paymentDate: { $gte: start, $lte: end }
    }).toArray();
    console.log(`  Particular paid no período (por paymentDate): ${particularPaid.length} pagamentos, total ${fmtMoney(particularPaid.reduce((s,p)=>s+p.amount,0))}`);

    const packageReceipts = await db.collection('payments').find({
      status: 'paid',
      kind: 'package_receipt',
      paymentDate: { $gte: start, $lte: end }
    }).toArray();
    console.log(`  Vendas de pacote (package_receipt) no período: ${packageReceipts.length} pagamentos, total ${fmtMoney(packageReceipts.reduce((s,p)=>s+p.amount,0))}`);

    // 9. Sessões completed no período para ver produção
    const sessions = await db.collection('sessions').find({
      date: { $gte: start, $lte: end },
      status: 'completed'
    }).toArray();
    console.log(`\n9. Sessões COMPLETED no período: ${sessions.length}`);

    // 10. Buscar pacotes vendidos no período
    const packages = await db.collection('packages').find({
      createdAt: { $gte: start, $lte: end }
    }).toArray();
    console.log(`  Pacotes criados no período: ${packages.length}`);

  } catch (err) {
    console.error('Erro:', err);
  } finally {
    await mongoose.disconnect();
    console.log('\nDesconectado.');
  }
}

main();
