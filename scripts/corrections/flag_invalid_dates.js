// scripts/corrections/flag_invalid_dates.js
import dotenv from 'dotenv';
import mongoose from 'mongoose';
import Appointment from '../../models/Appointment.js';

dotenv.config();

async function flagInvalidDates() {
  await mongoose.connect(process.env.MONGO_URI);

  // 1. Encontrar documentos com datas anteriores a 1900
  const filter = {
    date: { $lt: new Date('1900-01-01') }
  };

  // 2. Atualizar com a flag de data inválida
  const result = await Appointment.updateMany(
    filter,
    {
      $set: {
        "meta.isInvalidDate": true
      },
      $push: {
        history: {
          action: "invalid_date_flag",
          details: "Data anterior a 1900-01-01"
        }
      }
    }
  );

  // 3. Listar IDs problemáticos para inspeção manual
  const invalidApps = await Appointment.find(filter).select('_id date');
  console.table(invalidApps.map(app => ({
    _id: app._id,
    date: app.date.toISOString()
  })));

  await mongoose.disconnect();
}

flagInvalidDates();