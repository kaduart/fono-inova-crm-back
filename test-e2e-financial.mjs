#!/usr/bin/env node
/**
 * Teste E2E - Package V2 + Payment Flow
 * Valida: Per-Session | Liminar | Convenio | Billing | Balance
 */

const BASE_URL = 'http://localhost:5000';

const colors = {
  reset: '\x1b[0m',
  green: '\x1b[32m',
  red: '\x1b[31m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  cyan: '\x1b[36m'
};

const log = {
  info: (msg) => console.log(`${colors.blue}ℹ️ ${msg}${colors.reset}`),
  success: (msg) => console.log(`${colors.green}✅ ${msg}${colors.reset}`),
  error: (msg) => console.log(`${colors.red}❌ ${msg}${colors.reset}`),
  warn: (msg) => console.log(`${colors.yellow}⚠️ ${msg}${colors.reset}`),
  financial: (msg) => console.log(`${colors.cyan}💰 ${msg}${colors.reset}`)
};

async function api(method, endpoint, body = null, token = null) {
  const url = `${BASE_URL}${endpoint}`;
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers['Authorization'] = `Bearer ${token}`;
  
  const options = { method, headers };
  if (body) options.body = JSON.stringify(body);
  
  const response = await fetch(url, options);
  const data = await response.json().catch(() => ({}));
  return { status: response.status, ok: response.ok, data };
}

// ============ TESTES ============

async function testLogin() {
  log.info('TESTE 1: Login');
  const res = await api('POST', '/api/login', {
    email: 'clinicafonoinova@gmail.com',
    password: 'admin1234',
    role: 'admin'
  });
  if (!res.ok || !res.data.token) {
    log.error('Login falhou');
    return null;
  }
  log.success('Login OK');
  return res.data.token;
}

async function getOrCreatePatient(token) {
  log.info('Buscando/Criando paciente de teste');
  
  // Tenta usar paciente existente
  const list = await api('GET', '/api/v2/patients?page=1&limit=1', null, token);
  if (list.ok && list.data.data?.length > 0) {
    const patient = list.data.data[0];
    log.success(`Usando paciente: ${patient.fullName}`);
    return patient._id || patient.id;
  }
  
  // Cria novo
  const uniqueId = Date.now();
  const create = await api('POST', '/api/v2/patients', {
    fullName: `Teste Financial ${uniqueId}`,
    dateOfBirth: '1990-01-01',
    email: `teste${uniqueId}@financial.com`,
    cpf: `${uniqueId}`.padStart(11, '0').slice(0, 11)
  }, token);
  
  if (create.status === 202) {
    return create.data.data?.patientId || create.data.patientId;
  }
  return null;
}

async function testCreatePackagePerSession(token, patientId) {
  log.info('TESTE 2: Create Package PER-SESSION (Particular)');
  
  // Busca doctor e specialty
  const doctors = await api('GET', '/api/doctors/active/list', null, token);
  const doctorId = doctors.data?.[0]?._id;
  const specialty = doctors.data?.[0]?.specialty?._id || doctors.data?.[0]?.specialty;
  
  const pkgData = {
    patientId: patientId,
    doctorId: doctorId,
    specialty: specialty || 'Fonoaudiologia',
    name: 'Pacote Particular Teste',
    type: 'package',
    billingType: 'particular',
    totalSessions: 10,
    sessionValue: 150.00,
    modality: 'presencial'
  };
  
  const res = await api('POST', '/api/v2/packages', pkgData, token);
  
  if (!res.ok && res.status !== 202) {
    log.error(`Create Package falhou: ${JSON.stringify(res.data)}`);
    return null;
  }
  
  const pkgId = res.data.data?.packageId || res.data.packageId || 
                res.data.data?._id || res.data._id;
  
  if (!pkgId) {
    log.error('DTO sem packageId');
    return null;
  }
  
  log.success(`Package criado: ${pkgId}`);
  log.financial(`  Tipo: ${pkgData.billingType} | Valor sessão: R$${pkgData.sessionValue}`);
  return pkgId;
}

async function testCreatePackageLiminar(token, patientId) {
  log.info('TESTE 3: Create Package LIMINAR (Crédito)');
  
  const doctors = await api('GET', '/api/doctors/active/list', null, token);
  const doctorId = doctors.data?.[0]?._id;
  const specialty = doctors.data?.[0]?.specialty?._id || doctors.data?.[0]?.specialty;
  
  const pkgData = {
    patientId: patientId,
    doctorId: doctorId,
    specialty: specialty || 'Fonoaudiologia',
    name: 'Pacote Liminar Teste',
    type: 'liminar',
    billingType: 'liminar',
    totalSessions: 20,
    sessionValue: 0,
    modality: 'presencial'
  };
  
  const res = await api('POST', '/api/v2/packages', pkgData, token);
  
  if (!res.ok && res.status !== 202) {
    log.error(`Create Liminar falhou: ${JSON.stringify(res.data)}`);
    return null;
  }
  
  const pkgId = res.data.data?.packageId || res.data.packageId || 
                res.data.data?._id || res.data._id;
  
  log.success(`Package Liminar criado: ${pkgId}`);
  log.financial(`  Tipo: ${pkgData.billingType} | Sessões: ${pkgData.totalSessions}`);
  return pkgId;
}

async function testCreatePackageConvenio(token, patientId) {
  log.info('TESTE 4: Create Package CONVÊNIO');
  
  const doctors = await api('GET', '/api/doctors/active/list', null, token);
  const doctorId = doctors.data?.[0]?._id;
  const specialty = doctors.data?.[0]?.specialty?._id || doctors.data?.[0]?.specialty;
  
  const pkgData = {
    patientId: patientId,
    doctorId: doctorId,
    specialty: specialty || 'Fonoaudiologia',
    name: 'Pacote Convênio Teste',
    type: 'convenio',
    billingType: 'convenio',
    totalSessions: 12,
    sessionValue: 80.00,
    modality: 'presencial'
  };
  
  const res = await api('POST', '/api/v2/packages', pkgData, token);
  
  if (!res.ok && res.status !== 202) {
    log.error(`Create Convenio falhou: ${JSON.stringify(res.data)}`);
    return null;
  }
  
  const pkgId = res.data.data?.packageId || res.data.packageId || 
                res.data.data?._id || res.data._id;
  
  log.success(`Package Convênio criado: ${pkgId}`);
  log.financial(`  Tipo: ${pkgData.billingType} | Valor: R$${pkgData.sessionValue}`);
  return pkgId;
}

async function testGetPackageBalance(token, packageId) {
  log.info(`TESTE 5: Verificar Package Balance (${packageId})`);
  
  const res = await api('GET', `/api/v2/packages/${packageId}`, null, token);
  
  if (!res.ok) {
    log.error(`Get Package falhou: ${JSON.stringify(res.data)}`);
    return null;
  }
  
  const pkg = res.data.data || res.data;
  log.financial(`  Status: ${pkg.status}`);
  log.financial(`  Sessões: ${pkg.sessionsDone || 0}/${pkg.totalSessions}`);
  log.financial(`  Balance: R$${pkg.balance || 0}`);
  log.financial(`  Credit: R$${pkg.credit || 0}`);
  
  return pkg;
}

async function testCreateAppointmentWithPackage(token, patientId, packageId) {
  log.info('TESTE 6: Create Appointment vinculado a Package');
  
  // Busca doctor
  const doctors = await api('GET', '/api/doctors/active/list', null, token);
  if (!doctors.ok || !doctors.data.length) {
    log.warn('Sem doctors disponíveis');
    return null;
  }
  
  const future = new Date();
  future.setDate(future.getDate() + 7);
  
  const appointmentData = {
    patientId: patientId,
    doctorId: doctors.data[0]._id,
    date: future.toISOString().split('T')[0],
    time: '10:00',
    type: 'particular',
    packageId: packageId
  };
  
  const res = await api('POST', '/api/v2/appointments', appointmentData, token);
  
  if (!res.ok) {
    log.error(`Create Appointment falhou: ${JSON.stringify(res.data)}`);
    return null;
  }
  
  const apptId = res.data.data?.appointmentId || res.data.appointmentId || 
                 res.data.data?._id || res.data._id;
  
  log.success(`Appointment criado: ${apptId}`);
  return apptId;
}

async function testPaymentFlow(token, patientId) {
  log.info('TESTE 7: Payment Flow - Débito e Pagamento');
  
  // 1. Criar débito no balance
  const debitData = {
    amount: 300.00,
    description: 'Débito teste E2E',
    referenceType: 'appointment',
    referenceId: 'test-123'
  };
  
  const debit = await api('POST', `/api/v2/balance/${patientId}/debit`, debitData, token);
  
  if (!debit.ok) {
    log.error(`Débito falhou: ${JSON.stringify(debit.data)}`);
  } else {
    log.success(`Débito criado: R$${debitData.amount}`);
  }
  
  // 2. Ver balance
  const balance = await api('GET', `/api/v2/balance/${patientId}`, null, token);
  if (balance.ok) {
    const bal = balance.data.data || balance.data;
    log.financial(`  Balance atual: R$${bal.balance || 0}`);
    log.financial(`  TotalDebit: R$${bal.totalDebit || 0}`);
    log.financial(`  TotalCredit: R$${bal.totalCredit || 0}`);
  }
  
  // 3. Registrar pagamento
  const paymentData = {
    amount: 150.00,
    method: 'pix',
    description: 'Pagamento parcial teste'
  };
  
  const payment = await api('POST', `/api/v2/payments/balance/${patientId}/payment`, paymentData, token);
  
  if (!payment.ok) {
    log.error(`Pagamento falhou: ${JSON.stringify(payment.data)}`);
  } else {
    log.success(`Pagamento registrado: R$${paymentData.amount}`);
  }
  
  // 4. Ver balance novamente
  const balance2 = await api('GET', `/api/v2/balance/${patientId}`, null, token);
  if (balance2.ok) {
    const bal = balance2.data.data || balance2.data;
    log.financial(`  Balance após pagamento: R$${bal.balance || 0}`);
  }
}

// ============ MAIN ============

async function runTests() {
  console.log('💰 E2E FINANCIAL TEST - Package V2 + Payment Flow');
  console.log('='.repeat(70));
  
  // 1. Login
  const token = await testLogin();
  if (!token) process.exit(1);
  
  // 2. Paciente
  const patientId = await getOrCreatePatient(token);
  if (!patientId) process.exit(1);
  
  // 3. Packages
  const pkgPerSession = await testCreatePackagePerSession(token, patientId);
  const pkgLiminar = await testCreatePackageLiminar(token, patientId);
  const pkgConvenio = await testCreatePackageConvenio(token, patientId);
  
  // 4. Verificar um package
  if (pkgPerSession) {
    await testGetPackageBalance(token, pkgPerSession);
  }
  
  // 5. Appointment com package
  if (pkgPerSession) {
    await testCreateAppointmentWithPackage(token, patientId, pkgPerSession);
  }
  
  // 6. Payment flow
  await testPaymentFlow(token, patientId);
  
  console.log('\n' + '='.repeat(70));
  log.success('E2E FINANCIAL TEST COMPLETO');
  log.financial('Tipos testados: Per-Session | Liminar | Convenio');
  log.financial('Flows: Create | Balance | Payment');
}

runTests().catch(err => {
  log.error(`Erro inesperado: ${err.message}`);
  process.exit(1);
});
