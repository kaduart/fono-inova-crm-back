// 💰 FECHAMENTO DIÁRIO V2 - Usa Session como Fonte de Verdade
// 
// NOVA ARQUITETURA:
// - Session = verdade clínica (o que aconteceu + valor)
// - Payment = verdade financeira (dinheiro recebido)
// - Appointment = agenda/projeção (não é mais fonte de verdade)

import express from 'express';
import mongoose from 'mongoose';
import Session from '../models/Session.js';
import Payment from '../models/Payment.js';
import Doctor from '../models/Doctor.js';
import Patient from '../models/Patient.js';

const router = express.Router();

// Helper: datas do dia
function getDayRange(dateStr) {
  const start = new Date(dateStr + 'T00:00:00.000Z');
  const end = new Date(dateStr + 'T23:59:59.999Z');
  return { start, end };
}

// ============================================
// GET /api/v2/daily-closing?date=2026-04-09
// ============================================
router.get('/daily-closing-v2', async (req, res) => {
  try {
    const { date } = req.query;
    
    if (!date) {
      return res.status(400).json({ error: 'Data obrigatória (YYYY-MM-DD)' });
    }

    const { start, end } = getDayRange(date);

    console.log(`📅 Fechamento V2: ${date}`);

    // ============================================
    // 1️⃣ BUSCAR SESSIONS DO DIA (Fonte de Verdade)
    // ============================================
    const sessions = await Session.find({
      date: { $gte: start, $lte: end },
      isDeleted: { $ne: true }
    }).populate('patient', 'fullName phone')
      .populate('doctor', 'fullName specialty')
      .lean();

    console.log(`   📋 ${sessions.length} sessions encontradas`);

    // ============================================
    // 2️⃣ BUSCAR PAYMENTS DO DIA
    // ============================================
    const payments = await Payment.find({
      paymentDate: { $gte: start, $lte: end },
      status: 'paid'
    }).populate('patient', 'fullName')
      .lean();

    console.log(`   💰 ${payments.length} payments encontrados`);

    // ============================================
    // 3️⃣ CATEGORIZAR SESSIONS
    // ============================================
    const completedSessions = sessions.filter(s => s.status === 'completed');
    const scheduledSessions = sessions.filter(s => 
      ['scheduled', 'pending'].includes(s.status)
    );
    const canceledSessions = sessions.filter(s => s.status === 'canceled');
    const missedSessions = sessions.filter(s => s.status === 'missed');

    // ============================================
    // 4️⃣ CALCULAR VALORES (usando session.value)
    // ============================================
    
    // Produção real (o que aconteceu)
    const productionValue = completedSessions.reduce(
      (sum, s) => sum + (s.value || 0), 0
    );

    // Previsão (agenda futura)
    const expectedValue = scheduledSessions.reduce(
      (sum, s) => sum + (s.value || 0), 0
    );

    // Dinheiro real recebido
    const receivedValue = payments.reduce(
      (sum, p) => sum + (p.amount || 0), 0
    );

    // Por método de pagamento
    const byMethod = { dinheiro: 0, pix: 0, cartao: 0 };
    payments.forEach(p => {
      const method = p.paymentMethod || p.method || '';
      if (method.includes('pix')) byMethod.pix += p.amount;
      else if (method.includes('dinheiro') || method.includes('cash')) byMethod.dinheiro += p.amount;
      else byMethod.cartao += p.amount;
    });

    // ============================================
    // 5️⃣ MONTAR TIMELINE (sessões detalhadas)
    // ============================================
    const timelineSessions = sessions.map(s => ({
      id: s._id,
      patient: s.patient?.fullName || 'N/D',
      phone: s.patient?.phone,
      doctor: s.doctor?.fullName || 'N/D',
      specialty: s.doctor?.specialty,
      time: s.time,
      status: s.status,
      value: s.value || 0,
      hasEvolution: !!s.evolution,
      isPackage: !!s.packageId,
      packageId: s.packageId
    }));

    // ============================================
    // 6️⃣ POR PROFISSIONAL
    // ============================================
    const byDoctor = {};
    
    sessions.forEach(s => {
      const docId = s.doctor?._id?.toString();
      if (!docId) return;
      
      if (!byDoctor[docId]) {
        byDoctor[docId] = {
          doctorId: docId,
          doctorName: s.doctor.fullName,
          specialty: s.doctor.specialty,
          scheduled: 0,
          scheduledValue: 0,
          completed: 0,
          completedValue: 0,
          canceled: 0,
          missed: 0
        };
      }

      const doc = byDoctor[docId];
      
      if (s.status === 'completed') {
        doc.completed++;
        doc.completedValue += s.value || 0;
      } else if (['scheduled', 'pending'].includes(s.status)) {
        doc.scheduled++;
        doc.scheduledValue += s.value || 0;
      } else if (s.status === 'canceled') {
        doc.canceled++;
      } else if (s.status === 'missed') {
        doc.missed++;
      }
    });

    // Adicionar payments por profissional
    payments.forEach(p => {
      // Payment pode não ter doctorId direto, buscar na session
      // Simplificação: distribuir proporcionalmente ou buscar relacionamento
    });

    // ============================================
    // 7️⃣ MONTAR RESPOSTA
    // ============================================
    const response = {
      success: true,
      data: {
        date,
        summary: {
          // Produção real
          production: {
            count: completedSessions.length,
            value: productionValue
          },
          // Agenda futura
          expected: {
            count: scheduledSessions.length,
            value: expectedValue
          },
          // Cancelamentos
          canceled: {
            count: canceledSessions.length
          },
          // Faltas
          missed: {
            count: missedSessions.length
          },
          // Financeiro
          received: {
            count: payments.length,
            value: receivedValue,
            byMethod
          }
        },
        timeline: {
          sessions: timelineSessions,
          payments: payments.map(p => ({
            id: p._id,
            amount: p.amount,
            method: p.paymentMethod || p.method,
            patient: p.patient?.fullName,
            date: p.paymentDate
          }))
        },
        professionals: Object.values(byDoctor)
      },
      meta: {
        version: 'v2',
        source: 'session-based',
        totalSessions: sessions.length,
        totalPayments: payments.length
      }
    };

    console.log('✅ Fechamento calculado:');
    console.log(`   Produção: ${completedSessions.length} sessões = R$ ${productionValue}`);
    console.log(`   Esperado: ${scheduledSessions.length} sessões = R$ ${expectedValue}`);
    console.log(`   Recebido: ${payments.length} pagamentos = R$ ${receivedValue}`);

    res.json(response);

  } catch (error) {
    console.error('💥 Erro no fechamento V2:', error);
    res.status(500).json({ 
      success: false, 
      error: error.message 
    });
  }
});

export default router;
