// services/paymentService.js
export const handleSessionPayment = ({ pkg, amount, paymentMethod }) => {
    if (!['fonoaudiologia', 'terapia_ocupacional', 'psicologia', 'fisioterapia'].includes(pkg.type)) {
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
            status: pkg.paymentType === 'per-session' ? 'pago' : 'pendente',
        };
        pkg.payments.push(newPayment);
    }

    return pkg;
};

import mongoose from 'mongoose';
import Appointment from '../models/Appointment.js';
import Session from '../models/Session.js';
import Payment from '../models/Payment.js';

async function generateDailyReport(date) {
  // 1. Converter data para intervalo do dia
  const startDate = new Date(date);
  startDate.setHours(0, 0, 0, 0);
  
  const endDate = new Date(date);
  endDate.setHours(23, 59, 59, 999);

  // 2. Buscar dados necessários em paralelo
  const [appointments, sessions, payments] = await Promise.all([
    // Agendamentos do dia
    Appointment.find({
      date: { $gte: startDate, $lte: endDate }
    }).populate('doctor patient'),

    // Sessões realizadas
    Session.find({
      date: { $gte: startDate, $lte: endDate },
      status: 'completed'
    }),

    // Pagamentos do dia
    Payment.find({
      createdAt: { $gte: startDate, $lte: endDate },
      status: 'paid'
    })
  ]);

  // 3. Inicializar estrutura do relatório
  const report = {
    date: date.toLocaleDateString('pt-BR'),
    period: {
      start: startDate.toISOString(),
      end: endDate.toISOString()
    },
    totals: {
      scheduled: { count: 0, value: 0 },
      completed: { count: 0, value: 0 },
      payments: { count: 0, value: 0, methods: { dinheiro: 0, pix: 0, cartão: 0 } },
      absences: { count: 0, estimatedLoss: 0 }
    },
    byProfessional: {}
  };

  // 4. Processar agendamentos
  appointments.forEach(appt => {
    // Contagem geral
    report.totals.scheduled.count++;
    report.totals.scheduled.value += appt.sessionValue || 0;

    // Inicializar profissional se necessário
    const doctorId = appt.doctor._id.toString();
    if (!report.byProfessional[doctorId]) {
      report.byProfessional[doctorId] = {
        doctorId,
        doctorName: appt.doctor.name,
        scheduled: 0,
        scheduledValue: 0,
        completed: 0,
        completedValue: 0,
        absences: 0,
        payments: {
          total: 0,
          methods: { dinheiro: 0, pix: 0, cartão: 0 }
        }
      };
    }

    // Atualizar dados do profissional
    const prof = report.byProfessional[doctorId];
    prof.scheduled++;
    prof.scheduledValue += appt.sessionValue || 0;

    // Verificar faltas/cancelamentos
    if (['cancelado', 'faltou'].includes(appt.operationalStatus)) {
      report.totals.absences.count++;
      report.totals.absences.estimatedLoss += appt.sessionValue || 0;
      prof.absences++;
    }
  });

  // 5. Processar sessões realizadas
  sessions.forEach(session => {
    report.totals.completed.count++;
    report.totals.completed.value += session.sessionValue || 0;

    const doctorId = session.doctor.toString();
    if (report.byProfessional[doctorId]) {
      const prof = report.byProfessional[doctorId];
      prof.completed++;
      prof.completedValue += session.sessionValue || 0;
    }
  });

  // 6. Processar pagamentos
  payments.forEach(payment => {
    report.totals.payments.count++;
    report.totals.payments.value += payment.amount;
    
    if (payment.paymentMethod) {
      report.totals.payments.methods[payment.paymentMethod] += payment.amount;
    }

    const doctorId = payment.doctor.toString();
    if (report.byProfessional[doctorId]) {
      const prof = report.byProfessional[doctorId];
      prof.payments.total += payment.amount;
      
      if (payment.paymentMethod) {
        prof.payments.methods[payment.paymentMethod] += payment.amount;
      }
    }
  });

  // 7. Converter objeto de profissionais para array
  report.byProfessional = Object.values(report.byProfessional);

  return report;
}
