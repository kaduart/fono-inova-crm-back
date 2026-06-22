// back/tests/smoke/appointment-v2-smoke.js
/**
 * Smoke test manual para o router V2 de agendamentos.
 *
 * Requisitos:
 *   - Backend rodando em localhost:5000 (ou API_URL env)
 *   - Variável AGENDA_EXPORT_TOKEN configurada no .env para reads e writes com flexibleAuth
 *   - Para writes protegidas por `auth` (PUT /:id, PATCH clinical-status) é necessário
 *     um JWT válido. O script tenta obtê-lo via POST /api/login quando as credenciais
 *     forem fornecidas via env LOGIN_EMAIL / LOGIN_PASSWORD / LOGIN_ROLE, ou pode receber
 *     um token pronto via env TEST_JWT_TOKEN.
 *
 * Modo seguro (padrão): executa apenas operações de leitura.
 * Modo destrutivo: adicione a flag --destructive para testar create/update/cancel/delete.
 *   Recomenda-se rodar contra banco de desenvolvimento/teste.
 */

import axios from 'axios';
import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import path from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
dotenv.config({ path: path.resolve(__dirname, '../../.env') });

const API_URL = process.env.API_URL || 'http://localhost:5000';
const SERVICE_TOKEN = process.env.AGENDA_EXPORT_TOKEN;

const destructive = process.argv.includes('--destructive');

const results = [];

function api(token) {
  const client = axios.create({
    baseURL: API_URL,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    validateStatus: () => true,
  });

  client.interceptors.request.use((config) => {
    // eslint-disable-next-line no-console
    console.log(`→ ${config.method.toUpperCase()} ${config.url}`);
    return config;
  });

  return client;
}

async function record(name, fn, validator) {
  try {
    const result = await fn();
    const validationError = validator ? validator(result) : null;
    if (validationError) {
      results.push({ name, ok: false, error: validationError, response: summarize(result?.data) });
      console.log(`  ❌ ${name}: ${validationError}`);
      return result;
    }
    results.push({ name, ok: true, status: result?.status, dataSummary: summarize(result?.data) });
    console.log(`  ✅ ${name}`);
    return result;
  } catch (err) {
    results.push({ name, ok: false, error: err.message, response: summarize(err.response?.data) });
    console.log(`  ❌ ${name}: ${err.message}`);
    return null;
  }
}

const expectSuccess = (res) => {
  if (res.status < 200 || res.status >= 300) return `HTTP ${res.status}`;
  if (res.data && typeof res.data === 'object' && 'success' in res.data && res.data.success !== true) {
    return `success=false: ${summarize(res.data)}`;
  }
  return null;
};

const expect2xx = (res) => {
  if (res.status < 200 || res.status >= 300) return `HTTP ${res.status}`;
  return null;
};

function summarize(data) {
  if (!data) return null;
  const text = JSON.stringify(data);
  return text.length > 200 ? `${text.slice(0, 200)}...` : text;
}

async function login() {
  if (process.env.TEST_JWT_TOKEN) {
    console.log('Usando TEST_JWT_TOKEN fornecido.');
    return process.env.TEST_JWT_TOKEN;
  }

  if (!process.env.LOGIN_EMAIL || !process.env.LOGIN_PASSWORD) {
    console.log('Credenciais LOGIN_EMAIL/LOGIN_PASSWORD não fornecidas. Writes com `auth` serão pulados.');
    return null;
  }

  try {
    const res = await axios.post(`${API_URL}/api/login`, {
      email: process.env.LOGIN_EMAIL,
      password: process.env.LOGIN_PASSWORD,
      role: process.env.LOGIN_ROLE || 'admin',
    }, { validateStatus: () => true });

    if (res.status >= 200 && res.status < 300 && res.data?.token) {
      console.log('JWT obtido via /api/login');
      return res.data.token;
    }

    console.log('Falha ao obter JWT:', summarize(res.data));
    return null;
  } catch (err) {
    console.log('Erro no login:', err.message);
    return null;
  }
}

async function runReadSmoke(http, jwtToken) {
  console.log('\n=== READ SMOKE TESTS ===\n');

  const authHttp = jwtToken ? api(jwtToken) : null;

  const list = await record('GET /api/v2/appointments (list)', () => http.get('/api/v2/appointments?limit=1'), expect2xx);
  const sampleId = list?.data?.[0]?.id || list?.data?.[0]?._id;
  const samplePatientId = list?.data?.[0]?.patient?._id || list?.data?.[0]?.patient;

  await record('GET /api/v2/appointments/available-slots', () =>
    http.get('/api/v2/appointments/available-slots?doctorId=684072213830f473da1b0b0b&date=2026-06-25'),
    expectSuccess
  );

  if (sampleId) {
    await record('GET /api/v2/appointments/:id', () => http.get(`/api/v2/appointments/${sampleId}`), expect2xx);
    await record('GET /api/v2/appointments/:id/status', () => http.get(`/api/v2/appointments/${sampleId}/status`), expectSuccess);
  } else {
    console.log('  ⚠️ Nenhum agendamento encontrado para testar GET /:id');
  }

  if (samplePatientId) {
    await record('GET /api/v2/appointments/history/:patientId', () =>
      http.get(`/api/v2/appointments/history/${samplePatientId}`),
      expectSuccess
    );
  }

  await record('GET /api/v2/appointments/with-appointments', () => http.get('/api/v2/appointments/with-appointments'), expectSuccess);

  if (authHttp) {
    await record('GET /api/v2/appointments/by-specialty/fonoaudiologia', () =>
      authHttp.get('/api/v2/appointments/by-specialty/fonoaudiologia'),
      expect2xx
    );
    await record('GET /api/v2/appointments/count-by-status', () => authHttp.get('/api/v2/appointments/count-by-status'), expectSuccess);
    await record('GET /api/v2/appointments/stats', () => authHttp.get('/api/v2/appointments/stats'), expectSuccess);
  } else {
    console.log('  ⚠️ Puladas rotas protegidas por `auth` (forneça LOGIN_EMAIL/LOGIN_PASSWORD ou JWT)');
  }

  return { sampleId, samplePatientId };
}

async function runCriticalScenarios(authHttp) {
  console.log('\n=== CRITICAL SCENARIOS ===\n');

  const testPackageId = process.env.TEST_PACKAGE_ID || '68fa8c584862040e3c0636e8';
  const testPackagePatientId = process.env.TEST_PACKAGE_PATIENT_ID || '686e7f2bb26f4da03d426e7b';
  const testDoctorId = process.env.TEST_DOCTOR_ID || '684072213830f473da1b0b0b';
  const testDate = process.env.TEST_DATE || '2026-12-30';

  // 1. Criar agendamento de pacote
  const createRes = await record('Cenário 1: POST package_session', () =>
    authHttp.post('/api/v2/appointments', {
      patientId: testPackagePatientId,
      doctorId: testDoctorId,
      date: testDate,
      time: '10:00',
      specialty: 'fonoaudiologia',
      serviceType: 'package_session',
      packageId: testPackageId,
      billingType: 'particular',
      paymentMethod: 'dinheiro',
      paymentAmount: 0,
    }),
    expectSuccess
  );

  const createdId = createRes?.data?.data?._id || createRes?.data?.data?.id;
  if (!createdId) {
    console.log('  ⚠️ Cenário 1 falhou: agendamento de pacote não foi criado');
    return;
  }

  // 2. Cancelar e validar remainingSessions +1
  const beforeCancel = await authHttp.get(`/api/v2/appointments/${createdId}`);
  const packageBefore = beforeCancel?.data?.package?.remainingSessions ?? beforeCancel?.data?.package?.balance;

  await record('Cenário 2: PATCH cancel (deve incrementar remainingSessions)', () =>
    authHttp.patch(`/api/v2/appointments/${createdId}/cancel`, { reason: 'smoke test critical' }),
    expectSuccess
  );

  const afterCancel = await authHttp.get(`/api/v2/appointments/${createdId}`);
  const packageAfter = afterCancel?.data?.package?.remainingSessions ?? afterCancel?.data?.package?.balance;

  if (packageAfter !== undefined && packageBefore !== undefined && packageAfter <= packageBefore) {
    results.push({
      name: 'Cenário 2 validação: remainingSessions incrementou',
      ok: false,
      error: `remainingSessions não incrementou: ${packageBefore} -> ${packageAfter}`,
    });
    console.log(`  ❌ Cenário 2 validação: remainingSessions não incrementou (${packageBefore} -> ${packageAfter})`);
  } else if (packageAfter !== undefined) {
    results.push({ name: 'Cenário 2 validação: remainingSessions incrementou', ok: true });
    console.log(`  ✅ Cenário 2 validação: remainingSessions incrementou (${packageBefore} -> ${packageAfter})`);
  }

  // 3. Reativar e validar paymentStatus
  const reactivateRes = await record('Cenário 3: PUT reativar cancelado', () =>
    authHttp.put(`/api/v2/appointments/${createdId}`, {
      patientId: testPackagePatientId,
      doctorId: testDoctorId,
      date: testDate,
      time: '10:00',
      operationalStatus: 'scheduled',
    }),
    expectSuccess
  );

  const paymentStatus = reactivateRes?.data?.data?.paymentStatus;

  if (paymentStatus !== 'package_paid') {
    results.push({
      name: 'Cenário 3 validação: paymentStatus = package_paid após reativação',
      ok: false,
      error: `paymentStatus atual: ${paymentStatus}`,
    });
    console.log(`  ❌ Cenário 3 validação: paymentStatus = ${paymentStatus} (esperado package_paid)`);
  } else {
    results.push({ name: 'Cenário 3 validação: paymentStatus = package_paid após reativação', ok: true });
    console.log(`  ✅ Cenário 3 validação: paymentStatus = ${paymentStatus}`);
  }

  // Limpeza: agendamentos de pacote não podem ser deletados (regra de integridade)
  // Re-cancelamos para deixar o registro em estado consistente
  await record('Limpeza: re-cancelar cenário crítico', () =>
    authHttp.patch(`/api/v2/appointments/${createdId}/cancel`, { reason: 'smoke test cleanup' }),
    expectSuccess
  );
}

async function runWriteSmoke(http, jwtToken) {
  if (!destructive) {
    console.log('\n=== WRITE SMOKE TESTS (puladas; adicione --destructive) ===\n');
    return;
  }

  console.log('\n=== WRITE SMOKE TESTS ===\n');

  const authHttp = api(jwtToken || SERVICE_TOKEN);

  const testPatientId = process.env.TEST_PATIENT_ID || '6840a4e2928a20e92ab13a52';
  const testDoctorId = process.env.TEST_DOCTOR_ID || '684072213830f473da1b0b0b';
  const testDate = process.env.TEST_DATE || '2026-12-31';

  const createRes = await record('POST /api/v2/appointments (create)', () =>
    authHttp.post('/api/v2/appointments', {
      patientId: testPatientId,
      doctorId: testDoctorId,
      date: testDate,
      time: '09:00',
      specialty: 'fonoaudiologia',
      serviceType: 'individual_session',
      billingType: 'particular',
      paymentMethod: 'pix',
      paymentAmount: 100,
    })
  );

  const createdId = createRes?.data?.data?._id || createRes?.data?.data?.id;

  if (createdId && jwtToken) {
    await record('PUT /api/v2/appointments/:id (update)', () =>
      authHttp.put(`/api/v2/appointments/${createdId}`, {
        notes: 'Smoke test update',
      })
    );

    await record('PATCH /api/v2/appointments/:id/clinical-status', () =>
      authHttp.patch(`/api/v2/appointments/${createdId}/clinical-status`, { status: 'in_progress' })
    );
  }

  if (createdId) {
    await record('PATCH /api/v2/appointments/:id/confirm', () =>
      authHttp.patch(`/api/v2/appointments/${createdId}/confirm`)
    );

    await record('PATCH /api/v2/appointments/:id/cancel', () =>
      authHttp.patch(`/api/v2/appointments/${createdId}/cancel`, { reason: 'smoke test' })
    );

    await record('PATCH /api/v2/appointments/:id/post-appointment', () =>
      authHttp.patch(`/api/v2/appointments/${createdId}/post-appointment`, { step: 'msg1' })
    );

    await record('DELETE /api/v2/appointments/:id (delete)', () =>
      authHttp.delete(`/api/v2/appointments/${createdId}`)
    );
  }

  if (jwtToken) {
    await runCriticalScenarios(authHttp);
  } else {
    console.log('\n  ⚠️ Cenários críticos de pacote pulados (JWT necessário para reativação)');
  }
}

async function run() {
  if (!SERVICE_TOKEN) {
    console.error('AGENDA_EXPORT_TOKEN não encontrado no .env');
    process.exit(1);
  }

  console.log(`Smoke target: ${API_URL}`);
  console.log(`Destructive mode: ${destructive}`);

  const http = api(SERVICE_TOKEN);
  const jwtToken = await login();
  const { sampleId, samplePatientId } = await runReadSmoke(http, jwtToken);

  await runWriteSmoke(http, jwtToken);

  console.log('\n=== RESUMO ===');
  const ok = results.filter((r) => r.ok).length;
  const failed = results.filter((r) => !r.ok);
  console.log(`Total: ${results.length} | ✅ ${ok} | ❌ ${failed.length}`);

  if (failed.length > 0) {
    console.log('\nFalhas:');
    for (const f of failed) {
      console.log(`  - ${f.name}: ${f.error || f.response}`);
    }
  }

  if (failed.length > 0) {
    process.exit(1);
  }
}

run().catch((err) => {
  console.error('Erro fatal no smoke test:', err);
  process.exit(1);
});
