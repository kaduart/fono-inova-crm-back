import mongoose from 'mongoose';

const uri = 'mongodb+srv://kaduart:%40Soundcar10@cluster0.g2c3sdk.mongodb.net/crm_test_e2e';

const packageSchema = new mongoose.Schema({
  patient: { type: mongoose.Schema.Types.ObjectId, ref: 'Patient', required: true },
  professional: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  modality: { type: String, required: true },
  totalSessions: { type: Number, required: true },
  sessionsRemaining: { type: Number, required: true },
  sessionValue: { type: Number, required: true },
  totalValue: { type: Number, required: true },
  paymentStatus: { type: String, enum: ['pending', 'partial', 'paid'], default: 'pending' },
  status: { type: String, enum: ['active', 'completed', 'cancelled'], default: 'active' },
  createdAt: { type: Date, default: Date.now }
});

const patientBalanceSchema = new mongoose.Schema({
  patient: { type: mongoose.Schema.Types.ObjectId, ref: 'Patient', required: true },
  currentBalance: { type: Number, default: 0 },
  totalDebited: { type: Number, default: 0 },
  totalCredited: { type: Number, default: 0 },
  transactions: [{
    date: Date,
    type: { type: String, enum: ['debit', 'credit', 'payment', 'refund'] },
    value: Number,
    description: String,
    appointment: { type: mongoose.Schema.Types.ObjectId, ref: 'Appointment' },
    package: { type: mongoose.Schema.Types.ObjectId, ref: 'Package' }
  }]
});

async function setupBillingTest() {
  try {
    await mongoose.connect(uri);
    console.log('✅ Conectado ao MongoDB');
    
    const Package = mongoose.model('Package', packageSchema);
    const PatientBalance = mongoose.model('PatientBalance', patientBalanceSchema);
    
    // Usar paciente e profissional existentes
    const patientId = '69c7a4ed78dcc17241d68449';
    const professionalId = '69c7fb3178dcc17241d68448';
    
    // 1. Criar Package para o paciente
    console.log('\n=== 1. CRIANDO PACKAGE ===');
    const packageData = {
      patient: new mongoose.Types.ObjectId(patientId),
      professional: new mongoose.Types.ObjectId(professionalId),
      modality: 'fisioterapia',
      totalSessions: 10,
      sessionsRemaining: 10,
      sessionValue: 150.00,
      totalValue: 1500.00,
      paymentStatus: 'paid',
      status: 'active'
    };
    
    const pkg = await Package.create(packageData);
    console.log(`✅ Package criado: ${pkg._id}`);
    console.log(`   Sessions: ${pkg.sessionsRemaining}/${pkg.totalSessions}`);
    console.log(`   Value per session: R$ ${pkg.sessionValue}`);
    
    // 2. Verificar/criar PatientBalance
    console.log('\n=== 2. VERIFICANDO PATIENT BALANCE ===');
    let balance = await PatientBalance.findOne({ patient: patientId });
    if (!balance) {
      balance = await PatientBalance.create({
        patient: new mongoose.Types.ObjectId(patientId),
        currentBalance: 0,
        totalDebited: 0,
        totalCredited: 0,
        transactions: []
      });
      console.log(`✅ PatientBalance criado: ${balance._id}`);
    } else {
      console.log(`✅ PatientBalance existente: ${balance._id}`);
      console.log(`   Current balance: R$ ${balance.currentBalance}`);
    }
    
    console.log('\n=== DADOS PARA TESTE ===');
    console.log(`Patient ID: ${patientId}`);
    console.log(`Professional ID: ${professionalId}`);
    console.log(`Package ID: ${pkg._id}`);
    
    return {
      patientId,
      professionalId,
      packageId: pkg._id.toString()
    };
    
  } catch (err) {
    console.error('❌ Erro:', err.message);
    console.error(err.stack);
    throw err;
  } finally {
    await mongoose.disconnect();
    console.log('\n✅ Desconectado');
  }
}

setupBillingTest().then(data => {
  console.log('\n' + JSON.stringify(data, null, 2));
}).catch(err => {
  console.error('Falha:', err);
  process.exit(1);
});
