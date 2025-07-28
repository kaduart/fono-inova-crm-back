import Appointment from "../models/Appointment.js";
import Patient from "../models/Patient.js";

export async function updatePatientAppointments(patientId) {
  try {
    // 1. Buscar todos appointments do paciente
    const appointments = await Appointment.find({ patient: patientId })
      .sort({ date: 1 })
      .lean();

    // 2. Calcular último e próximo appointment
    const now = new Date();
    let lastAppointment = null;
    let nextAppointment = null;

    for (const app of appointments) {
      if (new Date(app.date) < now) {
        lastAppointment = app;
      } else {
        nextAppointment = app;
        break;
      }
    }

    // 3. Atualizar paciente
    await Patient.findByIdAndUpdate(patientId, {
      lastAppointment: lastAppointment?._id,
      nextAppointment: nextAppointment?._id
    });

  } catch (error) {
    console.error(`Erro ao atualizar agendamentos do paciente ${patientId}:`, error);
  }
}