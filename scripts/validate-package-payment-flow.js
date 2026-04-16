import mongoose from 'mongoose';

// Pre-load models that are eagerly accessed by dependencies
await import('../models/PatientsView.js');
await import('../models/Patient.js');
await import('../models/InsuranceGuide.js');

const { default: Package } = await import('../models/Package.js');
const { default: Appointment } = await import('../models/Appointment.js');
const { default: Session } = await import('../models/Session.js');
const { default: Payment } = await import('../models/Payment.js');
const { default: FinancialLedger } = await import('../models/FinancialLedger.js');
const { default: PatientBalance } = await import('../models/PatientBalance.js');
const { completeSessionV2 } = await import('../services/completeSessionService.v2.js');

async function run() {
  await mongoose.connect(process.env.MONGODB_URI || 'mongodb://localhost:27017/crm');
  console.log('Connected to MongoDB');

  const Patient = mongoose.model('Patient');
  const patient = await Patient.create({ fullName: 'Teste Pacote', phone: '11999999999', cpf: '12345678901' });
  console.log('Patient:', patient._id.toString());

  // 1. Package per-session
  const pkg = await Package.create({
    patient: patient._id,
    doctor: new mongoose.Types.ObjectId(),
    specialty: 'fonoaudiologia',
    sessionType: 'fonoaudiologia',
    totalSessions: 2,
    sessionValue: 100,
    totalValue: 200,
    balance: 200,
    type: 'therapy',
    model: 'per_session',
    paymentType: 'per-session',
    financialStatus: 'unpaid'
  });

  const appt = await Appointment.create({
    patient: patient._id,
    doctor: pkg.doctor,
    date: new Date(),
    time: '10:00',
    specialty: 'fonoaudiologia',
    package: pkg._id,
    serviceType: 'package_session',
    operationalStatus: 'scheduled',
    billingType: 'particular',
    paymentOrigin: 'auto_per_session',
    sessionValue: 100
  });

  const sess = await Session.create({
    patient: patient._id,
    doctor: pkg.doctor,
    date: new Date(),
    time: '10:00',
    specialty: 'fonoaudiologia',
    package: pkg._id,
    appointmentId: appt._id,
    sessionValue: 100,
    status: 'scheduled'
  });

  appt.session = sess._id;
  await appt.save();

  console.log('\n--- PER-SESSION PACKAGE ---');

  const result1 = await completeSessionV2(appt._id.toString(), { userId: 'test' });
  console.log('Complete result:', { billingType: result1.billingType, packageId: result1.packageId, paymentId: result1.paymentId });

  const apptAfter = await Appointment.findById(appt._id);
  const paymentAfter = apptAfter.payment ? await Payment.findById(apptAfter.payment) : null;
  console.log('After complete - payment:', paymentAfter ? { _id: paymentAfter._id.toString(), status: paymentAfter.status, amount: paymentAfter.amount, billingType: paymentAfter.billingType } : null);

  const ledger1 = await FinancialLedger.find({ appointment: appt._id });
  console.log('Ledger entries:', ledger1.map(l => ({ type: l.type, amount: l.amount, billingType: l.billingType })));

  // 2. Package convenio
  console.log('\n--- CONVENIO PACKAGE ---');
  const pkgConv = await Package.create({
    patient: patient._id,
    doctor: new mongoose.Types.ObjectId(),
    specialty: 'fonoaudiologia',
    sessionType: 'fonoaudiologia',
    totalSessions: 1,
    sessionValue: 150,
    totalValue: 150,
    type: 'convenio',
    model: 'convenio',
    insuranceProvider: 'Unimed',
    insuranceCompany: 'Unimed'
  });

  const apptConv = await Appointment.create({
    patient: patient._id,
    doctor: pkgConv.doctor,
    date: new Date(),
    time: '11:00',
    specialty: 'fonoaudiologia',
    package: pkgConv._id,
    serviceType: 'package_session',
    operationalStatus: 'scheduled',
    billingType: 'convenio',
    sessionValue: 150,
    insuranceProvider: 'Unimed'
  });

  const sessConv = await Session.create({
    patient: patient._id,
    doctor: pkgConv.doctor,
    date: new Date(),
    time: '11:00',
    specialty: 'fonoaudiologia',
    package: pkgConv._id,
    appointmentId: apptConv._id,
    sessionValue: 150,
    status: 'scheduled'
  });

  apptConv.session = sessConv._id;
  await apptConv.save();

  const result2 = await completeSessionV2(apptConv._id.toString(), { userId: 'test' });
  console.log('Complete result:', { billingType: result2.billingType, packageId: result2.packageId, paymentId: result2.paymentId });

  const apptConvAfter = await Appointment.findById(apptConv._id);
  const paymentConvAfter = apptConvAfter.payment ? await Payment.findById(apptConvAfter.payment) : null;
  console.log('After complete - payment:', paymentConvAfter ? { _id: paymentConvAfter._id.toString(), status: paymentConvAfter.status, billingType: paymentConvAfter.billingType, insurance: paymentConvAfter.insurance } : null);

  const ledger2 = await FinancialLedger.find({ appointment: apptConv._id });
  console.log('Ledger entries:', ledger2.map(l => ({ type: l.type, amount: l.amount, billingType: l.billingType })));

  // Cleanup
  await PatientBalance.deleteMany({ patient: patient._id });
  await FinancialLedger.deleteMany({ patient: patient._id });
  await Payment.deleteMany({ patient: patient._id });
  await Session.deleteMany({ patient: patient._id });
  await Appointment.deleteMany({ patient: patient._id });
  await Package.deleteMany({ patient: patient._id });
  await Patient.findByIdAndDelete(patient._id);

  await mongoose.disconnect();
  console.log('\nDone.');
}

run().catch(err => {
  console.error(err);
  process.exit(1);
});
