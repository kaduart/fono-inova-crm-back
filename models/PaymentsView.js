// models/PaymentsView.js
/**
 * Projection otimizada para PaymentPage
 * Read-model denormalizado - sem populates necessários
 */

import mongoose from 'mongoose';

const paymentsViewSchema = new mongoose.Schema({
    // 🔹 Identificação
    paymentId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Payment',
        required: true,
        index: true
    },
    
    // 🔹 Paciente (denormalizado)
    patient: {
        id: mongoose.Schema.Types.ObjectId,
        name: String,
        phone: String
    },
    
    // 🔹 Médico/Profissional (denormalizado)
    doctor: {
        id: mongoose.Schema.Types.ObjectId,
        name: String,
        specialty: String
    },
    
    // 🔹 Serviço
    serviceType: String, // 'evaluation', 'session', 'package', etc
    serviceLabel: String,   // 'Avaliação', 'Sessão', 'Pacote'
    specialty: String, // Especialidade do atendimento
    
    // 🔹 Financeiro (Modelo V2: produced vs received)
    amount: {
        type: Number,
        required: true
    },
    receivedAmount: {
        type: Number,
        default: 0
    },
    method: {
        type: String,
        enum: ['pix', 'cash', 'card', 'insurance', 'transfer', 'other'],
        index: true
    },
    methodLabel: String, // 'PIX', 'Dinheiro', 'Cartão', 'Convênio'
    
    status: {
        type: String,
        enum: ['paid', 'pending', 'partial', 'canceled', 'refunded'],
        default: 'pending',
        index: true
    },
    
    type: {
        type: String,
        enum: ['revenue', 'expense', 'refund'],
        default: 'revenue',
        index: true
    },
    
    // 🔹 Categorização V2
    category: {
        type: String,
        enum: ['particular', 'package', 'insurance', 'expense'],
        index: true
    },
    
    // 🔹 Datas
    paymentDate: {
        type: String, // YYYY-MM-DD
        required: true,
        index: true
    },
    paymentMonth: {
        type: String, // YYYY-MM
        required: true,
        index: true
    },
    createdAt: {
        type: Date,
        default: Date.now
    },
    updatedAt: {
        type: Date,
        default: Date.now
    },
    
    // 🔹 Relacionamentos (para navegação)
    appointmentId: mongoose.Schema.Types.ObjectId,
    packageId: mongoose.Schema.Types.ObjectId,
    sessionId: mongoose.Schema.Types.ObjectId,
    
    // 🔹 Metadados
    notes: String,
    clinicId: {
        type: String,
        default: 'default',
        index: true
    },
    
    // 🔹 Flags
    isDeleted: {
        type: Boolean,
        default: false,
        index: true
    }
}, {
    collection: 'payments_view',
    timestamps: true
});

// 🔹 Índices compostos otimizados para queries do PaymentPage
paymentsViewSchema.index({ clinicId: 1, paymentMonth: 1, status: 1 }); // Filtro principal
paymentsViewSchema.index({ clinicId: 1, paymentDate: -1 }); // Ordenação
paymentsViewSchema.index({ clinicId: 1, category: 1, status: 1 }); // Filtro por categoria
paymentsViewSchema.index({ 'patient.name': 'text', 'doctor.name': 'text' }); // Busca textual

// 🔹 Método para atualizar a partir de um Payment
paymentsViewSchema.statics.upsertFromPayment = async function(paymentData) {
    const {
        _id, patient, doctor, amount, paymentMethod, status, billingType, kind,
        serviceType: rawServiceType, sessionType: rawSessionType,
        paymentDate: rawPaymentDate, financialDate, notes, clinicId,
        appointment, package: pkg, session, createdAt, receivedAmount
    } = paymentData;

    // Resolves a melhor fonte para campos que podem vir de Payment, Appointment ou Session
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

    // Mapear método
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

    const methodInfo = methodMap[(paymentMethod || '').toLowerCase()] || { code: 'other', label: 'Outro' };

    // Mapear categoria usando billingType (fonte canônica)
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

    // Extrair dados denormalizados
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

    // Melhor data: financialDate (V2) > paymentDate > appointment.date > session.date > createdAt
    const bestDateSource = financialDate
        || rawPaymentDate
        || resolvedAppointment?.date
        || resolvedSession?.date
        || createdAt;

    const bestDate = bestDateSource ? new Date(bestDateSource) : new Date();
    const dateStr = bestDate.toISOString().split('T')[0];
    const monthStr = bestDate.toISOString().substring(0, 7);

    const doc = {
        paymentId: _id,
        patient: patientData,
        doctor: doctorData,
        serviceType: effectiveServiceType,
        serviceLabel: serviceMap[effectiveServiceType] || 'Atendimento',
        specialty: effectiveSessionType,
        amount: amount || 0,
        receivedAmount: receivedAmount || 0, // 🔥 V2: received vs produced
        method: methodInfo.code,
        methodLabel: methodInfo.label,
        status: status === 'completed' ? 'paid' : status || 'pending',
        type: 'revenue',
        category,
        paymentDate: dateStr,
        paymentMonth: monthStr,
        notes: notes || '',
        clinicId: clinicId || 'default',
        appointmentId: resolvedAppointment?._id || appointment,
        packageId: pkg?._id || pkg,
        sessionId: resolvedSession?._id || session,
        isDeleted: false,
        updatedAt: new Date()
    };

    return this.findOneAndUpdate(
        { paymentId: _id },
        { $set: doc },
        { upsert: true, new: true }
    );
};

const PaymentsView = mongoose.model('PaymentsView', paymentsViewSchema);

export default PaymentsView;
