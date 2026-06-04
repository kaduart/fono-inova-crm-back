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
    console.log('AUDITORIA: CAIXA FÍSICO vs SISTEMA');
    console.log('Período: 01-03/06/2026');
    console.log('Você disse que contou R$ 5.303 no caixa físico');
    console.log('O sistema (dashboard) mostra R$ 3.970');
    console.log('Diferença: R$ 1.333');
    console.log('========================================');

    // 1. Todos os payments PAID no período (já sabemos que dá 3.970)
    const paidPayments = await db.collection('payments').find({
      status: 'paid',
      amount: { $gt: 0 },
      $or: [
        { financialDate: { $gte: start, $lte: end } },
        { financialDate: { $exists: false }, paymentDate: { $gte: start, $lte: end } },
        { financialDate: null, paymentDate: { $gte: start, $lte: end } }
      ]
    }).toArray();

    // 2. Payments PENDING com dinheiro/pix/cartao NOS DIAS 01-03/06 (pode ter entrado no caixa físico mas não foi confirmado no sistema)
    const pendingMoney = await db.collection('payments').find({
      status: 'pending',
      amount: { $gt: 0 },
      paymentDate: { $gte: start, $lte: end },
      paymentMethod: { $in: ['dinheiro', 'pix', 'cartao_credito', 'cartao_debito', 'cash'] }
    }).sort({ paymentDate: 1 }).toArray();

    console.log(`\n🚨 PAYMENTS PENDENTES que podem ter entrado no caixa físico:`);
    console.log(`   (status=pending + paymentMethod em dinheiro/pix/cartão nos dias 01-03/06)`);
    let pendingTotal = 0;
    for (const p of pendingMoney) {
      pendingTotal += p.amount;
      console.log(`   ${fmtDate(p.paymentDate)} | ${fmtMoney(p.amount)} | ${p.paymentMethod || '-'} | ${p.billingType || '-'} | kind:${p.kind || '-'} | patient:${p.patientId || p.patient}`);
    }
    console.log(`   TOTAL pendente em dinheiro/pix/cartão: ${fmtMoney(pendingTotal)}`);

    // 3. Payments com status 'partial' no período
    const partialPayments = await db.collection('payments').find({
      status: 'partial',
      amount: { $gt: 0 },
      paymentDate: { $gte: start, $lte: end }
    }).sort({ paymentDate: 1 }).toArray();

    console.log(`\n🚨 PAYMENTS com status=PARTIAL no período:`);
    let partialTotal = 0;
    for (const p of partialPayments) {
      partialTotal += p.amount;
      console.log(`   ${fmtDate(p.paymentDate)} | ${fmtMoney(p.amount)} | ${p.paymentMethod || '-'} | ${p.billingType || '-'} | patient:${p.patientId || p.patient}`);
    }
    console.log(`   TOTAL partial: ${fmtMoney(partialTotal)}`);

    // 4. FinancialLedger (movimentações manuais de caixa) nos dias 01-03/06
    const ledgerEntries = await db.collection('financialledgers').find({
      date: { $gte: start, $lte: end }
    }).sort({ date: 1 }).toArray();

    console.log(`\n📒 FINANCIAL LEDGER (movimentações manuais) no período:`);
    let ledgerTotal = 0;
    for (const l of ledgerEntries) {
      const valor = l.type === 'income' ? (l.amount || 0) : -(l.amount || 0);
      ledgerTotal += valor;
      console.log(`   ${fmtDate(l.date)} | ${l.type || '-'} | ${fmtMoney(valor)} | ${l.description || '-'} | category:${l.category || '-'}`);
    }
    console.log(`   TOTAL ledger: ${fmtMoney(ledgerTotal)}`);

    // 5. Pagamentos de convênio com status 'received' nos dias 01-03/06
    const convenioReceived = await db.collection('payments').find({
      billingType: 'convenio',
      'insurance.status': 'received',
      'insurance.receivedAt': { $gte: start, $lte: end }
    }).sort({ 'insurance.receivedAt': 1 }).toArray();

    console.log(`\n🏥 CONVÊNIOS RECEBIDOS no período:`);
    let convenioTotal = 0;
    for (const p of convenioReceived) {
      const val = p.insurance?.receivedAmount || p.amount || 0;
      convenioTotal += val;
      console.log(`   ${fmtDate(p.insurance?.receivedAt)} | ${fmtMoney(val)} | ${p.insurance?.provider || '-'} | patient:${p.patientId || p.patient}`);
    }
    console.log(`   TOTAL convênio recebido: ${fmtMoney(convenioTotal)}`);

    // 6. Verificar se há pagamentos com paidAt nos dias 01-03/06 mas paymentDate/financialDate em outro dia
    const paidAtWindow = await db.collection('payments').find({
      status: 'paid',
      amount: { $gt: 0 },
      paidAt: { $gte: start, $lte: end },
      $and: [
        { $or: [
          { financialDate: { $lt: start } },
          { financialDate: { $gt: end } },
          { financialDate: { $exists: false } }
        ]},
        { $or: [
          { paymentDate: { $lt: start } },
          { paymentDate: { $gt: end } },
          { paymentDate: { $exists: false } }
        ]}
      ]
    }).toArray();

    console.log(`\n🔍 Pagamentos CONFIRMADOS (paidAt) nos dias 01-03/06 mas com paymentDate/financialDate FORA:`);
    for (const p of paidAtWindow) {
      console.log(`   paidAt:${fmtDate(p.paidAt)} pay:${fmtDate(p.paymentDate)} fin:${fmtDate(p.financialDate)} | ${fmtMoney(p.amount)} | ${p.paymentMethod || '-'} | patient:${p.patientId || p.patient}`);
    }

    // 7. Verificar se há pagamentos nos dias 01-03/06 que NÃO têm kind='session_payment' ou 'package_receipt'
    const otherKinds = await db.collection('payments').find({
      status: 'paid',
      amount: { $gt: 0 },
      paymentDate: { $gte: start, $lte: end },
      kind: { $nin: ['session_payment', 'package_receipt', null] }
    }).toArray();

    console.log(`\n📦 Outros tipos (kind) de pagamentos no período:`);
    for (const p of otherKinds) {
      console.log(`   ${fmtDate(p.paymentDate)} | ${fmtMoney(p.amount)} | kind:${p.kind} | ${p.paymentMethod || '-'} | patient:${p.patientId || p.patient}`);
    }

    // 8. Verificar se há retroativos - pagamentos com paymentDate antes de 01/06 mas que foram recebidos nos dias 01-03/06
    const retroativos = await db.collection('payments').find({
      status: 'paid',
      amount: { $gt: 0 },
      paymentDate: { $lt: start },
      $or: [
        { financialDate: { $gte: start, $lte: end } },
        { paidAt: { $gte: start, $lte: end } }
      ]
    }).toArray();

    console.log(`\n⏪ RETROATIVOS (pagamentos de datas anteriores confirmados nos dias 01-03/06):`);
    let retroTotal = 0;
    for (const p of retroativos) {
      retroTotal += p.amount;
      console.log(`   original:${fmtDate(p.paymentDate)} confirmado:${fmtDate(p.financialDate || p.paidAt)} | ${fmtMoney(p.amount)} | ${p.paymentMethod || '-'} | patient:${p.patientId || p.patient}`);
    }
    console.log(`   TOTAL retroativos: ${fmtMoney(retroTotal)}`);

    // 9. Tentar identificar: somando paid + pending + partial no período, chega perto de 5.303?
    const tudo = paidPayments.reduce((s,p)=>s+p.amount,0) + pendingTotal + partialTotal + ledgerTotal + retroTotal;
    console.log(`\n========================================`);
    console.log(`RESUMO DA ANÁLISE:`);
    console.log(`========================================`);
    console.log(`Caixa sistema (paid no período):        ${fmtMoney(paidPayments.reduce((s,p)=>s+p.amount,0))}`);
    console.log(`+ Pendente em dinheiro/pix/cartão:      ${fmtMoney(pendingTotal)}`);
    console.log(`+ Partial no período:                   ${fmtMoney(partialTotal)}`);
    console.log(`+ Financial Ledger:                     ${fmtMoney(ledgerTotal)}`);
    console.log(`+ Retroativos confirmados no período:   ${fmtMoney(retroTotal)}`);
    console.log(`+ Convênio recebido no período:         ${fmtMoney(convenioTotal)}`);
    console.log(`────────────────────────────────────────`);
    console.log(`TOTAL POSSÍVEL (se tudo entrou no caixa): ${fmtMoney(tudo)}`);
    console.log(`\nVocê disse que contou no caixa físico:    R$ 5.303,00`);
    console.log(`Diferença ainda não explicada:            ${fmtMoney(5303 - tudo)}`);

  } catch (err) {
    console.error('Erro:', err);
  } finally {
    await mongoose.disconnect();
    console.log('\nDesconectado.');
  }
}

main();
