// services/paymentService.js
export const handleSessionPayment = ({ pkg, amount, paymentMethod }) => {
  if (!['fonoaudiologia', 'terapia_ocupacional', 'psicologia', 'fisioterapia', 'psicomotricidade', 'musicoterapia', 'psicopedagogia'].includes(pkg.type)) {
    throw new Error('Tipo de terapia inválido para pagamento');
  }

  const totalPaid = pkg.payments.reduce((sum, p) => sum + p.amount, 0);
  const packageValue = pkg.totalSessions * amount;
  const isFullyPaid = totalPaid >= packageValue;

  // Se for per-session ou partial, ou se for full mas ainda não pago totalmente
  if (pkg.paymentType !== 'full' || !isFullyPaid) {
    const newPayment = {
      amount,
      date: new Date(),
      paymentMethod,
      status: pkg.paymentType === 'per-session' ? 'paid' : 'pending',
    };
    pkg.payments.push(newPayment);
  }

  return pkg;
};

import Appointment from '../models/Appointment.js';
import Payment from '../models/Payment.js';
import Session from '../models/Session.js';

async function generateDailyReport(date) {
  const startDate = new Date(date);
  startDate.setHours(0, 0, 0, 0);
  const endDate = new Date(date);
  endDate.setHours(23, 59, 59, 999);

  const [appointmentMetrics, sessionMetrics, paymentMetrics] = await Promise.all([
    // 1. Agregações de Agendamentos
    Appointment.aggregate([
      { $match: { date: { $gte: startDate, $lte: endDate } } },
      {
        $facet: {
          totals: [
            {
              $group: {
                _id: null,
                count: { $sum: 1 },
                value: { $sum: { $ifNull: ["$sessionValue", 0] } },
                absences: { $sum: { $cond: [{ $in: ["$operationalStatus", ["cancelado", "faltou"]] }, 1, 0] } },
                estimatedLoss: { $sum: { $cond: [{ $in: ["$operationalStatus", ["cancelado", "faltou"]] }, { $ifNull: ["$sessionValue", 0] }, 0] } }
              }
            }
          ],
          byProfessional: [
            { $lookup: { from: "doctors", localField: "doctor", foreignField: "_id", as: "doc" } },
            { $unwind: { path: "$doc", preserveNullAndEmptyArrays: true } },
            {
              $group: {
                _id: "$doctor",
                doctorName: { $first: "$doc.fullName" },
                scheduled: { $sum: 1 },
                scheduledValue: { $sum: { $ifNull: ["$sessionValue", 0] } },
                absences: { $sum: { $cond: [{ $in: ["$operationalStatus", ["cancelado", "faltou"]] }, 1, 0] } }
              }
            }
          ]
        }
      }
    ]),

    // 2. Agregações de Sessões
    Session.aggregate([
      { $match: { date: { $gte: startDate, $lte: endDate }, status: 'completed' } },
      {
        $group: {
          _id: "$doctor",
          completed: { $sum: 1 },
          completedValue: { $sum: { $ifNull: ["$sessionValue", 0] } }
        }
      }
    ]),

    // 3. Agregações de Pagamentos
    Payment.aggregate([
      { $match: { createdAt: { $gte: startDate, $lte: endDate }, status: 'paid' } },
      {
        $facet: {
          totals: [
            {
              $group: {
                _id: null,
                count: { $sum: 1 },
                value: { $sum: { $ifNull: ["$amount", 0] } },
                dinheiro: { $sum: { $cond: [{ $eq: ["$paymentMethod", "dinheiro"] }, "$amount", 0] } },
                pix: { $sum: { $cond: [{ $eq: ["$paymentMethod", "pix"] }, "$amount", 0] } },
                cartao: { $sum: { $cond: [{ $in: ["$paymentMethod", ["debito", "credito", "cartão"]] }, "$amount", 0] } }
              }
            }
          ],
          byProfessional: [
            {
              $group: {
                _id: "$doctor",
                total: { $sum: { $ifNull: ["$amount", 0] } },
                dinheiro: { $sum: { $cond: [{ $eq: ["$paymentMethod", "dinheiro"] }, "$amount", 0] } },
                pix: { $sum: { $cond: [{ $eq: ["$paymentMethod", "pix"] }, "$amount", 0] } },
                cartao: { $sum: { $cond: [{ $in: ["$paymentMethod", ["debito", "credito", "cartão"]] }, "$amount", 0] } }
              }
            }
          ]
        }
      }
    ]
    )]);

  // Processar resultados das agregações
  const aptTotals = appointmentMetrics[0].totals[0] || { count: 0, value: 0, absences: 0, estimatedLoss: 0 };
  const payTotals = paymentMetrics[0].totals[0] || { count: 0, value: 0, dinheiro: 0, pix: 0, cartao: 0 };

  const report = {
    date: date.toLocaleDateString('pt-BR'),
    period: { start: startDate.toISOString(), end: endDate.toISOString() },
    totals: {
      scheduled: { count: aptTotals.count, value: aptTotals.value },
      completed: {
        count: sessionMetrics.reduce((s, m) => s + m.completed, 0),
        value: sessionMetrics.reduce((s, m) => s + m.completedValue, 0)
      },
      payments: {
        count: payTotals.count,
        value: payTotals.value,
        methods: { dinheiro: payTotals.dinheiro, pix: payTotals.pix, cartão: payTotals.cartao }
      },
      absences: { count: aptTotals.absences, estimatedLoss: aptTotals.estimatedLoss }
    },
    byProfessional: {}
  };

  // Unificar dados por profissional
  const professionals = {};

  // Mapear agendamentos
  appointmentMetrics[0].byProfessional.forEach(p => {
    const id = p._id.toString();
    professionals[id] = {
      doctorId: id,
      doctorName: p.doctorName || 'N/A',
      scheduled: p.scheduled,
      scheduledValue: p.scheduledValue,
      completed: 0,
      completedValue: 0,
      absences: p.absences,
      payments: { total: 0, methods: { dinheiro: 0, pix: 0, cartão: 0 } }
    };
  });

  // Mesclar sessões
  sessionMetrics.forEach(p => {
    const id = p._id.toString();
    if (!professionals[id]) professionals[id] = { doctorId: id, doctorName: 'N/A', scheduled: 0, scheduledValue: 0, completed: 0, completedValue: 0, absences: 0, payments: { total: 0, methods: { dinheiro: 0, pix: 0, cartão: 0 } } };
    professionals[id].completed = p.completed;
    professionals[id].completedValue = p.completedValue;
  });

  // Mesclar pagamentos
  paymentMetrics[0].byProfessional.forEach(p => {
    const id = p._id.toString();
    if (!professionals[id]) professionals[id] = { doctorId: id, doctorName: 'N/A', scheduled: 0, scheduledValue: 0, completed: 0, completedValue: 0, absences: 0, payments: { total: 0, methods: { dinheiro: 0, pix: 0, cartão: 0 } } };
    professionals[id].payments.total = p.total;
    professionals[id].payments.methods.dinheiro = p.dinheiro;
    professionals[id].payments.methods.pix = p.pix;
    professionals[id].payments.methods.cartão = p.cartao;
  });

  report.byProfessional = Object.values(professionals);
  return report;
}
