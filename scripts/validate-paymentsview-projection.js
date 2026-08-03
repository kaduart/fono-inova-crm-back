#!/usr/bin/env node
/**
 * validate-paymentsview-projection.js
 *
 * Validação READ-ONLY da PaymentsView antes de rodar rebuild em produção.
 *
 * 1. Conta Payment vs PaymentsView existentes.
 * 2. Seleciona uma amostra de Payments.
 * 3. Simula o documento que a projeção geraria (sem salvar).
 * 4. Verifica se todos os campos usados pelo endpoint estão presentes.
 * 5. Reporta inconsistências.
 */

import mongoose from 'mongoose';
import '../models/index.js';
import Payment from '../models/Payment.js';
import PaymentsView from '../models/PaymentsView.js';

const MONGO_URI = process.env.MONGODB_URI || process.env.MONGO_URI;

if (!MONGO_URI) {
  console.error('❌ MONGODB_URI ou MONGO_URI devem estar configurados');
  process.exit(1);
}

const methodMap = {
  'pix': { code: 'pix', label: 'PIX' },
  'dinheiro': { code: 'cash', label: 'Dinheiro' },
  'cash': { code: 'cash', label: 'Dinheiro' },
  'cartao_credito': { code: 'card', label: 'Cartão Crédito' },
  'cartao_debito': { code: 'card', label: 'Cartão Débito' },
  'cartão': { code: 'card', label: 'Cartão' },
  'card': { code: 'card', label: 'Cartão' },
  'credit_card': { code: 'card', label: 'Cartão Crédito' },
  'debit_card': { code: 'card', label: 'Cartão Débito' },
  'convenio': { code: 'insurance', label: 'Convênio' },
  'plano-unimed': { code: 'insurance', label: 'Convênio' },
  'insurance': { code: 'insurance', label: 'Convênio' },
  'convenio_receivable': { code: 'insurance', label: 'Convênio' },
  'transferencia_bancaria': { code: 'transfer', label: 'Transferência' },
  'bank_transfer': { code: 'transfer', label: 'Transferência' },
  'transfer': { code: 'transfer', label: 'Transferência' },
  'liminar_credit': { code: 'other', label: 'Crédito Liminar' },
  'outro': { code: 'other', label: 'Outro' }
};

const serviceMap = {
  'evaluation': 'Avaliação',
  'session': 'Sessão',
  'package_session': 'Sessão de Pacote',
  'tongue_tie_test': 'Teste da Linguinha',
  'neuropsych_evaluation': 'Avaliação Neuropsicológica',
  'consultation': 'Consulta',
  'individual_session': 'Sessão Individual',
  'meet': 'Meet',
  'alignment': 'Alinhamento'
};

async function buildProjectionDoc(payment) {
  // Replica a lógica de PaymentsView.upsertFromPayment sem salvar
  const {
    _id, patient, doctor, amount, paymentMethod, status, billingType, kind,
    serviceType: rawServiceType, sessionType: rawSessionType,
    paymentDate: rawPaymentDate, financialDate, notes, clinicId,
    appointment, package: pkg, session, createdAt, receivedAmount
  } = payment;

  const resolvedAppointment = appointment && typeof appointment === 'object' ? appointment : null;
  const resolvedSession = session && typeof session === 'object' ? session : null;

  const effectiveServiceType = rawServiceType
    || resolvedSession?.serviceType
    || resolvedAppointment?.serviceType
    || 'session';

  const effectiveSessionType = rawSessionType
    || resolvedSession?.sessionType
    || resolvedAppointment?.sessionType
    || resolvedSession?.specialty
    || resolvedAppointment?.specialty
    || doctor?.specialty
    || 'Geral';

  const methodInfo = methodMap[(paymentMethod || '').toLowerCase()] || { code: 'other', label: 'Outro' };

  // Categoria canônica por billingType/kind (igual ao PaymentsView.upsertFromPayment)
  let category = 'particular';
  const normalizedBillingType = (billingType || '').toLowerCase();
  const normalizedKind = (kind || '').toLowerCase();

  if (normalizedBillingType === 'convenio' || normalizedBillingType === 'insurance' ||
      normalizedKind.includes('convenio') || normalizedKind.includes('insurance')) {
    category = 'insurance';
  } else if (normalizedBillingType === 'liminar' || normalizedKind.includes('liminar')) {
    category = 'particular'; // liminar é particular no dashboard financeiro
  } else if (effectiveServiceType === 'package_session' || pkg ||
             normalizedKind === 'package_receipt' || normalizedKind === 'package_settlement') {
    category = 'package';
  }

  const patientData = patient ? {
    id: patient._id || patient.id,
    name: patient.fullName || patient.name || 'Paciente',
    phone: patient.phone || patient.phoneNumber
  } : { name: 'Paciente Desconhecido' };

  const doctorData = doctor ? {
    id: doctor._id || doctor.id,
    name: doctor.fullName || doctor.name || 'Profissional',
    specialty: doctor.specialty || effectiveSessionType || 'Geral'
  } : { name: 'Profissional Desconhecido', specialty: effectiveSessionType || 'Geral' };

  const bestDateSource = financialDate
    || rawPaymentDate
    || resolvedAppointment?.date
    || resolvedSession?.date
    || createdAt;

  const bestDate = bestDateSource ? new Date(bestDateSource) : new Date();

  return {
    paymentId: _id,
    patient: patientData,
    doctor: doctorData,
    serviceType: effectiveServiceType,
    serviceLabel: serviceMap[effectiveServiceType] || 'Atendimento',
    specialty: effectiveSessionType,
    amount: amount || 0,
    receivedAmount: receivedAmount || 0,
    method: methodInfo.code,
    methodLabel: methodInfo.label,
    status: status === 'completed' ? 'paid' : status || 'pending',
    type: 'revenue',
    category,
    paymentDate: bestDate.toISOString().split('T')[0],
    paymentMonth: bestDate.toISOString().substring(0, 7),
    notes: notes || '',
    clinicId: clinicId || 'default',
    appointmentId: resolvedAppointment?._id || appointment,
    packageId: pkg?._id || pkg,
    sessionId: resolvedSession?._id || session,
    isDeleted: false
  };
}

async function main() {
  console.log('🔌 Conectando ao MongoDB...');
  await mongoose.connect(MONGO_URI);
  console.log('✅ Conectado');

  try {
    const totalPayments = await Payment.countDocuments({ isDeleted: { $ne: true } });
    const totalViews = await PaymentsView.countDocuments();
    console.log(`\n📊 Pagamentos: ${totalPayments}`);
    console.log(`📊 PaymentsView: ${totalViews}`);
    console.log(`📊 Diferença: ${totalPayments - totalViews}`);

    // Amostra de 20 pagamentos variados
    const sample = await Payment.find({ isDeleted: { $ne: true } })
      .sort({ createdAt: -1 })
      .limit(20)
      .populate('patient', 'fullName phone phoneNumber')
      .populate('doctor', 'fullName specialty')
      .populate('appointment', 'date time status')
      .populate('package', '_id name')
      .populate('session', '_id date time')
      .lean();

    console.log(`\n🧪 Amostra de ${sample.length} pagamentos`);

    let errors = 0;
    const methodCounts = {};
    const statusCounts = {};
    const categoryCounts = {};

    for (const p of sample) {
      const projected = await buildProjectionDoc(p);

      // Campos críticos para o endpoint
      const requiredFields = [
        'paymentId', 'patient', 'doctor', 'serviceType', 'serviceLabel',
        'specialty', 'amount', 'receivedAmount', 'method', 'methodLabel',
        'status', 'category', 'paymentDate', 'paymentMonth'
      ];

      for (const field of requiredFields) {
        if (projected[field] === undefined || projected[field] === null) {
          console.warn(`⚠️  Payment ${p._id}: campo ${field} vazio`);
          errors++;
        }
      }

      methodCounts[projected.method] = (methodCounts[projected.method] || 0) + 1;
      statusCounts[projected.status] = (statusCounts[projected.status] || 0) + 1;
      categoryCounts[projected.category] = (categoryCounts[projected.category] || 0) + 1;

      // Log do primeiro documento completo para inspeção
      if (sample.indexOf(p) === 0) {
        console.log('\n📄 Primeiro documento projetado:');
        console.log(JSON.stringify(projected, null, 2));
      }
    }

    console.log('\n📈 Distribuição da amostra');
    console.log('Métodos:', methodCounts);
    console.log('Status:', statusCounts);
    console.log('Categorias:', categoryCounts);

    // Verifica métodos não mapeados
    const allPaymentMethods = await Payment.distinct('paymentMethod', { isDeleted: { $ne: true } });
    const unmappedMethods = allPaymentMethods.filter(m => !methodMap[m?.toLowerCase?.()]);
    if (unmappedMethods.length > 0) {
      console.warn('\n⚠️  Métodos de pagamento não mapeados:', unmappedMethods);
    }

    // Verifica billingType que pode afetar categoria
    const billingTypes = await Payment.distinct('billingType', { isDeleted: { $ne: true } });
    console.log('\n🏷️  billingTypes encontrados:', billingTypes);

    if (errors === 0) {
      console.log('\n✅ Validação da projeção: OK');
      console.log('Próximo passo: corrigir bug do endpoint (serviceType/serviceLabel) e rodar rebuild.');
    } else {
      console.log(`\n❌ ${errors} problemas encontrados na amostra`);
    }

  } catch (error) {
    console.error('❌ Erro na validação:', error.message);
    console.error(error.stack);
  } finally {
    await mongoose.disconnect();
    console.log('\n🔌 Desconectado');
  }
}

main();
