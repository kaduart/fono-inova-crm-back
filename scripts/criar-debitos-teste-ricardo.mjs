import mongoose from 'mongoose';
import dotenv from 'dotenv';
import moment from 'moment-timezone';
import { fileURLToPath } from 'url';
import path from 'path';
import fs from 'fs/promises';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
dotenv.config({ path: path.resolve(__dirname, '../.env') });

const MONGO_URI = process.env.MONGODB_URI || process.env.MONGO_URI;
const TIMEZONE = 'America/Sao_Paulo';

const args = process.argv.slice(2);
const CONFIRM = args.includes('--confirm');
const CLEANUP = args.includes('--cleanup');

const COUNT = Number(process.env.COUNT || process.env.N || 30);
const VALOR = Number(process.env.VALOR || process.env.V || 100);
const PATIENT_NAME = process.env.PATIENT || 'Paciente Teste Autorização';
const DOCTOR_NAME = process.env.DOUTOR || 'Ricardo Maia Santos';
const METODO = process.env.METODO || 'pix';
const NOTAS = process.env.NOTAS || 'Débito de teste - Ricardo';
const DATA_INPUT = process.env.DATA || '';
const LOG_FILE = path.resolve(__dirname, '.last-test-debts-ricardo.json');

function horariosParaSlots(count) {
  const base = moment.tz('08:00', 'HH:mm', TIMEZONE);
  const slots = [];
  for (let i = 0; i < count; i++) {
    slots.push(base.clone().add(i * 30, 'minutes').format('HH:mm'));
  }
  return slots;
}

async function listarOpcoes(Patient, Doctor) {
  const pacientes = await Patient.find({ fullName: { $regex: /teste/i } })
    .limit(10).select('fullName phone').lean();
  const doutores = await Doctor.find({ fullName: { $regex: /ricardo/i } })
    .select('fullName specialty active').lean();

  console.log('\n👤 Pacientes de teste encontrados:');
  pacientes.forEach(p => console.log(`   ${p._id.toString()} — ${p.fullName}`));
  console.log('\n🩺 Doutores encontrados:');
  doutores.forEach(d => console.log(`   ${d._id.toString()} — ${d.fullName} (${d.specialty}) ${d.active ? '' : '[INATIVO]'}`));
}

async function cleanup() {
  if (!MONGO_URI) {
    console.error('❌ MONGODB_URI não configurada');
    process.exit(1);
  }
  let data;
  try {
    data = JSON.parse(await fs.readFile(LOG_FILE, 'utf8'));
  } catch (err) {
    console.error('❌ Não encontrei o arquivo de log de criação. Nada para limpar:', err.message);
    process.exit(1);
  }

  await mongoose.connect(MONGO_URI);
  const Appointment = (await import('../models/Appointment.js')).default;
  const Session = (await import('../models/Session.js')).default;
  const Payment = (await import('../models/Payment.js')).default;

  const { appointments, sessions, payments, patientName, date, count } = data;
  console.log(`\n🧹 Limpando ${count} registros de teste de ${patientName} em ${date}...`);

  const apptIds = appointments.map(id => new mongoose.Types.ObjectId(id));
  const sessIds = sessions.map(id => new mongoose.Types.ObjectId(id));
  const payIds = payments.map(id => new mongoose.Types.ObjectId(id));

  const resAppt = await Appointment.deleteMany({ _id: { $in: apptIds } });
  const resSess = await Session.deleteMany({ _id: { $in: sessIds } });
  const resPay = await Payment.deleteMany({ _id: { $in: payIds } });

  console.log(`   Appointments removidos: ${resAppt.deletedCount}/${apptIds.length}`);
  console.log(`   Sessions removidas:   ${resSess.deletedCount}/${sessIds.length}`);
  console.log(`   Payments removidos:   ${resPay.deletedCount}/${payIds.length}`);

  await fs.unlink(LOG_FILE);
  console.log('✅ Log deletado.');
  await mongoose.disconnect();
  process.exit(0);
}

async function main() {
  if (CLEANUP) return cleanup();

  if (!MONGO_URI) {
    console.error('❌ MONGODB_URI não configurada');
    process.exit(1);
  }

  const targetDate = DATA_INPUT
    ? moment.tz(DATA_INPUT, 'YYYY-MM-DD', TIMEZONE).format('YYYY-MM-DD')
    : moment.tz(TIMEZONE).format('YYYY-MM-DD');

  const slots = horariosParaSlots(COUNT);
  const total = COUNT * VALOR;

  console.log('\n══════════════════════════════════════════════════════════');
  console.log('  CRIAR DÉBITOS DE TESTE — DOUTOR RICARDO');
  console.log('══════════════════════════════════════════════════════════');
  console.log(`Paciente padrão:  ${PATIENT_NAME}`);
  console.log(`Doutor padrão:    ${DOCTOR_NAME}`);
  console.log(`Data:             ${targetDate}`);
  console.log(`Quantidade:       ${COUNT}`);
  console.log(`Valor unitário:   R$ ${VALOR.toFixed(2)}`);
  console.log(`Total pendente:   R$ ${total.toFixed(2)}`);
  console.log(`Método (payment): ${METODO}`);
  console.log(`Horários:         ${slots[0]} às ${slots[slots.length - 1]} (de 30 em 30 min)`);
  console.log('══════════════════════════════════════════════════════════');

  if (!CONFIRM) {
    console.log('\n⚠️  MODO SIMULAÇÃO (dry-run). Nada foi criado.');
    console.log('    Para criar de verdade, rode novamente com: --confirm');
    console.log('    Exemplo: COUNT=30 VALOR=100 METODO=pix node scripts/criar-debitos-teste-ricardo.mjs --confirm');
    console.log('\n💡 Dica: o caixa/dashboard filtra nomes com "teste" ou "test" do cash.');
    console.log('   Se quiser ver no caixa, use um paciente cujo nome NÃO contenha essas palavras.');
    process.exit(0);
  }

  await mongoose.connect(MONGO_URI);
  const Patient = (await import('../models/Patient.js')).default;
  const Doctor = (await import('../models/Doctor.js')).default;
  const Appointment = (await import('../models/Appointment.js')).default;
  const Session = (await import('../models/Session.js')).default;
  const Payment = (await import('../models/Payment.js')).default;

  const patient = await Patient.findOne({ fullName: { $regex: PATIENT_NAME, $options: 'i' } }).lean();
  const doctor = await Doctor.findOne({ fullName: { $regex: DOCTOR_NAME, $options: 'i' } }).lean();

  if (!patient) {
    console.error(`\n❌ Paciente "${PATIENT_NAME}" não encontrado.`);
    await listarOpcoes(Patient, Doctor);
    await mongoose.disconnect();
    process.exit(1);
  }
  if (!doctor) {
    console.error(`\n❌ Doutor "${DOCTOR_NAME}" não encontrado.`);
    await listarOpcoes(Patient, Doctor);
    await mongoose.disconnect();
    process.exit(1);
  }

  const specialty = doctor.specialty || 'fonoaudiologia';
  const serviceDate = moment.tz(targetDate, 'YYYY-MM-DD', TIMEZONE).toDate();

  // Verifica se já existe log de criação anterior para evitar duplicar sem querer
  let logExistente = null;
  try {
    logExistente = JSON.parse(await fs.readFile(LOG_FILE, 'utf8'));
  } catch { /* não existe */ }
  if (logExistente) {
    console.log('\n⚠️  Já existe um log de criação anterior:');
    console.log(`   ${logExistente.count} registros em ${logExistente.date} para ${logExistente.patientName}`);
    console.log('   Rode com --cleanup primeiro se quiser apagar o lote antigo antes de criar um novo.');
    console.log('   Ou delete manualmente o arquivo:', LOG_FILE);
    await mongoose.disconnect();
    process.exit(1);
  }

  const mongoSession = await mongoose.startSession();
  await mongoSession.startTransaction();

  const created = { appointments: [], sessions: [], payments: [], times: [] };

  try {
    for (let i = 0; i < COUNT; i++) {
      const time = slots[i];
      created.times.push(time);

      const appt = new Appointment({
        patient: patient._id,
        doctor: doctor._id,
        date: targetDate,
        time,
        operationalStatus: 'completed',
        clinicalStatus: 'completed',
        specialty,
        sessionType: specialty,
        serviceType: 'session',
        sessionValue: VALOR,
        billingType: 'particular',
        paymentStatus: 'pending',
        isPaid: false,
        paymentMethod: null,
        patientInfo: {
          fullName: patient.fullName,
          phone: patient.phone || ''
        },
        _fromCompleteService: true,
        notes: NOTAS
      });
      await appt.save({ session: mongoSession });

      const sess = new Session({
        appointmentId: appt._id,
        patient: patient._id,
        doctor: doctor._id,
        date: targetDate,
        time,
        sessionType: specialty,
        serviceType: 'session',
        sessionValue: VALOR,
        status: 'completed',
        paymentStatus: 'pending',
        isPaid: false,
        billingType: 'particular',
        paymentMethod: null,
        _fromCompleteService: true,
        notes: NOTAS
      });
      await sess.save({ session: mongoSession });

      appt.session = sess._id;

      const pay = new Payment({
        patient: patient._id,
        doctor: doctor._id,
        appointment: appt._id,
        session: sess._id,
        amount: VALOR,
        paymentMethod: METODO,
        paymentDate: serviceDate,
        serviceDate,
        status: 'pending',
        billingType: 'particular',
        serviceType: 'session',
        sessionType: specialty,
        kind: 'session_payment',
        notes: NOTAS
      });
      await pay.save({ session: mongoSession });

      appt.payment = pay._id;
      await appt.save({ session: mongoSession });

      created.appointments.push(appt._id.toString());
      created.sessions.push(sess._id.toString());
      created.payments.push(pay._id.toString());

      console.log(`  ${String(i + 1).padStart(2, '0')}/${COUNT} | ${time} | appt ${appt._id.toString().slice(-6)} | sess ${sess._id.toString().slice(-6)} | pay ${pay._id.toString().slice(-6)}`);
    }

    await mongoSession.commitTransaction();

    const logData = {
      createdAt: new Date().toISOString(),
      patientId: patient._id.toString(),
      patientName: patient.fullName,
      doctorId: doctor._id.toString(),
      doctorName: doctor.fullName,
      date: targetDate,
      count: COUNT,
      valor: VALOR,
      total,
      metodo: METODO,
      ...created
    };
    await fs.writeFile(LOG_FILE, JSON.stringify(logData, null, 2));

    console.log('\n✅ Criados com sucesso:');
    console.log(`   ${COUNT} Appointments`);
    console.log(`   ${COUNT} Sessions`);
    console.log(`   ${COUNT} Payments (status: pending, total: R$ ${total.toFixed(2)})`);
    console.log(`\n📄 Log salvo em: ${LOG_FILE}`);
    console.log('   Para limpar depois, rode: node scripts/criar-debitos-teste-ricardo.mjs --cleanup');
    console.log('\n⚠️  Atenção:');
    console.log('   • O cashflow/dashboard filtra nomes com "teste" ou "test" do caixa.');
    console.log('     Os pagamentos PENDENTES ainda aparecem na lista de cobrança (produção).');
    console.log('   • Para marcar como pago, use o ID do Payment: PATCH /api/v2/payments/:id { status: "paid", paymentMethod: "pix" }');
    console.log('   • Ou use a ação de "Receber" no calendário/paciente.');
  } catch (err) {
    await mongoSession.abortTransaction();
    console.error('\n❌ Erro durante criação (transaction abortada):', err.message);
    console.error(err.stack);
    await mongoose.disconnect();
    process.exit(1);
  } finally {
    await mongoSession.endSession();
  }

  await mongoose.disconnect();
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
