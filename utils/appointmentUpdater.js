import Appointment from "../models/Appointment.js";
import Patient from "../models/Patient.js";

export async function updatePatientAppointments(patientId) {
  try {
    const now = new Date();

    // Busca em uma única query usando aggregation
    const result = await Appointment.aggregate([
      { $match: { patient: patientId } },
      { $sort: { date: 1 } },
      {
        $group: {
          _id: null,
          all: { $push: "$$ROOT" },
          past: {
            $push: {
              $cond: [{ $lt: ["$date", now] }, "$$ROOT", null]
            }
          },
          future: {
            $push: {
              $cond: [{ $gte: ["$date", now] }, "$$ROOT", null]
            }
          }
        }
      },
      {
        $project: {
          lastAppointment: { $arrayElemAt: ["$past", -1] },
          nextAppointment: { $arrayElemAt: ["$future", 0] }
        }
      }
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
    // Pode adicionar retry ou notificação aqui se necessário
  }
}