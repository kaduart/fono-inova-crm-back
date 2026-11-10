/**
 * Agendamento público (link da bio do Instagram / página /agendar do site).
 * Doc: docs/flows/public_booking_flow.md
 *
 * O que faz:
 *  - getOptions: dias com os horários livres (e períodos manhã/tarde), sem expor profissional.
 *  - createHold: trava o horário escolhido pela família (ou o primeiro livre do período, versão antiga) e cria um Appointment `pre_agendado`
 *    (mesmo formato do POST /api/agenda-externa/pre-agendar), que cai na triagem da secretária.
 *  - getStatus: status público por código curto, sem dado pessoal.
 *
 * O que NÃO faz: pagamento, sinal, lead, mensagem automática (Amanda) ou convênio/liminar.
 */
import Doctor from '../../models/Doctor.js';
import Patient from '../../models/Patient.js';
import Appointment from '../../models/Appointment.js';
import { calculateAvailableSlots, checkSlotOverlap } from '../../middleware/conflictDetection.js';
import { findPossibleDuplicates, pickReusableDuplicate } from '../../utils/patientDuplicateCheck.js';
import { publishEvent, EventTypes } from '../../infrastructure/events/eventPublisher.js';
import { safeRedis } from '../../config/redisConnection.js';
import { getIo } from '../../config/socket.js';
import {
  MAX_DAYS,
  addDaysYMD,
  dailyCap,
  dayLabel,
  displayText,
  generateBookingCode,
  isDateInWindow,
  maskPhone,
  originSourceFromUtm,
  periodsAvailability,
  pickSlotForPeriod,
  pickSlotForTime,
  publicTimes,
  publicStatusOf,
  todaySP,
} from './publicBookingRules.js';

const OPTIONS_CACHE_TTL = 60;
const ACTIVE_STATUSES = ['pre_agendado', 'scheduled', 'confirmed', 'paid'];
const DAY_KEYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];

export class PublicBookingError extends Error {
  constructor(code, status, extra = {}) {
    super(code);
    this.code = code;
    this.status = status;
    this.extra = extra;
  }
}

function dayKeyOf(ymd) {
  return DAY_KEYS[new Date(`${ymd}T12:00:00-03:00`).getUTCDay()];
}

/** Profissionais ativos da especialidade que têm horário configurado no dia da semana. */
async function doctorsForDay(specialty, ymd, cache) {
  if (!cache.doctors) {
    cache.doctors = await Doctor.find({ specialty, active: true })
      .select('_id fullName specialty weeklyAvailability')
      .lean();
  }
  const key = dayKeyOf(ymd);
  return cache.doctors.filter((d) => (d.weeklyAvailability || []).some((w) => w.day === key && (w.times || []).length));
}

async function candidatesForDay(specialty, ymd, cache = {}) {
  const doctors = await doctorsForDay(specialty, ymd, cache);
  const out = [];
  for (const d of doctors) {
    try {
      const slots = await calculateAvailableSlots(String(d._id), ymd);
      out.push({ doctorId: String(d._id), doctor: d, slots });
    } catch (err) {
      console.error('[PUBLIC-BOOKING] erro ao calcular horários', String(d._id), ymd, err.message);
    }
  }
  return out;
}

export async function getOptions({ specialty, from, days = 7, now = new Date() }) {
  const count = Math.min(Math.max(parseInt(days, 10) || 7, 1), MAX_DAYS);
  const first = addDaysYMD(todaySP(now), 1);
  const start = from && isDateInWindow(from, now) ? from : first;

  const cacheKey = `public-booking:options:${specialty}:${start}:${count}`;
  const cached = await safeRedis.get(cacheKey);
  if (cached) {
    try { return JSON.parse(cached); } catch { /* recalcula */ }
  }

  const cache = {};
  const result = [];
  for (let i = 0; i < count; i++) {
    const ymd = addDaysYMD(start, i);
    if (!isDateInWindow(ymd, now)) break;
    const candidates = await candidatesForDay(specialty, ymd, cache);
    const periods = periodsAvailability(candidates);
    const times = publicTimes(candidates);
    if (times.length) {
      result.push({ date: ymd, label: dayLabel(ymd), periods, times });
    }
  }

  const payload = { specialty, days: result, expiresIn: OPTIONS_CACHE_TTL };
  await safeRedis.setex(cacheKey, OPTIONS_CACHE_TTL, JSON.stringify(payload));
  return payload;
}

async function invalidateOptionsCache(specialty) {
  const [, keys] = await safeRedis.scan('0', 'MATCH', `public-booking:options:${specialty}:*`, 'COUNT', 200);
  if (keys?.length) await safeRedis.del(...keys);
}

/** Reserva ativa do mesmo telefone + mesma criança (idempotência e anti-duplicado). */
async function findExistingHold({ phone, childName, now }) {
  const today = todaySP(now);
  const appt = await Appointment.findOne({
    'metadata.origin.bookingCode': { $exists: true },
    'patientInfo.phone': phone,
    operationalStatus: { $in: ACTIVE_STATUSES },
    date: { $gte: new Date(`${today}T00:00:00Z`) },
  })
    .select('date time operationalStatus patientInfo metadata')
    .sort({ createdAt: -1 })
    .lean();
  if (!appt) return null;
  const sameChild = String(appt.patientInfo?.fullName || '').localeCompare(childName, 'pt', { sensitivity: 'base' }) === 0;
  return sameChild ? appt : null;
}

async function countHolds(filter) {
  return Appointment.countDocuments({ 'metadata.origin.bookingCode': { $exists: true }, ...filter });
}

function ymdOfAppointmentDate(d) {
  return new Date(d).toISOString().slice(0, 10);
}

async function resolvePatient({ childName, birthDate, phone }) {
  const duplicates = await findPossibleDuplicates(Patient, { fullName: childName, dateOfBirth: birthDate, phone });
  const reuse = pickReusableDuplicate(duplicates);
  if (reuse) return reuse._id;

  const created = await Patient.create({
    fullName: childName,
    phone,
    dateOfBirth: birthDate,
    source: 'link_agendamento',
    ...(duplicates.length ? { possibleDuplicateOf: duplicates.map((d) => d._id) } : {}),
  });

  await publishEvent(EventTypes.PATIENT_CREATED, {
    patientId: created._id.toString(),
    fullName: created.fullName,
    phone: created.phone,
    dateOfBirth: created.dateOfBirth,
    source: 'link_agendamento',
  });
  return created._id;
}

async function lockSlot(doctorId, date, time) {
  const key = `public-booking:lock:${doctorId}:${date}:${time}`;
  const ok = await safeRedis.set(key, '1', 'NX', 'EX', 20);
  // Sem Redis o safeRedis devolve null: segue sem trava (checkSlotOverlap ainda protege).
  return ok === 'OK' || ok === null;
}

/**
 * Cria a reserva. data = saída de validateHoldPayload().data
 * Devolve { code, display, reused }.
 */
export async function createHold(data, { now = new Date(), env = process.env } = {}) {
  const { specialty, date, period, time, childName, birthDate, responsibleName, phone, utm } = data;

  const existing = await findExistingHold({ phone, childName, now });
  if (existing) {
    const ymd = ymdOfAppointmentDate(existing.date);
    return {
      code: existing.metadata.origin.bookingCode,
      display: displayText(ymd, null, existing.time),
      reused: true,
    };
  }

  const since24h = new Date(now.getTime() - 24 * 60 * 60 * 1000);
  if (await countHolds({ 'patientInfo.phone': phone, createdAt: { $gte: since24h } }) >= 2) {
    throw new PublicBookingError('TOO_MANY_REQUESTS', 429);
  }
  const startOfDay = new Date(`${todaySP(now)}T00:00:00-03:00`);
  if (await countHolds({ createdAt: { $gte: startOfDay } }) >= dailyCap(env)) {
    throw new PublicBookingError('DAILY_CAP', 503);
  }

  const candidates = await candidatesForDay(specialty, date);
  const pickFor = (list) => (time ? pickSlotForTime(list, time) : pickSlotForPeriod(list, period));
  let pick = pickFor(candidates);

  // Revalida e trava; se outro pegou o horário no meio, tenta o próximo profissional.
  let chosen = null;
  const tried = [];
  while (pick && !chosen) {
    tried.push(pick.doctorId);
    const locked = await lockSlot(pick.doctorId, date, pick.time);
    const conflict = locked ? await checkSlotOverlap({ doctorId: pick.doctorId, date, time: pick.time, duration: 40 }) : true;
    if (!conflict) {
      chosen = pick;
    } else {
      pick = pickFor(candidates.filter((c) => !tried.includes(c.doctorId)));
    }
  }

  if (!chosen && time) {
    const alternatives = publicTimes(candidates).filter((t) => t !== time).slice(0, 6).map((t) => ({ date, time: t }));
    await invalidateOptionsCache(specialty);
    throw new PublicBookingError('SLOT_TAKEN', 409, { alternatives });
  }

  if (!chosen) {
    const other = period === 'manha' ? 'tarde' : 'manha';
    const alternatives = periodsAvailability(candidates)
      .filter((p) => p.period === other && p.available)
      .map((p) => ({ date, period: p.period }));
    throw new PublicBookingError('PERIOD_FULL', 409, { alternatives });
  }

  const doctor = candidates.find((c) => c.doctorId === chosen.doctorId)?.doctor;
  const patientId = await resolvePatient({ childName, birthDate, phone });
  const code = generateBookingCode();

  const appointment = await Appointment.create({
    patient: patientId,
    doctor: doctor._id,
    patientInfo: { fullName: childName, phone, birthDate },
    professionalName: doctor.fullName,
    date,
    time: chosen.time,
    duration: 40,
    specialty,
    serviceType: 'evaluation',
    sessionValue: 0, // valor é definido pela secretária na confirmação
    billingType: 'particular',
    operationalStatus: 'pre_agendado',
    clinicalStatus: 'pending',
    paymentStatus: 'pending',
    visualFlag: 'pending',
    patientType: 'novo',
    responsible: responsibleName,
    secretaryNotes: `Responsável: ${responsibleName}`,
    notes: `[AGENDADO PELO LINK ${code}] Família escolheu ${displayText(date, period, chosen.time)}. Confirmar no WhatsApp.`,
    metadata: {
      origin: {
        source: originSourceFromUtm(utm),
        channel: 'link_agendamento',
        bookingCode: code,
        utm,
      },
    },
  });

  console.log('[PUBLIC-BOOKING] reserva criada', {
    code,
    appointmentId: String(appointment._id),
    specialty,
    date,
    time: chosen.time,
    phone: maskPhone(phone),
  });

  try {
    const io = getIo();
    const socketData = {
      id: String(appointment._id),
      patientName: childName,
      specialty,
      preferredDate: date,
      preferredTime: chosen.time,
      operationalStatus: 'pre_agendado',
      createdAt: appointment.createdAt,
      source: 'link_agendamento',
    };
    io.emit('preagendamento:new', socketData);
    io.emit('appointmentCreated', socketData);
  } catch (err) {
    console.error('[PUBLIC-BOOKING] socket', err.message);
  }

  await invalidateOptionsCache(specialty);
  return { code, display: displayText(date, period, chosen.time), reused: false };
}

export async function getStatus(code) {
  const appt = await Appointment.findOne({ 'metadata.origin.bookingCode': code })
    .select('date time operationalStatus')
    .lean();
  if (!appt) return null;
  const ymd = ymdOfAppointmentDate(appt.date);
  return {
    status: publicStatusOf(appt.operationalStatus),
    display: displayText(ymd, null, appt.time),
  };
}
