import dotenv from 'dotenv';
import mongoose from 'mongoose';
import Appointment from '../models/Appointment.js';

dotenv.config();

async function renameDoctorAndPatientFields() {
  try {
    await mongoose.connect(process.env.MONGO_URI);

    // Encontra agendamentos com doctorId OU patientId
    const appointments = await Appointment.find({
      $or: [
        { doctorId: { $exists: true } },
        { patientId: { $exists: true } }
      ]
    });


    let atualizados = 0;

    for (const [i, appt] of appointments.entries()) {
      const update = {};
      let needsUpdate = false;

      // Verifica e prepara renomeação de doctorId → doctor
      if (appt.doctorId) {
        update.doctor = appt.doctorId;
        update.$unset = { doctorId: "" };
        needsUpdate = true;
      }

      // Verifica e prepara renomeação de patientId → patient
      if (appt.patientId) {
        update.patient = appt.patientId;
        update.$unset = { ...update.$unset, patientId: "" };
        needsUpdate = true;
      }

      if (needsUpdate) {
        await Appointment.updateOne(
          { _id: appt._id },
          update
        );
        atualizados++;
      }
    }

    process.exit(0);
  } catch (err) {
    console.error('❌ Erro durante migração:', err);
    process.exit(1);
  }
}

renameDoctorAndPatientFields().catch(console.error);