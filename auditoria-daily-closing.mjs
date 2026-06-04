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

async function main() {
  try {
    await connect();
    const db = mongoose.connection.db;

    console.log('\n========================================');
    console.log('AUDITORIA DAILY CLOSING + SNAPSHOTS');
    console.log('Dias 01, 02 e 03/06/2026');
    console.log('========================================');

    // 1. DailyClosing
    for (const dia of ['2026-06-01', '2026-06-02', '2026-06-03']) {
      const dc = await db.collection('dailyclosings').findOne({ date: dia });
      if (dc) {
        console.log(`\n📅 DailyClosing ${dia}:`);
        console.log(`   totalCash: ${fmtMoney(dc.totalCash)}`);
        console.log(`   totalCard: ${fmtMoney(dc.totalCard)}`);
        console.log(`   totalPix: ${fmtMoney(dc.totalPix)}`);
        console.log(`   totalMoney: ${fmtMoney(dc.totalMoney)}`);
        console.log(`   totalConvenio: ${fmtMoney(dc.totalConvenio)}`);
        console.log(`   totalParticular: ${fmtMoney(dc.totalParticular)}`);
        console.log(`   totalPending: ${fmtMoney(dc.totalPending)}`);
        console.log(`   totalProduction: ${fmtMoney(dc.totalProduction)}`);
        console.log(`   status: ${dc.status || '-'}`);
        console.log(`   closedAt: ${dc.closedAt || '-'}`);
        if (dc.payments && dc.payments.length > 0) {
          console.log(`   payments registrados: ${dc.payments.length}`);
          for (const pid of dc.payments.slice(0, 5)) {
            const p = await db.collection('payments').findOne({ _id: pid });
            if (p) console.log(`      ${fmtMoney(p.amount)} | ${p.status} | ${p.paymentMethod}`);
          }
        }
      } else {
        console.log(`\n📅 DailyClosing ${dia}: NÃO ENCONTRADO`);
      }
    }

    // 2. FinancialDailySnapshot
    for (const dia of ['2026-06-01', '2026-06-02', '2026-06-03']) {
      const snap = await db.collection('financialdailysnapshots').findOne({ date: dia });
      if (snap) {
        console.log(`\n📸 FinancialDailySnapshot ${dia}:`);
        console.log(`   cash.total: ${fmtMoney(snap.cash?.total)}`);
        console.log(`   cash.particular: ${fmtMoney(snap.cash?.particular)}`);
        console.log(`   cash.convenioPacote: ${fmtMoney(snap.cash?.convenioPacote)}`);
        console.log(`   cash.convenioAvulso: ${fmtMoney(snap.cash?.convenioAvulso)}`);
        console.log(`   cash.liminar: ${fmtMoney(snap.cash?.liminar)}`);
        console.log(`   production.total: ${fmtMoney(snap.production?.total)}`);
      } else {
        console.log(`\n📸 FinancialDailySnapshot ${dia}: NÃO ENCONTRADO`);
      }
    }

    // 3. Verificar se há payments com status='paid' e amount>0 que NÃO estão no período 01-03/06 mas que podem ter sido contados no caixa físico
    // Ex: pagamentos do dia 31/05 que foram confirmados no dia 01/06?
    const startJune = moment.tz('2026-06-01T00:00:00', 'America/Sao_Paulo').toDate();
    const endJune3 = moment.tz('2026-06-03T23:59:59.999', 'America/Sao_Paulo').toDate();

    // Pagamentos pagos entre 01-03/06 mas com data original em maio (retroativos)
    const retroativos = await db.collection('payments').find({
      status: 'paid',
      amount: { $gt: 0 },
      $or: [
        { financialDate: { $gte: startJune, $lte: endJune3 } },
        { paidAt: { $gte: startJune, $lte: endJune3 } }
      ],
      paymentDate: { $lt: startJune }
    }).toArray();

    console.log(`\n⏪ RETROATIVOS (confirmados em 01-03/06 mas pagamento original antes):`);
    for (const p of retroativos) {
      console.log(`   payDate:${moment(p.paymentDate).tz('America/Sao_Paulo').format('DD/MM')} finDate:${moment(p.financialDate).tz('America/Sao_Paulo').format('DD/MM')} | ${fmtMoney(p.amount)} | ${p.paymentMethod} | patient:${p.patientId || p.patient}`);
    }

    // 4. Verificar pagamentos do DIA 02/06 especificamente
    const dia02start = moment.tz('2026-06-02T00:00:00', 'America/Sao_Paulo').toDate();
    const dia02end = moment.tz('2026-06-02T23:59:59.999', 'America/Sao_Paulo').toDate();

    const dia02all = await db.collection('payments').find({
      status: 'paid',
      amount: { $gt: 0 },
      $or: [
        { financialDate: { $gte: dia02start, $lte: dia02end } },
        { financialDate: { $exists: false }, paymentDate: { $gte: dia02start, $lte: dia02end } },
        { financialDate: null, paymentDate: { $gte: dia02start, $lte: dia02end } }
      ]
    }).toArray();

    console.log(`\n📅 DIA 02/06 - Todos os pagamentos paid:`);
    for (const p of dia02all) {
      console.log(`   ${fmtMoney(p.amount)} | ${p.paymentMethod} | ${p.billingType} | kind:${p.kind} | patient:${p.patientId || p.patient}`);
    }
    console.log(`   TOTAL dia 02 (sistema): ${fmtMoney(dia02all.reduce((s,p)=>s+p.amount,0))}`);

    // 5. Verificar se há pagamentos PENDENTES em dinheiro do dia 02 que podem explicar a diferença
    const dia02pending = await db.collection('payments').find({
      status: 'pending',
      amount: { $gt: 0 },
      paymentDate: { $gte: dia02start, $lte: dia02end },
      paymentMethod: 'dinheiro'
    }).toArray();

    console.log(`\n📅 DIA 02/06 - Pagamentos pendentes em dinheiro:`);
    for (const p of dia02pending) {
      console.log(`   ${fmtMoney(p.amount)} | ${p.paymentMethod} | patient:${p.patientId || p.patient}`);
    }
    console.log(`   TOTAL pendentes dinheiro dia 02: ${fmtMoney(dia02pending.reduce((s,p)=>s+p.amount,0))}`);

    // 6. Verificar se há payments com billingType 'convenio' no dia 02 que foram pagos (talvez recebido em dinheiro?)
    const dia02convenio = await db.collection('payments').find({
      paymentDate: { $gte: dia02start, $lte: dia02end },
      billingType: 'convenio'
    }).toArray();

    console.log(`\n📅 DIA 02/06 - Todos os pagamentos de convênio:`);
    for (const p of dia02convenio) {
      console.log(`   ${fmtMoney(p.amount)} | status:${p.status} | ins.status:${p.insurance?.status} | ${p.insurance?.provider || '-'} | patient:${p.patientId || p.patient}`);
    }

    // 7. Verificar se há pagamentos com status 'canceled' ou 'refunded' no período que podem ter sido contados no caixa
    const canceled = await db.collection('payments').find({
      status: { $in: ['canceled', 'refunded'] },
      amount: { $gt: 0 },
      paymentDate: { $gte: startJune, $lte: endJune3 }
    }).toArray();

    console.log(`\n❌ Pagamentos CANCELADOS/REFUNDED no período:`);
    for (const p of canceled) {
      console.log(`   ${fmtMoney(p.amount)} | ${p.status} | ${p.paymentMethod} | patient:${p.patientId || p.patient}`);
    }

    // 8. Verificar payments do paciente Isis Caldas Rebelatto nos dias 01-03/06
    const isis = await db.collection('patients').findOne({ fullName: /Isis Caldas Rebelatto/i });
    if (isis) {
      const isisPayments = await db.collection('payments').find({
        patient: isis._id,
        paymentDate: { $gte: startJune, $lte: endJune3 }
      }).toArray();
      console.log(`\n👤 Isis Caldas Rebelatto - todos os payments 01-03/06:`);
      for (const p of isisPayments) {
        console.log(`   ${moment(p.paymentDate).tz('America/Sao_Paulo').format('DD/MM HH:mm')} | ${fmtMoney(p.amount)} | ${p.status} | ${p.paymentMethod} | kind:${p.kind}`);
      }
    }

  } catch (err) {
    console.error('Erro:', err);
  } finally {
    await mongoose.disconnect();
    console.log('\nDesconectado.');
  }
}

main();
