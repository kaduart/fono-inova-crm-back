// services/dailyClosing/index.js
/**
 * Daily Closing Service - API Pública
 * 
 * Extrai toda a lógica do legado (/payments/daily-closing)
 * em módulos organizados e testáveis
 */

import moment from 'moment-timezone';
import Appointment from '../../models/Appointment.js';
import {
    fetchSessions,
    fetchAppointmentsCreated,
    fetchAppointmentsToday,
    fetchPayments,
    fetchHistoricalPackagePayments
} from './queries.js';
import {
    buildBulkOps,
    filterPaymentsByDate,
    extractPackageIds,
    deduplicateAppointments
} from './helpers.js';
import {
    calculateAppointmentSummary,
    calculateFinancialSummary,
    calculateInsuranceSummary,
    buildPaymentMaps,
    calculateProfessionals
} from './calculators.js';

/**
 * Calcula o fechamento diário completo
 * @param {string} date - Data no formato YYYY-MM-DD
 * @param {string} clinicId - ID da clínica (opcional)
 * @returns {Object} Relatório completo no mesmo formato do legado
 */
export async function calculateDailyClosing(date, clinicId) {
    const targetDate = date 
        ? moment.tz(date, "America/Sao_Paulo").format("YYYY-MM-DD")
        : moment.tz(new Date(), "America/Sao_Paulo").format("YYYY-MM-DD");

    const startOfDay = moment.tz(`${targetDate}T00:00:00`, "America/Sao_Paulo").toDate();
    const endOfDay = moment.tz(`${targetDate}T23:59:59`, "America/Sao_Paulo").toDate();

    console.log(`[DailyClosingService] Calculando: ${targetDate}`);

    // ======================================================
    // 1. BUSCAR SESSIONS
    // ======================================================
    const sessions = await fetchSessions(targetDate);

    // ======================================================
    // 2. BULKWRITE EM APPOINTMENTS (igual ao legado)
    // ======================================================
    if (sessions.length > 0) {
        const bulkOps = buildBulkOps(sessions);
        if (bulkOps.length > 0) {
            await Appointment.bulkWrite(bulkOps, { ordered: false })
                .catch(e => console.error('[DailyClosingService] bulkWrite error:', e.message));
        }
    }

    // ======================================================
    // 3. QUERIES PARALELAS
    // ======================================================
    const [appointmentsCreated, appointmentsToday, payments] = await Promise.all([
        fetchAppointmentsCreated(startOfDay, endOfDay),
        fetchAppointmentsToday(startOfDay, endOfDay, targetDate),
        fetchPayments(startOfDay, endOfDay, targetDate)
    ]);

    // ======================================================
    // 4. DEDUPLICAR E PROCESSAR
    // ======================================================
    const uniqueAppointments = deduplicateAppointments(appointmentsToday);
    const packageIds = extractPackageIds(uniqueAppointments);
    
    // Pagamentos históricos de pacotes
    const historicalPayments = await fetchHistoricalPackagePayments(packageIds);
    const allPayments = [
        ...payments,
        ...historicalPayments.filter(hp => 
            !payments.some(p => p._id.toString() === hp._id.toString())
        )
    ];

    // ======================================================
    // 5. MAPS PARA PERFORMANCE
    // ======================================================
    const paymentMaps = buildPaymentMaps(allPayments);

    // ======================================================
    // 6. FILTRAR PAGAMENTOS DO DIA
    // ======================================================
    const filteredPayments = filterPaymentsByDate(payments, targetDate);

    // ======================================================
    // 7. CALCULAR SUMÁRIOS
    // ======================================================
    const appointmentSummary = calculateAppointmentSummary(uniqueAppointments);
    const financialSummary = calculateFinancialSummary(filteredPayments, uniqueAppointments);
    const insuranceSummary = calculateInsuranceSummary(sessions);

    // ======================================================
    // 8. CALCULAR PROFISSIONAIS
    // ======================================================
    const professionals = calculateProfessionals(uniqueAppointments, filteredPayments);

    // ======================================================
    // 9. MONTAR RELATÓRIO FINAL (mesmo formato do legado)
    // ======================================================
    const report = {
        date: targetDate,
        summary: {
            appointments: appointmentSummary,
            financial: financialSummary,
            insurance: insuranceSummary
        },
        timelines: {
            appointments: uniqueAppointments.map(a => ({
                id: a._id.toString(),
                patient: a.patient?.fullName,
                phone: a.patient?.phone || a.patientInfo?.phone || null,
                patientType: a.patientType || null,
                service: a.serviceType,
                doctor: a.doctor?.fullName,
                sessionValue: Number(a.sessionValue || 0),
                operationalStatus: a.operationalStatus,
                clinicalStatus: a.clinicalStatus,
                date: a.date,
                time: a.time,
                isPackage: !!(a.package),
                packageId: a.package?._id?.toString() || null,
                paymentMethod: a.paymentMethod || '—',
                isConvenio: a.serviceType === 'convenio_session' || a.paymentMethod === 'convenio',
                insuranceProvider: a.insuranceProvider || null,
            })),
            payments: filteredPayments.map(p => ({
                id: p._id.toString(),
                amount: p.amount,
                method: p.paymentMethod,
                patient: p.patient?.fullName,
                doctor: p.doctor?.fullName,
                date: getPaymentDate(p)
            })),
            insuranceSessions: sessions
                .filter(s => s.package?.type === 'convenio' || s.paymentMethod === 'convenio')
                .map(s => ({
                    id: s._id.toString(),
                    time: s.time,
                    patient: s.patient?.fullName || 'N/A',
                    provider: s.package?.insuranceProvider || 'Convênio',
                    insuranceValue: s.package?.insuranceGrossAmount || 80,
                    status: s.status
                }))
        },
        professionals,
        timeSlots: [], // TODO: Implementar se necessário
        appointments: uniqueAppointments.map(a => ({
            id: a._id.toString(),
            patient: a.patient?.fullName,
            doctor: a.doctor?.fullName,
            time: a.time,
            status: a.operationalStatus,
            sessionValue: a.sessionValue
        })),
        payments: filteredPayments.map(p => ({
            id: p._id.toString(),
            amount: p.amount,
            method: p.paymentMethod,
            patient: p.patient?.fullName
        }))
    };

    console.log(`[DailyClosingService] Completo: ${targetDate}`, {
        appointments: appointmentSummary.total,
        payments: filteredPayments.length,
        totalReceived: financialSummary.totalReceived
    });

    return report;
}

// Helper importado para timelines
import { getPaymentDate } from './helpers.js';

export default { calculateDailyClosing };
