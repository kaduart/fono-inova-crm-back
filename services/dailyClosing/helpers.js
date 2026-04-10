// services/dailyClosing/helpers.js
/**
 * Helpers e regras de negócio
 */

import moment from 'moment-timezone';

// Status mappings
export const mapStatusToOperational = (status) => {
    const s = (status || '').toLowerCase();
    if (s === 'completed') return 'completed';
    if (s === 'canceled' || s === 'cancelled') return 'canceled';
    if (s === 'confirmed') return 'scheduled';
    return 'scheduled';
};

export const mapStatusToClinical = (status) => {
    const s = (status || '').toLowerCase();
    if (s === 'completed') return 'completed';
    if (s === 'canceled' || s === 'cancelled') return 'missed';
    return 'pending';
};

// Payment method normalization
export const normalizePaymentMethod = (method) => {
    if (!method) return "dinheiro";
    method = String(method).toLowerCase().trim();
    if (method.includes("pix")) return "pix";
    if (method.includes("cartão") || method.includes("cartao") ||
        method.includes("card") || method.includes("credito") ||
        method.includes("débito") || method.includes("debito")) return "cartão";
    return "dinheiro";
};

// Status checks
export const isCanceled = (status) => ["canceled"].includes((status || "").toLowerCase());
export const isConfirmed = (status) => ["confirmed"].includes((status || "").toLowerCase());
export const isCompleted = (status) => ["completed"].includes((status || "").toLowerCase());

// Date helpers
export const getPaymentDate = (pay) => {
    if (!pay) return null;
    if (typeof pay.paymentDate === "string" && pay.paymentDate.trim()) {
        return pay.paymentDate;
    }
    return moment(pay.createdAt).tz("America/Sao_Paulo").format("YYYY-MM-DD");
};

// Build bulk operations for appointments
export const buildBulkOps = (sessions) => {
    return sessions
        .filter(s => s.appointmentId)
        .map(s => {
            const paidLike = ['paid', 'package_paid', 'advanced', 'partial']
                .includes(String(s.paymentStatus || '').toLowerCase()) || !!s.isPaid;

            return {
                updateOne: {
                    filter: { _id: s.appointmentId },
                    update: {
                        $set: {
                            sessionValue: s.sessionValue,
                            paymentStatus: paidLike ? (s.paymentStatus || 'paid') : (s.paymentStatus || 'pending'),
                            operationalStatus: mapStatusToOperational(s.status),
                            clinicalStatus: mapStatusToClinical(s.status),
                        }
                    }
                }
            };
        });
};

// Filter payments for target date
// ✅ CORREÇÃO: Usa createdAt ou paidAt para pegar pagamentos do dia
export const filterPaymentsByDate = (payments, targetDate) => {
    return payments.filter((p) => {
        // Verifica paidAt (data que efetivamente entrou no caixa)
        const paidAt = p.paidAt ? moment(p.paidAt).format('YYYY-MM-DD') : null;
        const isTargetPaidDate = paidAt === targetDate;
        
        // Verifica createdAt (data de criação do registro)
        const createdAt = p.createdAt ? moment(p.createdAt).format('YYYY-MM-DD') : null;
        const isTargetCreatedDate = createdAt === targetDate;
        
        // Verifica paymentDate (data informada no pagamento)
        const payDate = getPaymentDate(p);
        const isTargetPaymentDate = payDate === targetDate;
        
        // Convênio só entra quando recebido
        if (p.billingType === 'convenio' || p.paymentMethod === 'convenio') {
            const isReceived = p.insurance?.status === 'received';
            const receivedToday = p.insurance?.receivedAt &&
                moment(p.insurance.receivedAt).format('YYYY-MM-DD') === targetDate;
            return receivedToday && isReceived;
        }

        // Inclui se foi pago hoje, criado hoje, ou paymentDate é hoje
        return isTargetPaidDate || isTargetCreatedDate || isTargetPaymentDate;
    });
};

// Extract unique package IDs from appointments
export const extractPackageIds = (appointments) => {
    return [...new Set(
        appointments
            .filter(a => a.serviceType === 'package_session' && a.package?._id)
            .map(a => a.package._id.toString())
    )];
};

// Deduplicate appointments by ID
export const deduplicateAppointments = (appointments) => {
    const map = new Map();
    for (const appt of appointments) {
        const id = appt._id.toString();
        if (!map.has(id)) {
            map.set(id, appt);
        }
    }
    return Array.from(map.values());
};

/**
 * 🎯 RESOLVE VALUE - Busca valor de forma inteligente
 * NÃO confia cegamente em appointment.sessionValue (pode estar corrompido)
 * 
 * Prioridade:
 * 1. Package.sessionValue (mais confiável)
 * 2. Payment.amount (se já pago)
 * 3. Session.sessionValue (fonte da verdade)
 * 4. Appointment.sessionValue (só se > 0)
 * 5. Fallback por tipo de serviço
 */
export const resolveValue = (appointment) => {
    // 1. PACKAGE (fonte mais confiável para pacotes)
    if (appointment.package) {
        // Pacote particular
        if (appointment.package.sessionValue && appointment.package.sessionValue > 0) {
            return Number(appointment.package.sessionValue);
        }
        // Pacote convênio
        if (appointment.package.insuranceGrossAmount && appointment.package.insuranceGrossAmount > 0) {
            return Number(appointment.package.insuranceGrossAmount);
        }
        // Fallback por tipo de pacote
        if (appointment.package.type === 'convenio') return 80;
        if (appointment.package.type === 'therapy' || appointment.package.type === 'particular') return 150;
    }
    
    // 2. PAYMENT (se já existe e foi pago)
    if (appointment.payment?.amount && appointment.payment.amount > 0) {
        return Number(appointment.payment.amount);
    }
    
    // 3. SESSION (fonte da verdade quando disponível)
    if (appointment.session?.sessionValue && appointment.session.sessionValue > 0) {
        return Number(appointment.session.sessionValue);
    }
    
    // 4. APPOINTMENT sessionValue (só se > 0 e parece válido)
    if (appointment.sessionValue && appointment.sessionValue > 10) { // > 10 para evitar 0.02, 0.01
        return Number(appointment.sessionValue);
    }
    
    // 5. FALLBACK por especialidade do doutor + tipo de serviço
    const serviceType = appointment.serviceType || 'individual_session';
    const specialty = appointment.doctor?.specialty || appointment.specialty || 'default';
    
    // Valores por especialidade
    const SPECIALTY_VALUES = {
        'psicologia': { evaluation: 130, session: 130, default: 130 },
        'fonoaudiologia': { evaluation: 160, session: 160, default: 160 },
        'terapia_ocupacional': { evaluation: 160, session: 160, default: 160 },
        'fisioterapia': { evaluation: 160, session: 160, default: 160 },
        'default': { evaluation: 200, session: 150, default: 150 }
    };
    
    const spec = SPECIALTY_VALUES[specialty] || SPECIALTY_VALUES['default'];
    
    // Retorna valor baseado no tipo de serviço
    if (serviceType === 'evaluation' || serviceType === 'neuropsych_evaluation') {
        return spec.evaluation;
    }
    if (serviceType === 'return') {
        return 100;  // Retorno é sempre mais barato
    }
    if (serviceType === 'convenio_session') {
        return 80;   // Convênio tem valor fixo
    }
    
    return spec.session || spec.default;
};
