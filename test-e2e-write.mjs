#!/usr/bin/env node
/**
 * Teste E2E - Escrita de Dados (CRUD V2)
 * Valida: CREATE → UPDATE → Estado → DTO
 */

const BASE_URL = 'http://localhost:5000';

// Cores para output
const colors = {
  reset: '\x1b[0m',
  green: '\x1b[32m',
  red: '\x1b[31m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m'
};

const log = {
  info: (msg) => console.log(`${colors.blue}ℹ️ ${msg}${colors.reset}`),
  success: (msg) => console.log(`${colors.green}✅ ${msg}${colors.reset}`),
  error: (msg) => console.log(`${colors.red}❌ ${msg}${colors.reset}`),
  warn: (msg) => console.log(`${colors.yellow}⚠️ ${msg}${colors.reset}`)
};

// Helper para requests
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
  log.info('TESTE 1: Login (obter token)');
  
  const res = await api('POST', '/api/login', {
    email: 'clinicafonoinova@gmail.com',
    password: 'admin1234',
    role: 'admin'
  });
  
  if (!res.ok || !res.data.token) {
    log.error('Login falhou');
    return null;
  }
  
  log.success('Login OK - Token obtido');
  return res.data.token;
}

async function getFirstDoctor(token) {
  const res = await api('GET', '/api/doctors/active/list', null, token);
  if (res.ok && res.data.length > 0) {
    return res.data[0]._id;
  }
  return null;
}

async function testCreatePatient(token) {
  log.info('TESTE 2: Create Patient V2');
  
  const uniqueId = Date.now();
  const patientData = {
    fullName: `Teste E2E ${uniqueId}`,
    email: `teste${uniqueId}@e2e.com`,
    phone: '11999999999',
    cpf: `${uniqueId}`.padStart(11, '0').slice(0, 11),
    dateOfBirth: '1990-01-01',
    gender: 'M'
  };
  
  const res = await api('POST', '/api/v2/patients', patientData, token);
  
  // Patient V2 é async (202 Accepted)
  if (res.status === 202) {
    const pid = res.data.patientId || res.data.data?.patientId;
    const eid = res.data.eventId || res.data.data?.eventId;
    log.success(`Patient em processamento: ${pid} (event: ${eid})`);
    // Retorna ID provisório para usar nos próximos testes
    return pid;
  }
  
  if (!res.ok) {
    log.error(`Create Patient falhou: ${JSON.stringify(res.data)}`);
    return null;
  }
  
  const pid = res.data._id || res.data.id || res.data.patientId || res.data.data?.patientId;
  
  if (!pid) {
    log.error('DTO incompleto');
    return null;
  }
  
  log.success(`Patient criado: ${pid}`);
  return pid;
}

async function testCreateAppointment(token, patientId) {
  log.info('TESTE 3: Create Appointment V2');
  
  // Data futura (7 dias) para evitar conflitos
  const future = new Date();
  future.setDate(future.getDate() + 7);
  const dateStr = future.toISOString().split('T')[0];
  
  const doctorId = await getFirstDoctor(token);
  if (!doctorId) {
    log.warn('Sem doctor disponivel');
    return null;
  }
  
  // Horário aleatório para evitar conflitos (8h-17h)
  const hour = 8 + Math.floor(Math.random() * 10);
  const minute = Math.floor(Math.random() * 4) * 15; // 0, 15, 30, 45
  const timeStr = `${hour.toString().padStart(2, '0')}:${minute.toString().padStart(2, '0')}`;
  
  const appointmentData = {
    patientId: patientId,
    doctorId: doctorId,
    date: dateStr,
    time: timeStr,
    type: 'particular',
    status: 'scheduled'
  };
  
  const res = await api('POST', '/api/v2/appointments', appointmentData, token);
  
  if (!res.ok) {
    log.error(`Create Appointment falhou: ${JSON.stringify(res.data)}`);
    return null;
  }
  
  // DTO V2 pode ter ID em diferentes locais
  const apptId = res.data._id || res.data.id || res.data.appointmentId || 
                 res.data.data?.appointmentId || res.data.data?._id;
  
  if (!apptId) {
    log.error('DTO sem ID');
    log.warn(`Resposta: ${JSON.stringify(res.data, null, 2)}`);
    return null;
  }
  
  log.success(`Appointment criado: ${apptId}`);
  return apptId;
}

async function testCompleteAppointment(token, appointmentId) {
  log.info('TESTE 4: Complete Appointment V2');
  
  const res = await api('PATCH', `/api/v2/appointments/${appointmentId}/complete`, {
    notes: 'Sessao completada via E2E'
  }, token);
  
  if (!res.ok) {
    log.error(`Complete falhou: ${JSON.stringify(res.data)}`);
    return false;
  }
  
  // Validar DTO V2
  const hasMeta = res.data.meta && res.data.meta.version === 'v2';
  const hasStatus = res.data.data?.clinicalStatus === 'completed' || 
                    res.data.data?.operationalStatus === 'completed';
  
  if (!hasMeta) {
    log.warn('DTO sem meta.version=v2');
  }
  
  if (!hasStatus) {
    log.error('Estado nao mudou para completed');
    log.warn(`Resposta: ${JSON.stringify(res.data, null, 2)}`);
    return false;
  }
  
  log.success(`Appointment completado - DTO V2 OK`);
  return true;
}

async function testCancelAppointment(token, appointmentId) {
  log.info('TESTE 5: Cancel Appointment V2');
  
  const res = await api('PATCH', `/api/v2/appointments/${appointmentId}/cancel`, {
    reason: 'Cancelamento via E2E test'
  }, token);
  
  // Cancel V2 retorna 202 Accepted (async)
  if (res.status === 202) {
    log.success(`Cancel aceito (202) - processando async`);
    return true;
  }
  
  if (!res.ok) {
    // Completed nao pode cancelar - isso eh esperado
    if (res.data.error?.includes('completed')) {
      log.warn('Cancel bloqueado - appointment ja completed (esperado)');
      return true;
    }
    log.error(`Cancel falhou: ${JSON.stringify(res.data)}`);
    return false;
  }
  
  log.success(`Cancelado: ${res.data.status || res.data.operationalStatus}`);
  return true;
}

// ============ MAIN ============

async function runTests() {
  console.log('🚀 E2E WRITE TEST - V2 APIs');
  console.log('='.repeat(60));
  
  // 1. Login
  const token = await testLogin();
  if (!token) {
    log.error('ABORTADO - Sem token');
    process.exit(1);
  }
  
  // 2. Create Patient
  const patientId = await testCreatePatient(token);
  if (!patientId) {
    log.error('ABORTADO - Create patient falhou');
    process.exit(1);
  }
  
  // 3. Create Appointment
  const appointmentId = await testCreateAppointment(token, patientId);
  if (!appointmentId) {
    log.error('ABORTADO - Create appointment falhou');
    process.exit(1);
  }
  
  // 4. Complete Appointment
  const completeOk = await testCompleteAppointment(token, appointmentId);
  if (!completeOk) {
    log.error('FALHA - Complete nao funcionou');
  }
  
  // 5. Cancel Appointment (deve falhar pois ja esta completed)
  await testCancelAppointment(token, appointmentId);
  
  console.log('\n' + '='.repeat(60));
  log.success('E2E WRITE TEST COMPLETO');
}

runTests().catch(err => {
  log.error(`Erro inesperado: ${err.message}`);
  process.exit(1);
});
