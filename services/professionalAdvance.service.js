/**
 * 💳 Professional Advance Service
 *
 * Gerencia adiantamentos, bonificações e ajustes de profissionais.
 */

import mongoose from 'mongoose';
import moment from 'moment-timezone';
import ProfessionalAdvance from '../models/ProfessionalAdvance.js';

const TIMEZONE = 'America/Sao_Paulo';

function parseRange(startDate, endDate) {
  const start = startDate
    ? moment.tz(startDate, TIMEZONE).startOf('day').toDate()
    : moment.tz(TIMEZONE).startOf('month').toDate();
  const end = endDate
    ? moment.tz(endDate, TIMEZONE).endOf('day').toDate()
    : moment.tz(TIMEZONE).endOf('month').toDate();
  return { start, end };
}

export async function createAdvance({ doctorId, amount, date, type = 'advance', notes = null, createdBy = null }) {
  if (!doctorId || !amount || amount <= 0 || !date) {
    throw new Error('doctorId, amount e date são obrigatórios');
  }

  const advance = new ProfessionalAdvance({
    doctor: new mongoose.Types.ObjectId(doctorId),
    amount,
    date: new Date(date),
    type,
    status: 'active',
    notes,
    createdBy: createdBy ? new mongoose.Types.ObjectId(createdBy) : null,
    settlementId: null
  });

  await advance.save();
  return advance;
}

export async function cancelAdvance({ advanceId, cancelledBy, cancelReason }) {
  const advance = await ProfessionalAdvance.findById(advanceId);
  if (!advance) {
    throw new Error('Adiantamento não encontrado');
  }

  if (advance.status === 'cancelled') {
    throw new Error('Adiantamento já está cancelado');
  }

  if (advance.settlementId) {
    throw new Error('Adiantamento já vinculado a um fechamento não pode ser cancelado');
  }

  advance.status = 'cancelled';
  advance.cancelledBy = cancelledBy ? new mongoose.Types.ObjectId(cancelledBy) : null;
  advance.cancelledAt = new Date();
  advance.cancelReason = cancelReason || null;

  await advance.save();
  return advance;
}

export async function getDoctorAdvances({ doctorId, startDate, endDate, status = null, type = null, limit = 100 }) {
  const { start, end } = parseRange(startDate, endDate);

  const query = {
    doctor: new mongoose.Types.ObjectId(doctorId),
    date: { $gte: start, $lte: end }
  };

  if (status) query.status = status;
  if (type) query.type = type;

  return ProfessionalAdvance.find(query)
    .sort({ date: -1, createdAt: -1 })
    .limit(limit)
    .lean();
}

export async function getDoctorAdvanceBalance(doctorId, asOfDate = null) {
  const query = {
    doctor: new mongoose.Types.ObjectId(doctorId),
    status: 'active'
  };

  if (asOfDate) {
    query.date = { $lte: new Date(asOfDate) };
  }

  const advances = await ProfessionalAdvance.find(query).lean();

  const total = advances.reduce((sum, a) => sum + (a.amount || 0), 0);
  const count = advances.length;
  const byType = advances.reduce((acc, a) => {
    acc[a.type] = (acc[a.type] || 0) + (a.amount || 0);
    return acc;
  }, {});

  return {
    total: Math.round(total * 100) / 100,
    count,
    byType,
    advances
  };
}

export async function attachToSettlement({ doctorId, settlementId, startDate, endDate }) {
  if (!doctorId || !settlementId) {
    throw new Error('doctorId e settlementId são obrigatórios');
  }

  const { start, end } = parseRange(startDate, endDate);

  const result = await ProfessionalAdvance.updateMany(
    {
      doctor: new mongoose.Types.ObjectId(doctorId),
      status: 'active',
      settlementId: null,
      date: { $gte: start, $lte: end }
    },
    {
      settlementId: new mongoose.Types.ObjectId(settlementId)
    }
  );

  return {
    attached: result.modifiedCount || 0
  };
}

export async function detachFromSettlement(settlementId) {
  const result = await ProfessionalAdvance.updateMany(
    { settlementId: new mongoose.Types.ObjectId(settlementId) },
    { settlementId: null }
  );

  return {
    detached: result.modifiedCount || 0
  };
}
