// utils/updateAppointmentFromSession.js
import Appointment from "../models/Appointment.js";
import Patient from "../models/Patient.js";

/**
 * 🔹 Sincroniza o Appointment vinculado à Session.
 * Mantém flags coerentes (ok / pending / blocked).
 */
export async function updateAppointmentFromSession(sessionDoc, mongoSession = null) {
  const appointment = await Appointment.findOne({ session: sessionDoc._id }).session(mongoSession);
  if (!appointment) return null;

  appointment.paymentStatus = sessionDoc.paymentStatus;
  appointment.visualFlag = sessionDoc.visualFlag;
  appointment.isPaid = sessionDoc.isPaid;

  // 🔹 Garante coerência visual
  if (sessionDoc.paymentStatus === "paid") {
    appointment.visualFlag = "ok";
  } else if (sessionDoc.paymentStatus === "partial") {
    appointment.visualFlag = "pending";
  } else {
    appointment.visualFlag = "blocked";
  }

  await appointment.save({ session: mongoSession });

  // 🔹 Atualiza automaticamente o resumo do paciente após sincronizar o agendamento
  await updatePatientAppointments(sessionDoc.patient);

  return appointment;
}

/**
 * 🔹 Atualiza os campos lastAppointment e nextAppointment do paciente.
 */
export async function updatePatientAppointments(patientId) {
  try {
    const now = new Date();

    // Busca os agendamentos do paciente
    const result = await Appointment.aggregate([
      { $match: { patient: patientId } },
      { $sort: { date: 1 } },
      {
        $group: {
          _id: null,
          all: { $push: "$$ROOT" },
          past: { $push: { $cond: [{ $lt: ["$date", now] }, "$$ROOT", null] } },
          future: { $push: { $cond: [{ $gte: ["$date", now] }, "$$ROOT", null] } },
        },
      },
      {
        $project: {
          lastAppointment: { $arrayElemAt: ["$past", -1] },
          nextAppointment: { $arrayElemAt: ["$future", 0] },
        },
      },
    ]);

    const updateData = {};

    if (result.length > 0) {
      if (result[0].lastAppointment) {
        updateData.lastAppointment = result[0].lastAppointment._id;
      }
      if (result[0].nextAppointment) {
        updateData.nextAppointment = result[0].nextAppointment._id;
      }
    }

    await Patient.findByIdAndUpdate(patientId, updateData);
  } catch (error) {
    console.error(`Erro ao atualizar agendamentos do paciente ${patientId}:`, error);
  }
}
