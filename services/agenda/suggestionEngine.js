import { format, addDays, parseISO, startOfDay, isWeekend } from 'date-fns';
import { ptBR } from 'date-fns/locale';
import Appointment from '../../models/Appointment.js';
import Doctor from '../../models/Doctor.js';
import Patient from '../../models/Patient.js';

const WORKING_HOURS_DEFAULT = [
  '08:00', '09:00', '10:00', '11:00',
  '14:00', '15:00', '16:00', '17:00'
];

const DAYS_EN = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];

/**
 * 🧠 SMART AGENDA v1 — Motor de sugestão de horários
 *
 * Regra: sistema sugere, secretaria confirma.
 * Frontend pode enviar doctorId (específico) ou specialty (qualquer médico da especialidade).
 */
export async function generateSuggestedSlots({
  doctorId,
  specialty,
  patientId,
  serviceType = 'session',
  dateFrom,
  dateTo,
  maxResults = 5
}) {
  const start = dateFrom ? parseISO(dateFrom) : new Date();
  const end = dateTo ? parseISO(dateTo) : addDays(start, 7);

  // ── 1. RESOLVER MÉDICOS ────────────────────────────────────
  let doctors = [];
  if (doctorId) {
    const doc = await Doctor.findById(doctorId).lean();
    if (doc) doctors = [doc];
  } else if (specialty) {
    doctors = await Doctor.find({
      specialty: specialty.toLowerCase(),
      active: true
    }).lean();
  } else {
    throw new Error('doctorId ou specialty é obrigatório');
  }

  if (!doctors.length) {
    throw new Error('Nenhum profissional encontrado');
  }

  const doctorIds = doctors.map(d => d._id.toString());

  // ── 2. BUSCAR AGENDAMENTOS EXISTENTES ──────────────────────
  const occupiedQuery = {
    doctor: { $in: doctorIds },
    date: { $gte: startOfDay(start), $lte: addDays(end, 1) },
    operationalStatus: { $nin: ['canceled', 'missed', 'pre_agendado'] }
  };

  const appointments = await Appointment.find(occupiedQuery)
    .select('doctor date time duration operationalStatus')
    .lean();

  const occupiedSet = new Set(
    appointments.map(a => `${format(a.date, 'yyyy-MM-dd')}_${a.time}_${a.doctor.toString()}`)
  );

  // ── 3. BUSCAR HISTÓRICO DO PACIENTE ────────────────────────
  let patientHistory = [];
  if (patientId) {
    patientHistory = await Appointment.find({
      patient: patientId,
      operationalStatus: { $nin: ['canceled', 'missed', 'pre_agendado'] }
    })
      .sort({ date: -1 })
      .limit(10)
      .select('date time doctor')
      .lean();
  }

  const patientPreferredTimes = patientHistory.reduce((acc, h) => {
    const time = h.time || '09:00';
    acc[time] = (acc[time] || 0) + 1;
    return acc;
  }, {});

  const patientPreferredDoctors = patientHistory.reduce((acc, h) => {
    const docId = h.doctor?.toString();
    if (docId) acc[docId] = (acc[docId] || 0) + 1;
    return acc;
  }, {});

  // ── 4. GERAR SLOTS + SCORE ─────────────────────────────────
  const slots = [];
  let cursor = new Date(start);

  while (cursor <= end) {
    const dateStr = format(cursor, 'yyyy-MM-dd');
    const dayOfWeek = DAYS_EN[cursor.getDay()];

    // Pular fins de semana
    if (isWeekend(cursor)) {
      cursor = addDays(cursor, 1);
      continue;
    }

    for (const doctor of doctors) {
      const availability = doctor.weeklyAvailability?.find(a => a.day === dayOfWeek);
      const workingHours = availability?.times?.length
        ? availability.times
        : WORKING_HOURS_DEFAULT;

      for (const time of workingHours) {
        const key = `${dateStr}_${time}_${doctor._id.toString()}`;
        if (occupiedSet.has(key)) continue;

        const score = calculateScore({
          doctor,
          patientId,
          patientPreferredTimes,
          patientPreferredDoctors,
          dateStr,
          time,
          serviceType
        });

        slots.push({
          date: dateStr,
          time,
          doctorId: doctor._id.toString(),
          doctorName: doctor.fullName,
          specialty: doctor.specialty,
          score,
          reason: buildReason(score),
          isPreferredTime: !!patientPreferredTimes[time],
          isPreferredDoctor: !!patientPreferredDoctors[doctor._id.toString()]
        });
      }
    }

    cursor = addDays(cursor, 1);
  }

  return slots
    .sort((a, b) => b.score - a.score)
    .slice(0, maxResults);
}

function calculateScore({
  doctor,
  patientId,
  patientPreferredTimes,
  patientPreferredDoctors,
  dateStr,
  time,
  serviceType
}) {
  let score = 60; // base: slot livre e válido

  // +20: horário dentro da disponibilidade real do médico (já filtrado, mas reforça)
  const dayOfWeek = new Date(dateStr).getDay();
  const availability = doctor.weeklyAvailability?.find(a => a.day === DAYS_EN[dayOfWeek]);
  if (availability?.times?.includes(time)) {
    score += 20;
  }

  // +15: paciente já veio nesse horário antes (padrão de retorno)
  if (patientId && patientPreferredTimes[time]) {
    score += 15;
  }

  // +10: paciente já atendeu com esse médico antes
  if (patientId && patientPreferredDoctors[doctor._id.toString()]) {
    score += 10;
  }

  // +10: manhã tem melhor adesão (9-11h)
  const hour = parseInt(time.split(':')[0], 10);
  if (hour >= 9 && hour <= 11) {
    score += 10;
  } else if (hour >= 14 && hour <= 16) {
    score += 5;
  }

  // +5: próximo horário (hoje ou amanhã)
  const slotDate = parseISO(dateStr);
  const today = startOfDay(new Date());
  const diffDays = Math.floor((slotDate - today) / (1000 * 60 * 60 * 24));
  if (diffDays <= 1) {
    score += 5;
  }

  // Serviços específicos
  if (serviceType === 'evaluation' && hour >= 8 && hour <= 10) {
    score += 5; // avaliações preferencialmente de manhã
  }

  return Math.min(score, 100);
}

function buildReason(score) {
  if (score >= 90) return 'Slot ideal — alta chance de comparecimento';
  if (score >= 80) return 'Horário preferido do paciente ou médico';
  if (score >= 70) return 'Bom horário com boa adesão histórica';
  if (score >= 60) return 'Slot disponível e dentro da jornada';
  return 'Slot alternativo';
}
