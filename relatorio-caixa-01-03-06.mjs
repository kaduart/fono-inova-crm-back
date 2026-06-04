import mongoose from 'mongoose';
import moment from 'moment-timezone';

const MONGO_URI = 'mongodb+srv://kaduart:%40Soundcar10@cluster0.g2c3sdk.mongodb.net/fono_inova_prod?retryWrites=true&w=majority&appName=Cluster0';

async function connect() {
  await mongoose.connect(MONGO_URI);
  console.log('Conectado ao MongoDB');
}

function getRange(dia) {
  const start = moment.tz(`2026-06-${String(dia).padStart(2, '0')}T00:00:00`, 'America/Sao_Paulo').toDate();
  const end = moment.tz(`2026-06-${String(dia).padStart(2, '0')}T23:59:59.999`, 'America/Sao_Paulo').toDate();
  return { start, end };
}

async function getCaixaDoDia(dia) {
  const { start, end } = getRange(dia);

  // Busca pagamentos particulares pagos no dia (dinheiro que entrou)
  const particular = await mongoose.connection.db.collection('payments').find({
    billingType: 'particular',
    status: 'paid',
    paymentDate: { $gte: start, $lte: end },
    kind: { $ne: 'package_consumed' }
  }).sort({ paymentDate: 1 }).toArray();

  // Busca convênios recebidos no dia
  const convenioRecebido = await mongoose.connection.db.collection('payments').find({
    billingType: 'convenio',
    'insurance.status': 'received',
    'insurance.receivedAt': { $gte: start, $lte: end }
  }).sort({ 'insurance.receivedAt': 1 }).toArray();

  // Busca pagamentos pendentes do dia (particular ou convenio pendente)
  const pendentes = await mongoose.connection.db.collection('payments').find({
    $or: [
      { billingType: 'particular', status: 'pending', paymentDate: { $gte: start, $lte: end }, kind: { $ne: 'package_consumed' } },
      { billingType: 'convenio', status: 'pending', paymentDate: { $gte: start, $lte: end }, kind: { $ne: 'package_consumed' } }
    ]
  }).sort({ paymentDate: 1 }).toArray();

  // Busca convênios com status pending/billed (não recebidos) daquele dia
  const convenioPendente = await mongoose.connection.db.collection('payments').find({
    billingType: 'convenio',
    'insurance.status': { $in: ['pending', 'pending_billing', 'billed'] },
    paymentDate: { $gte: start, $lte: end },
    kind: { $ne: 'package_consumed' }
  }).sort({ paymentDate: 1 }).toArray();

  // Busca pacientes para nomes
  const patientIds = [...new Set([
    ...particular.map(p => p.patient?.toString()),
    ...convenioRecebido.map(p => p.patient?.toString()),
    ...pendentes.map(p => p.patient?.toString()),
    ...convenioPendente.map(p => p.patient?.toString())
  ].filter(Boolean))];

  const patients = await mongoose.connection.db.collection('patients').find({
    _id: { $in: patientIds.map(id => new mongoose.Types.ObjectId(id)) }
  }).toArray();

  const patientMap = Object.fromEntries(patients.map(p => [p._id.toString(), p.fullName]));

  function fmtMoney(v) {
    return `R$ ${(v || 0).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  }

  function fmtDate(d) {
    if (!d) return '-';
    return moment(d).tz('America/Sao_Paulo').format('DD/MM/YYYY HH:mm');
  }

  function printPayment(p, label) {
    const nome = patientMap[p.patient?.toString()] || 'Desconhecido';
    const metodo = p.paymentMethod || '-';
    const amount = p.billingType === 'convenio' && p.insurance?.receivedAmount
      ? p.insurance.receivedAmount
      : p.amount;
    console.log(`  [${label}] ${nome} | ${fmtMoney(amount)} | ${metodo} | ${fmtDate(p.paymentDate)} | status: ${p.status}${p.insurance?.status ? `/ins:${p.insurance.status}` : ''}`);
    if (p.notes) console.log(`      obs: ${p.notes}`);
  }

  console.log(`\n========================================`);
  console.log(`CAIXA DO DIA 0${dia}/06/2026`);
  console.log(`========================================`);

  // PARTICULAR
  const totalParticular = particular.reduce((s, p) => s + (p.amount || 0), 0);
  console.log(`\n💵 ENTRADA PARTICULAR: ${fmtMoney(totalParticular)} (${particular.length} pagamentos)`);
  if (particular.length === 0) console.log('  (nenhum)');
  particular.forEach(p => printPayment(p, 'PAGO'));

  // CONVÊNIO RECEBIDO
  const totalConvenioRec = convenioRecebido.reduce((s, p) => s + (p.insurance?.receivedAmount || p.amount || 0), 0);
  console.log(`\n🏥 CONVÊNIO RECEBIDO: ${fmtMoney(totalConvenioRec)} (${convenioRecebido.length} pagamentos)`);
  if (convenioRecebido.length === 0) console.log('  (nenhum)');
  convenioRecebido.forEach(p => printPayment(p, 'CONV RECEBIDO'));

  // TOTAL CAIXA
  console.log(`\n📊 TOTAL ENTRADA EM CAIXA: ${fmtMoney(totalParticular + totalConvenioRec)}`);

  // PENDENTES GERAL
  const totalPendente = pendentes.reduce((s, p) => s + (p.amount || 0), 0);
  console.log(`\n⏳ PAGAMENTOS PENDENTES (status=pending no dia): ${fmtMoney(totalPendente)} (${pendentes.length})`);
  if (pendentes.length === 0) console.log('  (nenhum)');
  pendentes.forEach(p => printPayment(p, 'PENDENTE'));

  // CONVÊNIO PENDENTE
  const totalConvPendente = convenioPendente.reduce((s, p) => s + (p.amount || 0), 0);
  console.log(`\n🏥 CONVÊNIO NÃO RECEBIDO (pendente/faturado): ${fmtMoney(totalConvPendente)} (${convenioPendente.length})`);
  if (convenioPendente.length === 0) console.log('  (nenhum)');
  convenioPendente.forEach(p => printPayment(p, 'CONV PEND'));
}

async function main() {
  try {
    await connect();
    for (const dia of [1, 2, 3]) {
      await getCaixaDoDia(dia);
    }
  } catch (err) {
    console.error('Erro:', err);
  } finally {
    await mongoose.disconnect();
    console.log('\nDesconectado.');
  }
}

main();
