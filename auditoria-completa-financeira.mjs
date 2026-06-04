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

async function getPatientName(db, id) {
  if (!id) return 'Desconhecido';
  const p = await db.collection('patients').findOne({ _id: new mongoose.Types.ObjectId(id.toString()) });
  return p?.fullName || 'Desconhecido';
}

async function analisarDia(db, diaStr) {
  const start = moment.tz(`${diaStr}T00:00:00`, 'America/Sao_Paulo').toDate();
  const end = moment.tz(`${diaStr}T23:59:59.999`, 'America/Sao_Paulo').toDate();

  console.log(`\n========================================`);
  console.log(`📅 ${diaStr}`);
  console.log(`========================================`);

  // ========== 1. CAIXA (payments paid) ==========
  const caixaPayments = await db.collection('payments').find({
    status: 'paid',
    amount: { $gt: 0 },
    $or: [
      { financialDate: { $gte: start, $lte: end } },
      { financialDate: { $exists: false }, paymentDate: { $gte: start, $lte: end } },
      { financialDate: null, paymentDate: { $gte: start, $lte: end } }
    ]
  }).sort({ paymentDate: 1 }).toArray();

  console.log(`\n💵 CAIXA (payments status=PAID): ${caixaPayments.length} pagamentos`);
  let caixaTotal = 0;
  let caixaParticular = 0;
  let caixaLiminar = 0;
  let caixaPacote = 0;
  let caixaPix = 0;
  let caixaDinheiro = 0;
  let caixaCartao = 0;

  for (const p of caixaPayments) {
    caixaTotal += p.amount;
    if (p.billingType === 'liminar' || p.paymentMethod === 'liminar_credit') caixaLiminar += p.amount;
    else if (p.kind === 'package_receipt') caixaPacote += p.amount;
    else { caixaParticular += p.amount; }

    if (p.paymentMethod === 'pix') caixaPix += p.amount;
    else if (p.paymentMethod?.includes('cartao') || p.paymentMethod?.includes('card')) caixaCartao += p.amount;
    else if (p.paymentMethod === 'dinheiro' || p.paymentMethod === 'cash') caixaDinheiro += p.amount;

    const nome = await getPatientName(db, p.patient);
    console.log(`   ${fmtDate(p.paymentDate)} | ${fmtMoney(p.amount)} | ${p.paymentMethod || '-'} | ${p.billingType || 'particular'} | ${nome}`);
  }
  console.log(`   TOTAL CAIXA: ${fmtMoney(caixaTotal)}`);
  console.log(`   → Particular: ${fmtMoney(caixaParticular)} | Liminar: ${fmtMoney(caixaLiminar)} | Pacote: ${fmtMoney(caixaPacote)}`);
  console.log(`   → Pix: ${fmtMoney(caixaPix)} | Dinheiro: ${fmtMoney(caixaDinheiro)} | Cartão: ${fmtMoney(caixaCartao)}`);

  // ========== 2. PRODUÇÃO (sessões completed) ==========
  const sessions = await db.collection('sessions').find({
    date: { $gte: start, $lte: end },
    status: 'completed'
  }).sort({ date: 1 }).toArray();

  console.log(`\n📈 PRODUÇÃO (sessions status=COMPLETED): ${sessions.length} sessões`);
  let producaoTotal = 0;
  let producaoParticular = 0;
  let producaoConvenio = 0;
  let producaoPacote = 0;
  let producaoLiminar = 0;

  for (const s of sessions) {
    // Buscar valor efetivo da sessão
    let valor = s.sessionValue || 0;
    if (s.package) {
      const pkg = await db.collection('packages').findOne({ _id: new mongoose.Types.ObjectId(s.package.toString()) });
      if (pkg?.sessionValue) valor = pkg.sessionValue;
    }

    producaoTotal += valor;

    const isConvenio = s.paymentMethod === 'convenio' || s.paymentOrigin === 'convenio' || s.insuranceGuide;
    const isLiminar = s.paymentMethod === 'liminar_credit' || s.paymentOrigin === 'liminar';
    const isPacote = !!s.package;

    if (isConvenio) producaoConvenio += valor;
    else if (isLiminar) producaoLiminar += valor;
    else if (isPacote) producaoPacote += valor;
    else producaoParticular += valor;

    const nome = await getPatientName(db, s.patientId);
    const tipo = isConvenio ? 'CONVÊNIO' : isLiminar ? 'LIMINAR' : isPacote ? 'PACOTE' : 'PARTICULAR';
    console.log(`   ${fmtDate(s.date)} | ${fmtMoney(valor)} | ${tipo} | ${nome} | isPaid:${s.isPaid || false}`);
  }
  console.log(`   TOTAL PRODUÇÃO: ${fmtMoney(producaoTotal)}`);
  console.log(`   → Particular: ${fmtMoney(producaoParticular)} | Convênio: ${fmtMoney(producaoConvenio)} | Pacote: ${fmtMoney(producaoPacote)} | Liminar: ${fmtMoney(producaoLiminar)}`);

  // ========== 3. CONTAS A RECEBER (payments pending no dia) ==========
  const pendingPayments = await db.collection('payments').find({
    status: 'pending',
    amount: { $gt: 0 },
    paymentDate: { $gte: start, $lte: end }
  }).sort({ paymentDate: 1 }).toArray();

  console.log(`\n🧾 CONTAS A RECEBER (payments status=PENDING no dia): ${pendingPayments.length} pagamentos`);
  let receberTotal = 0;
  let receberParticular = 0;
  let receberConvenio = 0;

  for (const p of pendingPayments) {
    receberTotal += p.amount;
    if (p.billingType === 'convenio' || p.paymentMethod === 'convenio') receberConvenio += p.amount;
    else receberParticular += p.amount;

    const nome = await getPatientName(db, p.patient);
    console.log(`   ${fmtDate(p.paymentDate)} | ${fmtMoney(p.amount)} | ${p.paymentMethod || '-'} | ${p.billingType || 'particular'} | ${nome}`);
  }
  console.log(`   TOTAL A RECEBER: ${fmtMoney(receberTotal)}`);
  console.log(`   → Particular: ${fmtMoney(receberParticular)} | Convênio: ${fmtMoney(receberConvenio)}`);

  // ========== 4. CONVÊNIO DETALHADO (sessões completed + payments pending convenio) ==========
  console.log(`\n🏥 CONVÊNIO DETALHADO:`);
  const convenioSessions = sessions.filter(s => s.paymentMethod === 'convenio' || s.paymentOrigin === 'convenio' || s.insuranceGuide);
  console.log(`   Sessões de convênio realizadas: ${convenioSessions.length}`);
  for (const s of convenioSessions) {
    let valor = s.sessionValue || 0;
    if (s.package) {
      const pkg = await db.collection('packages').findOne({ _id: new mongoose.Types.ObjectId(s.package.toString()) });
      if (pkg?.sessionValue) valor = pkg.sessionValue;
    }
    const nome = await getPatientName(db, s.patientId);
    const pago = s.isPaid ? 'PAGO' : 'PENDENTE';
    console.log(`   ${fmtDate(s.date)} | ${fmtMoney(valor)} | ${pago} | ${nome}`);
  }

  const convenioPaymentsPending = pendingPayments.filter(p => p.billingType === 'convenio' || p.paymentMethod === 'convenio');
  console.log(`   Payments de convênio pendentes: ${convenioPaymentsPending.length}`);
  for (const p of convenioPaymentsPending) {
    const nome = await getPatientName(db, p.patient);
    console.log(`   ${fmtDate(p.paymentDate)} | ${fmtMoney(p.amount)} | ${p.insurance?.provider || 'Convênio'} | ${nome}`);
  }

  // ========== 5. PACOTES ==========
  console.log(`\n📦 PACOTES:`);
  const packageReceipts = caixaPayments.filter(p => p.kind === 'package_receipt');
  console.log(`   Vendas de pacote (entraram no caixa): ${packageReceipts.length}`);
  for (const p of packageReceipts) {
    const nome = await getPatientName(db, p.patient);
    console.log(`   ${fmtDate(p.paymentDate)} | ${fmtMoney(p.amount)} | ${nome}`);
  }

  const pacoteSessions = sessions.filter(s => !!s.package && s.paymentMethod !== 'convenio' && s.paymentOrigin !== 'convenio');
  console.log(`   Sessões de pacote realizadas: ${pacoteSessions.length}`);
  for (const s of pacoteSessions) {
    let valor = s.sessionValue || 0;
    const pkg = s.package ? await db.collection('packages').findOne({ _id: new mongoose.Types.ObjectId(s.package.toString()) }) : null;
    if (pkg?.sessionValue) valor = pkg.sessionValue;
    const nome = await getPatientName(db, s.patientId);
    console.log(`   ${fmtDate(s.date)} | ${fmtMoney(valor)} | ${nome} | isPaid:${s.isPaid || false}`);
  }

  // ========== RESUMO DO DIA ==========
  console.log(`\n📊 RESUMO ${diaStr}:`);
  console.log(`   CAIXA (recebido):        ${fmtMoney(caixaTotal)}`);
  console.log(`   PRODUÇÃO (realizado):    ${fmtMoney(producaoTotal)}`);
  console.log(`   A RECEBER (pendente):    ${fmtMoney(receberTotal)}`);
  console.log(`   → Se produziu ${fmtMoney(producaoTotal)} e recebeu ${fmtMoney(caixaTotal)},`);
  console.log(`     faltam receber: ${fmtMoney(producaoTotal - caixaTotal)} (deve bater com pendente + convênio não recebido)`);
}

async function main() {
  try {
    await connect();
    const db = mongoose.connection.db;

    console.log('\n🔍 AUDITORIA FINANCEIRA COMPLETA');
    console.log('CAIXA ≠ PRODUÇÃO ≠ CONTAS A RECEBER');
    console.log('Período: 01, 02 e 03/06/2026');

    for (const dia of ['2026-06-01', '2026-06-02', '2026-06-03']) {
      await analisarDia(db, dia);
    }

    // Resumo geral dos 3 dias
    console.log('\n========================================');
    console.log('📊 RESUMO GERAL DOS 3 DIAS');
    console.log('========================================');

    const start = moment.tz('2026-06-01T00:00:00', 'America/Sao_Paulo').toDate();
    const end = moment.tz('2026-06-03T23:59:59.999', 'America/Sao_Paulo').toDate();

    const totalCaixa = await db.collection('payments').aggregate([
      { $match: { status: 'paid', amount: { $gt: 0 }, $or: [
        { financialDate: { $gte: start, $lte: end } },
        { financialDate: { $exists: false }, paymentDate: { $gte: start, $lte: end } },
        { financialDate: null, paymentDate: { $gte: start, $lte: end } }
      ]}},
      { $group: { _id: null, total: { $sum: '$amount' } } }
    ]).toArray();

    const totalProducao = await db.collection('sessions').aggregate([
      { $match: { date: { $gte: start, $lte: end }, status: 'completed' } },
      { $group: { _id: null, total: { $sum: '$sessionValue' } } }
    ]).toArray();

    const totalReceber = await db.collection('payments').aggregate([
      { $match: { status: 'pending', amount: { $gt: 0 }, paymentDate: { $gte: start, $lte: end } } },
      { $group: { _id: null, total: { $sum: '$amount' } } }
    ]).toArray();

    console.log(`   CAIXA TOTAL (recebido):     ${fmtMoney(totalCaixa[0]?.total || 0)}`);
    console.log(`   PRODUÇÃO TOTAL (sessões):   ${fmtMoney(totalProducao[0]?.total || 0)}`);
    console.log(`   A RECEBER TOTAL (pending):  ${fmtMoney(totalReceber[0]?.total || 0)}`);

  } catch (err) {
    console.error('Erro:', err);
  } finally {
    await mongoose.disconnect();
    console.log('\nDesconectado.');
  }
}

main();
