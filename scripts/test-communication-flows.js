import dotenv from 'dotenv';
import mongoose from 'mongoose';
import jwt from 'jsonwebtoken';
import '../models/Admin.js';

dotenv.config({ path: '/home/user/projetos/crm/back/.env' });

const BASE_URL = 'http://localhost:5000';
const MONGODB_URI = process.env.MONGODB_URI || process.env.MONGO_URI;

async function getToken() {
  await mongoose.connect(MONGODB_URI);
  const Admin = mongoose.model('Admin');
  const admin = await Admin.findOne({ role: 'admin' }).select('_id name role').lean();
  if (!admin) throw new Error('Admin não encontrado');
  return jwt.sign(
    { id: admin._id.toString(), role: admin.role, name: admin.name },
    process.env.JWT_SECRET,
    { expiresIn: '1h' }
  );
}

async function api(path, options = {}) {
  const url = `${BASE_URL}${path}`;
  const res = await fetch(url, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
      ...options.headers
    }
  });
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { data = { raw: text }; }
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${data.error || text}`);
  return data;
}

let token;

async function run() {
  token = await getToken();
  const db = mongoose.connection.db;

  console.log('🔍 Buscando entidades de teste...');
  const authPatient = await db.collection('patients').findOne(
    { fullName: { $regex: 'Teste Autoriza', $options: 'i' } },
    { projection: { _id: 1, fullName: 1 } }
  );
  const billingGuide = await db.collection('insuranceguides').findOne(
    { insurance: 'unimed-anapolis' },
    { projection: { _id: 1, number: 1, patientId: 1, insurance: 1 } }
  );

  if (!authPatient) throw new Error('Paciente de autorização não encontrado');
  if (!billingGuide) throw new Error('Guia de faturamento não encontrada');

  console.log(`👤 Autorização: ${authPatient.fullName} (${authPatient._id})`);
  console.log(`📋 Faturamento: guia ${billingGuide.number} (${billingGuide._id})`);

  // Buscar documentos
  const authDocs = await db.collection('patientdocuments')
    .find({ patientId: authPatient._id })
    .project({ _id: 1, type: 1, name: 1 })
    .limit(5)
    .toArray();

  const billingDocs = await db.collection('patientdocuments')
    .find({ patientId: billingGuide.patientId })
    .project({ _id: 1, type: 1, name: 1 })
    .limit(5)
    .toArray();

  if (authDocs.length === 0) throw new Error('Paciente de autorização não tem documentos');
  if (billingDocs.length === 0) throw new Error('Paciente da guia não tem documentos');

  console.log(`\n🟣 FLUXO 1: AUTORIZAÇÃO`);
  const authComm = await api('/api/v2/communications', {
    method: 'POST',
    body: JSON.stringify({
      patientId: authPatient._id.toString(),
      insuranceProvider: 'unimed-test',
      purpose: 'authorization',
      specialty: 'fono',
      requestedSessions: 10,
      notes: 'Teste fluxo authorization'
    })
  });
  console.log(`  Criada: ${authComm.data._id}`);

  await api(`/api/v2/communications/${authComm.data._id}/package`, {
    method: 'POST',
    body: JSON.stringify({ documentIds: [authDocs[0]._id.toString()] })
  });
  console.log(`  Pacote: ${authDocs[0].type} - ${authDocs[0].name}`);

  const authSend = await api(`/api/v2/communications/${authComm.data._id}/send`, {
    method: 'POST',
    body: JSON.stringify({
      to: 'ricardosantos.ti15@gmail.com',
      subject: 'Teste Autorização ' + Date.now()
    })
  });
  console.log(`  Enviada: ${authSend.data.jobId}`);

  console.log(`\n🟠 FLUXO 2: FATURAMENTO`);
  const billingComm = await api('/api/v2/communications', {
    method: 'POST',
    body: JSON.stringify({
      patientId: billingGuide.patientId.toString(),
      insuranceProvider: billingGuide.insurance,
      guideId: billingGuide._id.toString(),
      purpose: 'billing',
      notes: 'Teste fluxo billing'
    })
  });
  console.log(`  Criada: ${billingComm.data._id}`);

  await api(`/api/v2/communications/${billingComm.data._id}/package`, {
    method: 'POST',
    body: JSON.stringify({ documentIds: [billingDocs[0]._id.toString()] })
  });
  console.log(`  Pacote: ${billingDocs[0].type} - ${billingDocs[0].name}`);

  const billingSend = await api(`/api/v2/communications/${billingComm.data._id}/send`, {
    method: 'POST',
    body: JSON.stringify({
      to: 'ricardosantos.ti15@gmail.com',
      subject: 'Teste Faturamento ' + Date.now()
    })
  });
  console.log(`  Enviada: ${billingSend.data.jobId}`);

  // Aguardar worker processar
  console.log('\n⏳ Aguardando 8s para o worker processar...');
  await new Promise(r => setTimeout(r, 8000));

  console.log('\n📊 Verificando resultados:');
  const authResult = await db.collection('insurancecommunications').findOne({ _id: new mongoose.Types.ObjectId(authComm.data._id) });
  const billingResult = await db.collection('insurancecommunications').findOne({ _id: new mongoose.Types.ObjectId(billingComm.data._id) });

  const authLog = await db.collection('communicationemaillogs').findOne({ communicationId: new mongoose.Types.ObjectId(authComm.data._id) });
  const billingLog = await db.collection('communicationemaillogs').findOne({ communicationId: new mongoose.Types.ObjectId(billingComm.data._id) });

  console.log(`  Autorização: status=${authResult?.status}, log=${authLog?.status}, anexos=${authLog?.attachments?.length || 0}`);
  console.log(`  Faturamento: status=${billingResult?.status}, log=${billingLog?.status}, anexos=${billingLog?.attachments?.length || 0}`);

  if (authResult?.status !== 'sent' || authLog?.status !== 'success') {
    throw new Error('Fluxo de autorização falhou');
  }
  if (billingResult?.status !== 'sent' || billingLog?.status !== 'success') {
    throw new Error('Fluxo de faturamento falhou');
  }

  console.log('\n✅ Ambos os fluxos funcionaram com sucesso!');
  process.exit(0);
}

run().catch(err => {
  console.error('\n❌', err.message);
  process.exit(1);
});
