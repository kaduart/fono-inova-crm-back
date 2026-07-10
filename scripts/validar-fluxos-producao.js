/**
 * Script de validação dos fluxos críticos em produção.
 *
 * Usa o backend local (localhost:5000) conectado ao MongoDB/Redis de produção.
 * Registra todos os IDs criados para limpeza posterior.
 */

import fs from 'fs/promises';
import path from 'path';
import mongoose from 'mongoose';
import IORedis from 'ioredis';

const BASE_URL = 'http://localhost:5000';
const SERVICE_TOKEN = process.env.ADMIN_API_TOKEN || 'amanda_service_token_fono_inova_2025_secure_xyz789';
const USER_TOKEN = process.env.USER_JWT_TOKEN || ''; // JWT de admin para rotas com middleware 'auth'
const PATIENT_ID = '6a285cfa7681a873d5c6a00b'; // ana teste 2

const created = {
  patientId: PATIENT_ID,
  patients: [],
  appointments: [],
  sessions: [],
  payments: [],
  packages: [],
  insuranceGuides: [],
  liminarContracts: [],
  outboxEvents: [],
  queueJobs: [],
  logs: []
};

function log(step, message, data = null) {
  const entry = { step, message, data: data ? JSON.parse(JSON.stringify(data)) : null, at: new Date().toISOString() };
  created.logs.push(entry);
  console.log(`[${step}] ${message}`, data ? JSON.stringify(data).substring(0, 300) : '');
}

async function request(method, endpoint, body = null, token = SERVICE_TOKEN, timeoutMs = 60000) {
  const url = `${BASE_URL}${endpoint}`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  const options = {
    method,
    signal: controller.signal,
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json'
    }
  };
  if (body) options.body = JSON.stringify(body);

  try {
    const res = await fetch(url, options);
    const text = await res.text();
    let data = null;
    try {
      data = JSON.parse(text);
    } catch {
      data = { raw: text.substring(0, 500) };
    }
    return { status: res.status, data };
  } finally {
    clearTimeout(timeout);
  }
}

async function authRequest(method, endpoint, body = null) {
  if (!USER_TOKEN) {
    throw new Error('USER_JWT_TOKEN não definido. Defina um token JWT de admin válido.');
  }
  return request(method, endpoint, body, USER_TOKEN);
}

async function getActiveDoctor(specialty = 'fonoaudiologia') {
  const { data } = await request('GET', '/api/v2/doctors/active');
  const doctors = data?.data?.doctors || [];
  const doctor = doctors.find(d => d.specialty === specialty) || doctors[0];
  if (!doctor) throw new Error('Nenhum médico ativo encontrado');
  log('DOCTOR', 'Médico selecionado', { doctorId: doctor._id, specialty: doctor.specialty, name: doctor.fullName });
  return doctor._id;
}

async function getAvailableSlots(dateStr, doctorId) {
  const { data } = await request('GET', `/api/v2/appointments/available-slots?doctorId=${doctorId}&date=${dateStr}`);
  const slots = Array.isArray(data) ? data : (data?.slots || data?.data?.slots || []);
  return slots.filter(s => s.available !== false).map(s => s.time || s);
}

async function createAppointment(payload, attempt = 0) {
  const res = await request('POST', '/api/v2/appointments', payload);
  log('CREATE_APPOINTMENT', `status=${res.status} time=${payload.time}`, res.data);

  if (!res.data?.success) {
    if (res.data?.error === 'Conflito de agenda médica' && attempt < 8) {
      const [h, m] = payload.time.split(':').map(Number);
      const next = new Date();
      next.setHours(h, m + 40, 0, 0);
      payload.time = `${String(next.getHours()).padStart(2, '0')}:${String(next.getMinutes()).padStart(2, '0')}`;
      log('CREATE_APPOINTMENT', `Conflito, tentando ${payload.time}`);
      return createAppointment(payload, attempt + 1);
    }
    throw new Error(`Falha ao criar agendamento: ${JSON.stringify(res.data)}`);
  }

  const appointment = res.data.data;
  created.appointments.push(appointment._id);
  if (appointment.session?._id) created.sessions.push(appointment.session._id);
  if (appointment.payment?._id) created.payments.push(appointment.payment._id);

  return appointment;
}

async function completeAppointment(appointmentId) {
  const res = await authRequest('PATCH', `/api/v2/appointments/${appointmentId}/complete`);
  log('COMPLETE_APPOINTMENT', `status=${res.status}`, res.data);
  if (!res.data?.success) {
    throw new Error(`Falha ao completar agendamento: ${JSON.stringify(res.data)}`);
  }
  const appt = res.data.data || res.data.appointment;
  if (!appt) {
    throw new Error(`Resposta de complete não contém agendamento: ${JSON.stringify(res.data)}`);
  }
  return {
    appointmentId: appt._id,
    sessionId: appt.session?._id || appt.session
  };
}

async function cancelAppointment(appointmentId) {
  const res = await request('PATCH', `/api/v2/appointments/${appointmentId}/cancel`, {
    reason: 'Cancelado em validação de produção'
  });
  log('CANCEL_APPOINTMENT', `status=${res.status}`, res.data);
  if (!res.data?.success) {
    throw new Error(`Falha ao cancelar agendamento: ${JSON.stringify(res.data)}`);
  }
  return res.data.data;
}

async function inspectOutbox(aggregateId, eventType = null, maxAttempts = 120) {
  const Outbox = (await import('../infrastructure/outbox/OutboxModel.js')).default;

  for (let i = 0; i < maxAttempts; i++) {
    const query = { aggregateId };
    if (eventType) query.eventType = eventType;
    const events = await Outbox.find(query).sort({ createdAt: -1 }).limit(5).lean();

    const published = events.filter(e => e.status === 'published');
    if (published.length > 0) {
      log('OUTBOX', 'Evento publicado encontrado', { aggregateId, eventType, events: published.map(e => ({ eventType: e.eventType, status: e.status, eventId: e.eventId })) });
      created.outboxEvents.push(...published.map(e => e.eventId));
      return published;
    }
    await new Promise(r => setTimeout(r, 500));
  }

  log('OUTBOX', 'Nenhum evento publicado encontrado a tempo', { aggregateId, eventType });
  return [];
}

async function createPackage(payload, attempt = 0) {
  const res = await request('POST', '/api/v2/packages', payload);
  log('CREATE_PACKAGE', `status=${res.status}`, res.data);
  if (!res.data?.success) {
    throw new Error(`Falha ao criar pacote: ${JSON.stringify(res.data)}`);
  }
  const pkg = res.data.data;
  created.packages.push(pkg._id || pkg.packageId);
  if (pkg.appointments) {
    for (const appt of pkg.appointments) {
      created.appointments.push(appt._id || appt);
    }
  }
  if (pkg.sessions) {
    for (const sess of pkg.sessions) {
      created.sessions.push(sess._id || sess);
    }
  }
  return pkg;
}

async function createInsuranceGuide(payload) {
  const res = await authRequest('POST', '/api/v2/insurance-guides', payload);
  log('CREATE_INSURANCE_GUIDE', `status=${res.status}`, res.data);
  if (!res.data?.success && !res.data?.guide) {
    throw new Error(`Falha ao criar guia de convênio: ${JSON.stringify(res.data)}`);
  }
  const guide = res.data.guide || res.data.data;
  const guideId = guide?._id || guide?.id || guide?.guideId;
  if (guideId) created.insuranceGuides.push(guideId);
  if (guide.appointment?._id) created.appointments.push(guide.appointment._id);
  if (guide.evaluationPayment?._id) created.payments.push(guide.evaluationPayment._id);
  return guide;
}

async function createLiminarContract(payload) {
  const res = await request('POST', '/api/v2/liminar-contracts', payload);
  log('CREATE_LIMINAR_CONTRACT', `status=${res.status}`, res.data);
  if (!res.data?.contract) {
    throw new Error(`Falha ao criar contrato liminar: ${JSON.stringify(res.data)}`);
  }
  created.liminarContracts.push(res.data.contract._id);
  return res.data.contract;
}

async function createTherapeuticPlanForValidation(contractId, therapies) {
  const res = await request('POST', `/api/v2/liminar-contracts/${contractId}/plans`, { therapies });
  log('CREATE_THERAPEUTIC_PLAN', `status=${res.status}`, res.data);
  if (!res.data?.plan) {
    throw new Error(`Falha ao criar plano terapêutico: ${JSON.stringify(res.data)}`);
  }
  return res.data.plan;
}

async function generateLiminarSessionsForValidation(planId, weeks = 2) {
  const res = await request('POST', `/api/v2/liminar-contracts/IGNORE/plans/${planId}/generate-sessions`, { weeks });
  log('GENERATE_LIMINAR_SESSIONS', `status=${res.status}`, res.data);
  const appointments = res.data?.appointments || res.data?.createdAppointments || [];
  if (!appointments.length && !res.data?.total) {
    throw new Error(`Falha ao gerar sessões liminar: ${JSON.stringify(res.data)}`);
  }
  for (const appt of appointments) {
    created.appointments.push(appt._id || appt);
  }
  return res.data;
}

async function patchPayment(paymentId, payload) {
  const res = await authRequest('PATCH', `/api/v2/payments/${paymentId}`, payload);
  log('PATCH_PAYMENT', `status=${res.status}`, res.data);
  if (!res.data?.success) {
    throw new Error(`Falha ao atualizar pagamento: ${JSON.stringify(res.data)}`);
  }
  return res.data.data;
}

async function loadState(outputFile) {
  try {
    const raw = await fs.readFile(outputFile, 'utf8');
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

async function main() {
  const outputFile = path.resolve(process.cwd(), 'validacao-producao-ids.json');
  const previous = await loadState(outputFile);
  if (previous) {
    Object.assign(created, previous);
    log('RESUME', 'Continuando de execução anterior', { appointments: previous.appointments });
  }

  try {
    log('START', 'Iniciando validação dos fluxos críticos', { baseUrl: BASE_URL, patientId: PATIENT_ID });

    await mongoose.connect(process.env.MONGO_URI);
    log('MONGODB', 'Conectado');

    const doctorId = await getActiveDoctor('fonoaudiologia');

    // Datas de teste (sextas futuras para evitar feriados)
    let baseDate = new Date();
    baseDate.setDate(baseDate.getDate() + ((5 + 7 - baseDate.getDay()) % 7 || 7));

    // Busca slots livres para as datas usadas, avançando sextas se necessário
    let dateStr, slotsDate, pkgDate1Str, slotsPkg1, pkgDate2Str, slotsPkg2;
    for (let attempt = 0; attempt < 8; attempt++) {
      dateStr = baseDate.toISOString().split('T')[0];

      const pkgDate1 = new Date(baseDate);
      pkgDate1.setDate(pkgDate1.getDate() + 21);
      pkgDate1Str = pkgDate1.toISOString().split('T')[0];

      const pkgDate2 = new Date(pkgDate1);
      pkgDate2.setDate(pkgDate2.getDate() + 7);
      pkgDate2Str = pkgDate2.toISOString().split('T')[0];

      slotsDate = await getAvailableSlots(dateStr, doctorId);
      slotsPkg1 = await getAvailableSlots(pkgDate1Str, doctorId);
      slotsPkg2 = await getAvailableSlots(pkgDate2Str, doctorId);

      if (slotsDate.length >= 3 && slotsPkg1.length >= 1 && slotsPkg2.length >= 1) break;

      log('SLOTS', `Slots insuficientes em ${dateStr}; tentando próxima sexta`, {
        slotsDate: slotsDate.length,
        slotsPkg1: slotsPkg1.length,
        slotsPkg2: slotsPkg2.length
      });
      baseDate.setDate(baseDate.getDate() + 7);
    }

    if (slotsDate.length < 3) throw new Error(`Slots insuficientes em ${dateStr}`);
    if (slotsPkg1.length < 1) throw new Error(`Slots insuficientes em ${pkgDate1Str}`);
    if (slotsPkg2.length < 1) throw new Error(`Slots insuficientes em ${pkgDate2Str}`);

    // FLUXO 1: Particular pago + completação
    log('FLUXO', '1. Particular pago + completação');
    let particular;
    if (created.appointments.length > 0) {
      particular = { _id: created.appointments[0] };
      log('REUSE', 'Reutilizando agendamento particular existente', { appointmentId: particular._id });
    } else {
      particular = await createAppointment({
        patientId: PATIENT_ID,
        doctorId,
        date: dateStr,
        time: slotsDate[0],
        specialty: 'fonoaudiologia',
        serviceType: 'individual_session',
        sessionType: 'individual',
        billingType: 'particular',
        paymentMethod: 'pix',
        paymentAmount: 200,
        notes: 'Validação Outbox - particular'
      });
    }
    await inspectOutbox(particular._id, 'APPOINTMENT_CREATED');

    const completedParticular = await completeAppointment(particular._id);
    await inspectOutbox(completedParticular.sessionId || particular._id, 'SESSION_COMPLETED');

    // FLUXO 2: Particular + cancelamento
    log('FLUXO', '2. Particular + cancelamento');
    let toCancel;
    if (created.appointments.length > 1) {
      toCancel = { _id: created.appointments[1] };
      log('REUSE', 'Reutilizando agendamento de cancelamento existente', { appointmentId: toCancel._id });
    } else {
      toCancel = await createAppointment({
        patientId: PATIENT_ID,
        doctorId,
        date: dateStr,
        time: slotsDate[1],
        specialty: 'fonoaudiologia',
        serviceType: 'individual_session',
        sessionType: 'individual',
        billingType: 'particular',
        paymentMethod: 'pix',
        paymentAmount: 200,
        notes: 'Validação Outbox - cancelamento'
      });
    }
    await cancelAppointment(toCancel._id);
    await inspectOutbox(toCancel._id, 'APPOINTMENT_CANCELLED');

    // FLUXO 3: Cadastro de paciente
    log('FLUXO', '3. Cadastro de paciente');
    if (created.patients.length === 0) {
      const newPatientRes = await request('POST', '/api/v2/patients', {
        fullName: `Validacao Outbox ${Date.now()}`,
        phone: `62999${String(Math.random()).slice(2, 8)}`,
        dateOfBirth: '2015-01-01',
        status: 'active'
      });
      log('CREATE_PATIENT', `status=${newPatientRes.status}`, newPatientRes.data);
      if (newPatientRes.data?.success) {
        const newPatientId = newPatientRes.data.data?.patientId || newPatientRes.data.data?._id || newPatientRes.data.data?.id;
        created.patients.push(newPatientId);
      }
    }
    if (created.patients.length > 0) {
      await inspectOutbox(created.patients[created.patients.length - 1], 'PATIENT_REGISTERED');
    }

    // FLUXO 4: Pacote (per-session)
    log('FLUXO', '4. Pacote per-session');
    let packageApptId = null;
    if (created.packages.length === 0) {
      const pkg = await createPackage({
        patientId: PATIENT_ID,
        doctorId,
        specialty: 'fonoaudiologia',
        sessionType: 'fonoaudiologia',
        totalSessions: 2,
        sessionValue: 180,
        type: 'package',
        model: 'per_session',
        schedule: [
          { date: pkgDate1Str, time: slotsPkg1[0] },
          { date: pkgDate2Str, time: slotsPkg2[0] }
        ],
        notes: 'Validação Outbox - pacote per-session'
      });
      await inspectOutbox(pkg._id || pkg.packageId, 'PACKAGE_CREATED');
      packageApptId = pkg.appointments?.[0]?._id || pkg.appointments?.[0];
    } else {
      const existingPkgId = created.packages[created.packages.length - 1];
      log('REUSE', 'Reutilizando pacote existente', { packageId: existingPkgId });
      const existingAppts = created.appointments.filter(a => ![
        created.appointments[0], created.appointments[1]
      ].includes(a));
      packageApptId = existingAppts[0];
    }
    if (packageApptId) {
      const completedPackage = await completeAppointment(packageApptId);
      await inspectOutbox(completedPackage.sessionId || packageApptId, 'SESSION_COMPLETED');
    }

    // FLUXO 5: Convênio (guia)
    log('FLUXO', '5. Convênio - criação de guia');
    if (created.insuranceGuides.length === 0) {
      const guideNumber = `VAL-${Date.now()}`;
      const guide = await createInsuranceGuide({
        number: guideNumber,
        patientId: PATIENT_ID,
        specialty: 'fonoaudiologia',
        insurance: 'unimed-anapolis',
        totalSessions: 5,
        expiresAt: new Date(Date.now() + 90 * 24 * 60 * 60 * 1000).toISOString(),
        sessionValue: 150,
        doctorId,
        notes: 'Validação Outbox - convênio'
      });
      await inspectOutbox(guide._id, 'INSURANCE_GUIDE_CREATED');
    } else {
      log('REUSE', 'Reutilizando guia de convênio existente', { guideId: created.insuranceGuides[created.insuranceGuides.length - 1] });
    }

    // FLUXO 6: Liminar
    log('FLUXO', '6. Liminar - contrato + plano + sessões');
    if (created.liminarContracts.length === 0) {
      const contract = await createLiminarContract({
        patientId: PATIENT_ID,
        doctorId,
        totalCredit: 1000,
        processNumber: `000${Date.now()}`,
        court: 'TJGO',
        mode: 'hybrid',
        receivedAt: new Date().toISOString()
      });
      const plan = await createTherapeuticPlanForValidation(contract._id, {
        fonoaudiologia: {
          doctor: doctorId,
          sessionValue: 200,
          sessionDurationMinutes: 40,
          slots: [
            { dayOfWeek: 1, time: '09:00' },
            { dayOfWeek: 3, time: '09:00' }
          ]
        }
      });
      await generateLiminarSessionsForValidation(plan._id, 2);
    } else {
      log('REUSE', 'Reutilizando contrato liminar existente', { contractId: created.liminarContracts[created.liminarContracts.length - 1] });
    }

    // FLUXO 7: Alteração de pagamento
    log('FLUXO', '7. Alteração de pagamento (pending -> paid)');
    let toChangePayment;
    if (created.appointments.length > 3) {
      const candidate = created.appointments[3];
      toChangePayment = { _id: candidate };
      log('REUSE', 'Reutilizando agendamento para alteração de pagamento', { appointmentId: toChangePayment._id });
    } else {
      toChangePayment = await createAppointment({
        patientId: PATIENT_ID,
        doctorId,
        date: dateStr,
        time: slotsDate[2],
        specialty: 'fonoaudiologia',
        serviceType: 'individual_session',
        sessionType: 'individual',
        billingType: 'particular',
        paymentMethod: 'pix',
        paymentAmount: 250,
        notes: 'Validação Outbox - alteração pagamento'
      });
    }
    const paymentToChange = toChangePayment.payment?._id || created.payments[created.payments.length - 1];
    if (paymentToChange) {
      await patchPayment(paymentToChange, { status: 'paid', paymentMethod: 'credit_card' });
      await inspectOutbox(paymentToChange, 'PAYMENT_STATUS_CHANGED');
    }

    log('END', 'Validação concluída. IDs registrados.', { outputFile });
  } catch (err) {
    log('ERROR', err.message, err.stack);
    throw err;
  } finally {
    await mongoose.disconnect();
    await fs.writeFile(outputFile, JSON.stringify(created, null, 2));
    console.log(`\nIDs salvos em: ${outputFile}`);
  }
}

main().catch(err => {
  console.error('Erro fatal:', err);
  process.exit(1);
});
