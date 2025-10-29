// utils/updateAppointmentFromSession.js
import Appointment from "../models/Appointment.js";
import Patient from "../models/Patient.js";
import { mapStatusToClinical, mapStatusToOperational } from "../routes/Payment.js";

/**
 * 🔹 Sincroniza o Appointment vinculado à Session.
 * Mantém flags coerentes (ok / pending / blocked).
 */
export async function updateAppointmentFromSession(sessionDoc, mongoSession = null) {
  const appointment = await Appointment.findOne({ session: sessionDoc._id }).session(mongoSession);
  if (!appointment) return null;

  const op = mapStatusToOperational(sessionDoc.status); // -> nunca "completed" ou "paid"
  const cl = mapStatusToClinical(sessionDoc.status);

  const pay =
    (sessionDoc.paymentStatus && String(sessionDoc.paymentStatus).toLowerCase()) ||
    (sessionDoc.isPaid ? "paid" : "pending");

  // atualize sem validar para não cair em qualquer validator bugado
  await Appointment.updateOne(
    { _id: appointment._id },
    {
      $set: {
        paymentStatus: pay,           // "paid"|"partial"|"advanced"|...
        operationalStatus: op,        // "confirmed"/"scheduled"/"canceled"/"missed"
        clinicalStatus: cl,           // "completed" permitido só no clínico
        sessionValue: sessionDoc.sessionValue ?? appointment.sessionValue
      }
    },
    { session: mongoSession, runValidators: false, strict: true }
  );

  return await Appointment.findById(appointment._id).session(mongoSession);
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

