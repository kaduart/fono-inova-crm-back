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
// ✅ CORREÇÃO: Usa createdAt para pegar pagamentos criados no dia
export const filterPaymentsByDate = (payments, targetDate) => {
    return payments.filter((p) => {
        // Verifica paymentDate (data do pagamento)
        const payDate = getPaymentDate(p);
        const isTargetPaymentDate = payDate === targetDate;
        
        // Verifica createdAt (data de criação do registro)
        const createdAt = p.createdAt ? moment(p.createdAt).format('YYYY-MM-DD') : null;
        const isTargetCreatedDate = createdAt === targetDate;
        
        // Convênio só entra quando recebido
        if (p.billingType === 'convenio' || p.paymentMethod === 'convenio') {
            const isReceived = p.insurance?.status === 'received';
            const receivedToday = p.insurance?.receivedAt &&
                moment(p.insurance.receivedAt).format('YYYY-MM-DD') === targetDate;
            return receivedToday && isReceived;
        }

        // Inclui se foi criado hoje OU se o paymentDate é hoje
        return isTargetPaymentDate || isTargetCreatedDate;
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
