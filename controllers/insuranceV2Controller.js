import Payment from '../models/Payment.js';
import Patient from '../models/Patient.js';
import Session from '../models/Session.js';
import Appointment from '../models/Appointment.js';
import { createBatch, sendBatch, processReturn } from '../services/insuranceBatchService.js';
import InsuranceBatch from '../models/InsuranceBatch.js';
import mongoose from 'mongoose';

// GET /api/v2/payments/insurance/receivables
export async function getInsuranceReceivables(req, res) {
  try {
    const { provider, status, month } = req.query;
    
    const matchFilter = { billingType: 'convenio' };
    
    if (status) {
      matchFilter['insurance.status'] = status;
    } else {
      matchFilter['insurance.status'] = { $in: ['pending_billing', 'billed'] };
    }
    
    if (provider) matchFilter['insurance.provider'] = provider;
    if (month) matchFilter['paymentDate'] = { $regex: `^${month}` };
    
    const payments = await Payment.find(matchFilter)
      .populate('patient', 'fullName phone')
      .populate('session', 'date time specialty')
      .populate('appointment', 'date time')
      .populate('package', 'insuranceProvider insuranceGuide')
      .sort({ 'session.date': -1 });
    
    // Agrupar por CONVÊNIO (formato que InsuranceTab.tsx espera)
    const grouped = {};
    
    for (const payment of payments) {
      const providerName = payment.insurance?.provider || payment.package?.insuranceProvider || 'Outros';
      const patientId = payment.patient?._id?.toString();
      if (!patientId) continue;
      
      if (!grouped[providerName]) {
        grouped[providerName] = {
          _id: providerName,
          name: providerName,
          totalPending: 0,
          count: 0,
          patients: []
        };
      }
      
      // Encontrar ou criar o paciente neste grupo
      let patientGroup = grouped[providerName].patients.find(p => p.patientId === patientId);
      if (!patientGroup) {
        patientGroup = {
          patientId: patientId,
          patientName: payment.patient.fullName,
          total: 0,
          count: 0,
          payments: []
        };
        grouped[providerName].patients.push(patientGroup);
      }
      
      const grossAmount = payment.insurance?.grossAmount || payment.amount || 0;
      
      // Atualizar totais
      grouped[providerName].totalPending += grossAmount;
      grouped[providerName].count += 1;
      patientGroup.total += grossAmount;
      patientGroup.count += 1;
      
      // Adicionar payment
      patientGroup.payments.push({
        paymentId: payment._id.toString(),
        grossAmount: grossAmount,
        status: payment.insurance?.status || 'pending_billing',
        paymentDate: payment.paymentDate,
        authorizationCode: payment.insurance?.authorizationCode,
        specialty: payment.session?.specialty || 'Outros'
      });
    }
    
    const result = Object.values(grouped);
    
    const summary = {
      totalProviders: result.length,
      grandTotal: result.reduce((sum, g) => sum + g.totalPending, 0),
      pendingCount: payments.filter(p => p.insurance?.status === 'pending_billing').length
    };
    
    res.json({ success: true, data: result, summary });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
}

// POST /api/v2/financial/convenio/faturar-lote
export async function faturarLote(req, res) {
  try {
    const { paymentIds, dataFaturamento, notaFiscal } = req.body;
    const userId = req.user?._id;
    
    if (!paymentIds || !Array.isArray(paymentIds) || paymentIds.length === 0) {
      return res.status(400).json({ success: false, error: 'paymentIds obrigatório' });
    }
    
    // Buscar payments para determinar provider e período
    const payments = await Payment.find({
      _id: { $in: paymentIds },
      billingType: 'convenio'
    }).populate('session');
    
    if (payments.length === 0) {
      return res.status(404).json({ success: false, error: 'Nenhum payment encontrado' });
    }
    
    const provider = payments[0].insurance?.provider || 'convenio';
    const dates = payments.map(p => p.session?.date).filter(Boolean).sort();
    const startDate = dates[0];
    const endDate = dates[dates.length - 1];
    
    // 1. Criar batch V2
    const batch = await createBatch({
      insuranceProvider: provider,
      startDate,
      endDate,
      userId
    });
    
    // 2. Enviar batch V2
    await sendBatch(batch._id, userId);
    
    res.json({
      success: true,
      message: `${payments.length} atendimentos faturados`,
      data: { batchId: batch._id, faturados: payments.length }
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
}

// POST /api/v2/financial/convenio/receber-lote
export async function receberLote(req, res) {
  try {
    const { paymentIds, dataRecebimento } = req.body;
    
    if (!paymentIds || !Array.isArray(paymentIds) || paymentIds.length === 0 || !dataRecebimento) {
      return res.status(400).json({ success: false, error: 'paymentIds e dataRecebimento obrigatórios' });
    }
    
    // Buscar batch que contém esses payments
    const batches = await InsuranceBatch.find({
      'sessions.payment': { $in: paymentIds.map(id => new mongoose.Types.ObjectId(id)) }
    });
    
    // Montar returnData
    const returnItems = await Promise.all(paymentIds.map(async (pid) => {
      const payment = await Payment.findById(pid);
      return {
        paymentId: pid,
        sessionId: payment?.session?.toString(),
        status: 'paid',
        returnAmount: payment?.insurance?.grossAmount || payment?.amount || 0
      };
    }));
    
    // Processar retorno em cada batch afetado
    const processedBatches = [];
    for (const batch of batches) {
      const result = await processReturn(batch._id, {
        items: returnItems,
        protocolNumber: `REC-${Date.now()}`,
        force: false
      });
      processedBatches.push(result);
    }
    
    res.json({
      success: true,
      message: `${paymentIds.length} pagamentos recebidos`,
      data: { recebidos: paymentIds.length, batches: processedBatches.length }
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
}

export default {
  getInsuranceReceivables,
  faturarLote,
  receberLote
};
