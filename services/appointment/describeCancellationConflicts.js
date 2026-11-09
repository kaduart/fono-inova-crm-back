import Appointment from '../../models/Appointment.js';
import Doctor from '../../models/Doctor.js';
import InsuranceGuide from '../../models/InsuranceGuide.js';
import { buildDayRange } from '../../utils/datetime.js';
import { buildCancellationConflictMessage } from '../../domain/appointment/cancellationConflictMessage.js';

/**
 * Completa cada conflito de cancelamento com o que já está lançado no horário
 * (especialidade, profissional, guia, status) e monta o texto do envelope de erro.
 * Só leitura, fora da transação (que já foi abortada). Nunca derruba a resposta:
 * se a consulta falhar, devolve o texto sem o detalhe.
 */
export async function describeCancellationConflicts(conflicts = [], patientId) {
  try {
    if (patientId && conflicts.length) {
      for (const conflict of conflicts) {
        const docs = await Appointment.find({ patient: patientId, time: conflict.time,
          $or: [{ date: buildDayRange(conflict.date) }, { date: new Date(`${conflict.date}T00:00:00Z`) }] })
          .select('specialty doctor operationalStatus insuranceGuide liminarContract').lean();
        const doctorIds = [...new Set(docs.map(d => String(d.doctor || '')).filter(Boolean))];
        const guideIds = [...new Set(docs.map(d => String(d.insuranceGuide || '')).filter(Boolean))];
        const [doctors, guides] = await Promise.all([
          doctorIds.length ? Doctor.find({ _id: { $in: doctorIds } }).select('fullName').lean() : [],
          guideIds.length ? InsuranceGuide.find({ _id: { $in: guideIds } }).select('number').lean() : [],
        ]);
        const doctorName = Object.fromEntries(doctors.map(d => [String(d._id), d.fullName]));
        const guideNumber = Object.fromEntries(guides.map(g => [String(g._id), g.number]));
        conflict.existing = docs.map(d => ({
          specialty: d.specialty, status: d.operationalStatus,
          doctorName: doctorName[String(d.doctor)] || null,
          guideNumber: guideNumber[String(d.insuranceGuide)] || null,
          liminar: Boolean(d.liminarContract),
        }));
      }
    }
  } catch (error) {
    console.warn('[describeCancellationConflicts] detalhe indisponível', error?.message);
  }
  return buildCancellationConflictMessage(conflicts);
}
