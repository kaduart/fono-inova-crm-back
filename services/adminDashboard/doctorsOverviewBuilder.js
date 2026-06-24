/**
 * 👨‍⚕️ Doctors Overview Builder — Admin Dashboard V2
 *
 * Lista resumida de profissionais com métricas leves.
 * TTL recomendado: 60s
 */

import moment from 'moment-timezone';
import mongoose from 'mongoose';
import Doctor from '../../models/Doctor.js';
import Patient from '../../models/Patient.js';
import Appointment from '../../models/Appointment.js';

const TIMEZONE = 'America/Sao_Paulo';

export async function buildDoctorsOverview(limit = 10) {
  const last30Days = moment().tz(TIMEZONE).subtract(30, 'days').toDate();

  // Busca médicos ativos (projection mínima)
  const doctors = await Doctor.find({ active: true })
    .select('fullName specialty')
    .sort({ fullName: 1 })
    .lean();

  console.log(`[doctorsOverviewBuilder] Encontrados ${doctors.length} médicos ativos`);

  const doctorIds = doctors.map(d => d._id.toString());
  if (doctorIds.length === 0) return [];

  const objectIds = doctorIds.map(id => new mongoose.Types.ObjectId(id));

  // Contagens em paralelo
  const [patientCounts, appointmentCounts] = await Promise.all([
    Patient.aggregate([
      { $match: { doctor: { $in: objectIds } } },
      { $group: { _id: '$doctor', count: { $sum: 1 } } }
    ]),

    Appointment.aggregate([
      {
        $match: {
          doctor: { $in: objectIds },
          date: { $gte: last30Days }
        }
      },
      { $group: { _id: '$doctor', count: { $sum: 1 } } }
    ])
  ]);

  const patientMap = patientCounts.reduce((acc, item) => {
    acc[item._id.toString()] = item.count;
    return acc;
  }, {});

  const appointmentMap = appointmentCounts.reduce((acc, item) => {
    acc[item._id.toString()] = item.count;
    return acc;
  }, {});

  const result = doctors.slice(0, limit).map(doctor => ({
    _id: doctor._id,
    name: doctor.fullName,
    specialty: doctor.specialty,
    patients: patientMap[doctor._id.toString()] || 0,
    appointments: appointmentMap[doctor._id.toString()] || 0
  }));
  console.log(`[doctorsOverviewBuilder] Retornando ${result.length} médicos`);
  return result;
}
