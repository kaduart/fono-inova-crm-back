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
    const now = new Date(); // agora real

    const tz = "America/Sao_Paulo"; // seu fuso

    const result = await Appointment.aggregate([
      { $match: { patient: patientId } },

      // Cria um datetime a partir de date (YYYY-MM-DD) + time (HH:mm)
      {
        $addFields: {
          combinedDateTimeStr: {
            $concat: [
              { $ifNull: ['$date', '1970-01-01'] }, 'T',
              { $ifNull: ['$time', '00:00'] }, ':00'
            ]
          }
        }
      },
      {
        $addFields: {
          combinedDateTime: {
            $dateFromString: {
              dateString: '$combinedDateTimeStr',
              timezone: tz
            }
          }
        }
      },

      // Ordena pelo datetime real
      { $sort: { combinedDateTime: 1 } },

      // Separa passado/futuro comparando Date real com `now`
      {
        $group: {
          _id: null,
          past: {
            $push: {
              $cond: [{ $lt: ['$combinedDateTime', now] }, '$$ROOT', null]
            }
          },
          future: {
            $push: {
              $cond: [{ $gte: ['$combinedDateTime', now] }, '$$ROOT', null]
            }
          }
        }
      },
      {
        $project: {
          lastAppointment: {
            $let: {
              vars: { pastNonNull: { $filter: { input: '$past', as: 'p', cond: { $ne: ['$$p', null] } } } },
              in: { $arrayElemAt: ['$$pastNonNull', -1] }
            }
          },
          nextAppointment: {
            $let: {
              vars: { futureNonNull: { $filter: { input: '$future', as: 'f', cond: { $ne: ['$$f', null] } } } },
              in: { $arrayElemAt: ['$$futureNonNull', 0] }
            }
          }
        }
      }
    ]);

    const updateData = {};
    if (result.length > 0) {
      if (result[0].lastAppointment?._id) {
        updateData.lastAppointment = result[0].lastAppointment._id;
      }
      if (result[0].nextAppointment?._id) {
        updateData.nextAppointment = result[0].nextAppointment._id;
      }
    }

    await Patient.findByIdAndUpdate(patientId, updateData);
  } catch (error) {
    console.error(`Erro ao atualizar agendamentos do paciente ${patientId}:`, error);
  }
}

