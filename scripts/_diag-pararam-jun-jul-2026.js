// Investiga por que pacientes PARARAM o atendimento (SOMENTE LEITURA, não grava nada).
// Uso (na pasta back):  node scripts/_diag-pararam-jun-jul-2026.js
// Opcional:            node scripts/_diag-pararam-jun-jul-2026.js 2026-06-01 2026-07-31
//
// "Parou" = teve pelo menos 1 sessão de terapia realizada, a ÚLTIMA sessão realizada
// caiu no período e não tem nada agendado para frente.
// Saída: só contagens agregadas (sem nome de paciente, telefone ou CPF).
import mongoose from 'mongoose';
import dotenv from 'dotenv';
dotenv.config();

const INICIO = new Date(`${process.argv[2] || '2026-06-01'}T00:00:00-03:00`);
const FIM = new Date(`${process.argv[3] || '2026-07-31'}T23:59:59-03:00`);
const DONE = ['completed', 'paid'];
const CANCEL = ['canceled', 'force_cancelled'];
const AVAL = ['evaluation', 'neuropsych_evaluation', 'tongue_tie_test'];
const ATIVOS_FUTURO = ['pre_agendado', 'scheduled', 'confirmed', 'pending'];

const conta = (obj, k) => { obj[k] = (obj[k] || 0) + 1; };
const top = (obj, n = 15) => Object.entries(obj).sort((a, b) => b[1] - a[1]).slice(0, n);
const imprime = (titulo, obj, n) => {
  console.log(`\n=== ${titulo} ===`);
  for (const [k, v] of top(obj, n)) console.log(`${String(v).padStart(4)}  ${k}`);
};

async function main() {
  await mongoose.connect(process.env.MONGODB_URI || process.env.MONGO_URI);
  const db = mongoose.connection.db;
  const agora = new Date();

  // 1. Por paciente: última sessão realizada, terapias feitas e o que existe depois dela
  const porPaciente = await db.collection('appointments').aggregate([
    { $match: { patient: { $ne: null }, isDeleted: { $ne: true } } },
    { $sort: { date: 1 } },
    { $group: {
        _id: '$patient',
        terapias: { $sum: { $cond: [{ $and: [{ $in: ['$operationalStatus', DONE] }, { $not: [{ $in: ['$serviceType', AVAL] }] }] }, 1, 0] } },
        ultima: { $max: { $cond: [{ $in: ['$operationalStatus', DONE] }, '$date', null] } },
        futuras: { $sum: { $cond: [{ $and: [{ $gte: ['$date', agora] }, { $in: ['$operationalStatus', ATIVOS_FUTURO] }] }, 1, 0] } },
        appts: { $push: { date: '$date', st: '$operationalStatus', doctor: '$doctor', specialty: '$specialty',
          billing: '$billingType', conv: '$insuranceProvider', pkg: '$package', reason: '$cancelReason', src: '$cancelSource' } },
    } },
    { $match: { terapias: { $gte: 1 }, futuras: 0, ultima: { $gte: INICIO, $lte: FIM } } },
  ], { allowDiskUse: true }).toArray();

  console.log(`Período: ${INICIO.toISOString().slice(0, 10)} a ${FIM.toISOString().slice(0, 10)}`);
  console.log(`Pacientes que pararam (última sessão no período, nada agendado): ${porPaciente.length}`);
  if (!porPaciente.length) { await mongoose.disconnect(); return; }

  // 2. Dados de apoio: profissionais, pacotes, guias, cadastro
  const doctorIds = [...new Set(porPaciente.flatMap(p => p.appts.map(a => a.doctor?.toString())).filter(Boolean))];
  const pkgIds = [...new Set(porPaciente.flatMap(p => p.appts.map(a => a.pkg?.toString())).filter(Boolean))];
  const patIds = porPaciente.map(p => p._id);
  const oid = id => new mongoose.Types.ObjectId(id);

  const [doctors, pkgs, guias, pats] = await Promise.all([
    db.collection('doctors').find({ _id: { $in: doctorIds.map(oid) } }, { projection: { fullName: 1, active: 1, status: 1 } }).toArray(),
    db.collection('packages').find({ _id: { $in: pkgIds.map(oid) } }, { projection: { totalSessions: 1, sessionsDone: 1, status: 1, type: 1 } }).toArray(),
    db.collection('insuranceguides').find({ patientId: { $in: patIds } }, { projection: { patientId: 1, expiresAt: 1, status: 1, totalSessions: 1, usedSessions: 1 } }).toArray(),
    db.collection('patients').find({ _id: { $in: patIds } }, { projection: { status: 1, healthPlan: 1 } }).toArray(),
  ]);
  const docMap = Object.fromEntries(doctors.map(d => [d._id.toString(), d]));
  const pkgMap = Object.fromEntries(pkgs.map(p => [p._id.toString(), p]));
  const patMap = Object.fromEntries(pats.map(p => [p._id.toString(), p]));
  const guiasPorPac = {};
  for (const g of guias) (guiasPorPac[g.patientId.toString()] ||= []).push(g);

  const r = { mes: {}, especialidade: {}, profissional: {}, profAtivo: {}, pagamento: {}, sinal: {}, motivos: {}, faixa: {}, statusCadastro: {} };

  for (const p of porPaciente) {
    const feitas = p.appts.filter(a => DONE.includes(a.st));
    const last = feitas[feitas.length - 1];
    const depois = p.appts.filter(a => a.date > last.date);
    const canc = depois.filter(a => CANCEL.includes(a.st));
    const faltas = depois.filter(a => a.st === 'missed');
    const doc = docMap[last.doctor?.toString()];
    const pkg = pkgMap[last.pkg?.toString()];
    const conv = [last.conv, patMap[p._id.toString()]?.healthPlan?.name].filter(Boolean).join(' / ');
    const pid = p._id.toString();

    conta(r.mes, last.date.toISOString().slice(0, 7));
    conta(r.especialidade, last.specialty || 'sem especialidade');
    conta(r.profissional, doc?.fullName || 'sem profissional');
    conta(r.profAtivo, doc ? (doc.active === false ? 'profissional INATIVO hoje' : 'profissional ativo') : 'sem profissional');
    conta(r.pagamento, conv ? `convênio: ${conv}` : (pkg?.type === 'liminar' ? 'liminar' : 'particular'));
    conta(r.statusCadastro, patMap[pid]?.status || 'sem status');
    const t = p.terapias;
    conta(r.faixa, t <= 4 ? '1–4 sessões' : t <= 10 ? '5–10 sessões' : t <= 30 ? '11–30 sessões' : '30+ sessões');

    // Sinal principal do motivo (o primeiro que bater, em ordem de força)
    const gs = guiasPorPac[pid] || [];
    const guiaVencida = gs.length && gs.every(g => g.status === 'expired' || g.status === 'exhausted' || (g.expiresAt && g.expiresAt < agora));
    let sinal;
    if (doc && doc.active === false) sinal = 'profissional saiu / inativo';
    else if (canc.length) sinal = 'cancelou sessões depois da última';
    else if (faltas.length >= 2) sinal = 'faltou 2+ vezes depois da última';
    else if (pkg && (pkg.sessionsDone >= pkg.totalSessions || ['completed', 'finished'].includes(pkg.status))) sinal = 'pacote acabou e não renovou';
    else if (guiaVencida) sinal = 'guia do convênio venceu/esgotou';
    else if (pkg && pkg.status === 'canceled') sinal = 'pacote cancelado';
    else sinal = 'sem sinal no sistema (perguntar à família)';
    conta(r.sinal, sinal);
    for (const a of canc) conta(r.motivos, (a.reason || '').trim().toLowerCase() || `(sem motivo) ${a.src || ''}`.trim());
  }

  imprime('Mês da última sessão', r.mes);
  imprime('Sinal mais provável do motivo', r.sinal);
  imprime('Especialidade', r.especialidade);
  imprime('Profissional da última sessão', r.profissional, 30);
  imprime('Profissional ainda ativo?', r.profAtivo);
  imprime('Forma de pagamento', r.pagamento);
  imprime('Quantas terapias tinha feito', r.faixa);
  imprime('Status do cadastro do paciente', r.statusCadastro);
  imprime('Motivos de cancelamento escritos', r.motivos, 20);
  console.log('\nComo ler: se um profissional, um convênio ou o sinal "pacote acabou" concentrar a maior parte, a causa é essa.');

  await mongoose.disconnect();
}

main().catch(async e => { console.error('ERRO:', e.message); await mongoose.disconnect(); process.exit(1); });
