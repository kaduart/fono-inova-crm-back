// utils/updateAppointmentFromSession.js
import Appointment from "../models/Appointment.js";
import Patient from "../models/Patient.js";
import { mapStatusToClinical, mapStatusToOperational } from "./statusMappers.js";

/**
 * 🔹 Sincroniza o Appointment vinculado à Session.
 * Mantém flags coerentes (ok / pending / blocked).
 */
export async function updateAppointmentFromSession(sessionDoc, mongoSession = null) {
  const appointment = await Appointment.findOne({ session: sessionDoc._id }).session(mongoSession);
  if (!appointment) return null;

  const op = mapStatusToOperational(sessionDoc.status); // nunca "completed" ou "paid"
  const cl = (sessionDoc.status);

  const pay =
    (sessionDoc.paymentStatus && String(sessionDoc.paymentStatus).toLowerCase()) ||
    (sessionDoc.isPaid ? "paid" : "pending");

  await Appointment.updateOne(
    { _id: appointment._id },
    {
      $set: {
        paymentStatus: pay,
        operationalStatus: op,
        clinicalStatus: cl,
        sessionValue: sessionDoc.sessionValue ?? appointment.sessionValue,
      },
    },
    { session: mongoSession, runValidators: false, strict: true }
  );

  return await Appointment.findById(appointment._id).session(mongoSession);
}

/**
 * 🔹 Atualiza os campos lastAppointment e nextAppointment do paciente.
 * Regras:
 *  - PASSADO: (date < hoje) OR (date == hoje AND time < agora)
 *  - FUTURO/HOJE: (date > hoje) OR (date == hoje AND time >= agora)
 * Ordenação:
 *  - lastAppointment: passado mais recente (desc)
 *  - nextAppointment: hoje/futuro mais próximo (asc)
 * Observação: comparação por STRING evita bugs de fuso/offset.
 */
export async function updatePatientAppointments(patientId) {
  try {
    const tz = "America/Sao_Paulo";

    const agg = await Appointment.aggregate([
      { $match: { patient: patientId, operationalStatus: { $ne: "canceled" } } },

      // Normaliza chaves de comparação como strings
      {
        $addFields: {
          _dateStr: { $ifNull: ["$date", ""] },     // "YYYY-MM-DD"
          _timeStr: { $ifNull: ["$time", "00:00"] }, // "HH:mm"
        },
      },

      // "agora" no fuso correto, como strings
      {
        $addFields: {
          _todayStr: {
            $dateToString: { format: "%Y-%m-%d", date: "$$NOW", timezone: tz },
          },
          _nowTimeStr: {
            $dateToString: { format: "%H:%M", date: "$$NOW", timezone: tz },
          },
        },
      },

      // Chave de ordenação e flags de passado/futuro por comparação de strings
      {
        $addFields: {
          _sortKey: { $concat: ["$_dateStr", "T", { $ifNull: ["$_timeStr", "00:00"] }] },

          _isFutureOrToday: {
            $or: [
              { $gt: ["$_dateStr", "$_todayStr"] },
              {
                $and: [
                  { $eq: ["$_dateStr", "$_todayStr"] },
                  { $gte: ["$_timeStr", "$_nowTimeStr"] },
                ],
              },
            ],
          },
        },
      },

      // Ordena cronologicamente (asc)
      { $sort: { _sortKey: 1, _id: 1 } },

      // Separa em passado/futuro preservando ordenação
      {
        $group: {
          _id: null,
          past: {
            $push: {
              $cond: [{ $not: ["$_isFutureOrToday"] }, "$$ROOT", "$$REMOVE"],
            },
          },
          future: {
            $push: {
              $cond: ["$_isFutureOrToday", "$$ROOT", "$$REMOVE"],
            },
          },
        },
      },

      // Pega o último dos passados (mais recente) e o primeiro dos futuros (mais próximo)
      {
        $project: {
          lastAppointment: {
            $cond: [
              { $gt: [{ $size: "$past" }, 0] },
              { $arrayElemAt: ["$past", -1] },
              null,
            ],
          },
          nextAppointment: {
            $cond: [
              { $gt: [{ $size: "$future" }, 0] },
              { $arrayElemAt: ["$future", 0] },
              null,
            ],
          },
        },
      },
    ]);

    const doc = agg[0] || {};
    const updateData = {
      // se não existir, seta null para limpar resíduos antigos
      lastAppointment: doc.lastAppointment ? doc.lastAppointment._id : null,
      nextAppointment: doc.nextAppointment ? doc.nextAppointment._id : null,
    };

    await Patient.findByIdAndUpdate(
      patientId,
      { $set: updateData },
      { new: false, runValidators: false }
    );
  } catch (error) {
    console.error(`Erro ao atualizar agendamentos do paciente ${patientId}:`, error);
  }
}
