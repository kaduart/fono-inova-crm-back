import dotenv from 'dotenv';
import mongoose from 'mongoose';
import Appointment from '../models/Appointment.js';

dotenv.config();

async function updateOperationalStatusOnly() {
  try {
    await mongoose.connect(process.env.MONGO_URI);

    const statusMap = {
      'agendado': 'agendado',
      'confirmado': 'confirmado',
      'cancelado': 'cancelado',
      'concluído': 'pago',
      'faltou': 'cancelado'
    };

    const appointments = await Appointment.find({ status: { $in: Object.keys(statusMap) } });

    let atualizados = 0;

    for (const [i, appt] of appointments.entries()) {
      const newStatus = statusMap[appt.status];
      if (appt.operationalStatus !== newStatus) {
        appt.operationalStatus = newStatus;
        await appt.save();

        atualizados++;
      }
    }

    process.exit(0);
  } catch (err) {
    console.error('❌ Erro durante atualização:', err);
    process.exit(1);
  }
}

updateOperationalStatusOnly().catch(console.error);
