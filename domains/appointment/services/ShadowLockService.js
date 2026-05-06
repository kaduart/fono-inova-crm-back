import mongoose from 'mongoose';
import ShadowLock from '../models/ShadowLock.js';

function normalizeTimeHHmm(value) {
  if (!value) return null;
  const t = String(value).trim();
  const m = t.match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return null;
  const hh = String(m[1]).padStart(2, '0');
  const mm = m[2];
  return `${hh}:${mm}`;
}

function buildDateOnly(dateYMD) {
  const d = new Date(`${dateYMD}T12:00:00-03:00`);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate(), 12, 0, 0, 0);
}

export class ShadowLockService {
  /**
   * Cria um shadow lock (pré-reserva real) para um paciente.
   */
  static async createLock({ patientId, doctorId, date, time, createdBy = 'system', notes = '' }) {
    if (!mongoose.Types.ObjectId.isValid(String(patientId))) throw new Error('patientId inválido');
    if (!mongoose.Types.ObjectId.isValid(String(doctorId))) throw new Error('doctorId inválido');

    const timeNorm = normalizeTimeHHmm(time);
    if (!timeNorm) throw new Error('Horário inválido');

    const dateObj = typeof date === 'string' ? buildDateOnly(date) : date;
    const expiresAt = new Date(dateObj);
    expiresAt.setHours(23, 59, 59, 999); // expira no fim do dia da sessão

    // Cancela locks anteriores no mesmo slot (se houver)
    await ShadowLock.updateMany(
      { doctorId, date: dateObj, time: timeNorm, status: 'active' },
      { $set: { status: 'canceled' } }
    );

    const lock = await ShadowLock.create({
      patientId: new mongoose.Types.ObjectId(String(patientId)),
      doctorId: new mongoose.Types.ObjectId(String(doctorId)),
      date: dateObj,
      time: timeNorm,
      status: 'active',
      createdBy,
      expiresAt,
      notes
    });

    return lock;
  }

  /**
   * Busca locks ativos para um determinado médico, data e horário.
   * Usado em calculateAvailableSlots para bloquear slots reservados.
   */
  static async findActiveLocksForSlot(doctorId, dateYMD, timeStr) {
    if (!mongoose.Types.ObjectId.isValid(String(doctorId))) return [];

    const doctorObjectId = new mongoose.Types.ObjectId(String(doctorId));
    const timeNorm = normalizeTimeHHmm(timeStr);
    if (!timeNorm) return [];

    const dateObj = buildDateOnly(dateYMD);

    const locks = await ShadowLock.find({
      doctorId: doctorObjectId,
      date: dateObj,
      time: timeNorm,
      status: 'active',
      expiresAt: { $gte: new Date() }
    })
      .populate('patientId', 'fullName')
      .lean();

    return locks.map(l => ({
      lockId: l._id.toString(),
      patientId: l.patientId?._id?.toString() || l.patientId.toString(),
      patientName: l.patientId?.fullName || 'Paciente',
      createdAt: l.createdAt,
      createdBy: l.createdBy
    }));
  }

  /**
   * Busca TODOS os locks ativos para um médico em uma data.
   */
  static async findActiveLocksForDoctorDay(doctorId, dateYMD) {
    if (!mongoose.Types.ObjectId.isValid(String(doctorId))) return new Map();

    const doctorObjectId = new mongoose.Types.ObjectId(String(doctorId));
    const dateObj = buildDateOnly(dateYMD);

    const locks = await ShadowLock.find({
      doctorId: doctorObjectId,
      date: dateObj,
      status: 'active',
      expiresAt: { $gte: new Date() }
    })
      .populate('patientId', 'fullName')
      .lean();

    const byTime = new Map();
    for (const l of locks) {
      const t = normalizeTimeHHmm(l.time);
      if (!t) continue;
      byTime.set(t, {
        lockId: l._id.toString(),
        patientId: l.patientId?._id?.toString() || l.patientId.toString(),
        patientName: l.patientId?.fullName || 'Paciente',
        createdAt: l.createdAt,
        createdBy: l.createdBy
      });
    }

    return byTime;
  }

  /**
   * Cancela um shadow lock.
   */
  static async cancelLock(lockId) {
    if (!mongoose.Types.ObjectId.isValid(String(lockId))) throw new Error('lockId inválido');

    const updated = await ShadowLock.findByIdAndUpdate(
      lockId,
      { $set: { status: 'canceled' } },
      { new: true }
    );

    return updated;
  }

  /**
   * Marca um lock como convertido (quando vira appointment real).
   */
  static async convertLock(lockId) {
    if (!mongoose.Types.ObjectId.isValid(String(lockId))) throw new Error('lockId inválido');

    const updated = await ShadowLock.findByIdAndUpdate(
      lockId,
      { $set: { status: 'converted' } },
      { new: true }
    );

    return updated;
  }
}
