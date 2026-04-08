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
    
    console.log(`[DailyClosingService] Payments encontrados: ${payments.length}`);
    payments.forEach(p => {
        console.log(`  - ${p.patient?.fullName || 'N/A'}: R$${p.amount}, createdAt: ${p.createdAt}`);
    });

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
    console.log(`[DailyClosingService] Após filtro: ${filteredPayments.length} pagamentos`);

    // ======================================================
    // 7. CALCULAR SUMÁRIOS
    // ======================================================
    const appointmentSummary = calculateAppointmentSummary(uniqueAppointments);
    const financialSummary = calculateFinancialSummary(filteredPayments, uniqueAppointments);
    const insuranceSummary = calculateInsuranceSummary(sessions);

    // ======================================================
    // 7b. CALCULAR CASH FLOW SEPARADO (caixa real vs produção)
    // ======================================================
    const cashFlow = calculateCashFlow(filteredPayments, targetDate, startOfDay, endOfDay);

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
            insurance: insuranceSummary,
            cashFlow: cashFlow  // 🆕 NOVO: separação de caixa
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

/**
 * Calcula o cash flow separado para distinguir:
 * - Dinheiro que entrou hoje (total)
 * - Adiantamentos (sessões futuras)
 * - Receita de hoje (sessões de hoje pagas hoje)
 * - Consumo de pacote (não é dinheiro novo)
 * - Convênio (produção, não caixa)
 */
function calculateCashFlow(payments, targetDate, startOfDay, endOfDay) {
    const result = {
        // 💰 Caixa total que entrou hoje
        cashInToday: 0,
        
        // ⏩ Adiantamentos (sessões futuras)
        advancePayments: 0,
        advanceCount: 0,
        
        // ✅ Sessões de hoje pagas hoje
        realTodaySessions: 0,
        realTodayCount: 0,
        
        // 📦 Consumo de pacote (já pago anteriormente)
        packageConsumption: 0,
        packageCount: 0,
        
        // 🏥 Convênio (produção, não caixa)
        insuranceProduction: 0,
        insuranceCount: 0,
        
        // 📊 Detalhes para debug
        details: {
            cashIn: [],
            advance: [],
            package: [],
            insurance: [],
            realToday: []
        }
    };

    console.log(`[calculateCashFlow] Processando ${payments.length} pagamentos...`);
    
    for (const p of payments) {
        const amount = p.amount || 0;
        const baseInfo = {
            id: p._id?.toString(),
            amount: amount,
            patient: p.patient?.fullName || 'N/A',
            method: p.paymentMethod
        };
        
        console.log(`  - ${baseInfo.patient}: R$${amount}, package: ${p.package ? 'SIM' : 'Não'}, kind: ${p.kind}`);

        // 🏥 CONVÊNIO - não entra no caixa, é produção
        if (p.billingType === 'convenio' || p.paymentMethod === 'convenio' || 
            p.insurance?.status || p.serviceType === 'convenio_session') {
            result.insuranceProduction += amount;
            result.insuranceCount++;
            result.details.insurance.push(baseInfo);
            console.log(`    -> CONVÊNIO`);
            continue;
        }

        // 📦 PACOTE - consumo de crédito antigo
        if (p.package || p.kind === 'package_receipt' || p.kind === 'session_payment') {
            result.packageConsumption += amount;
            result.packageCount++;
            result.details.package.push(baseInfo);
            console.log(`    -> PACOTE (não entra no caixa)`);
            continue;
        }

        // Verifica se é adiantamento (sessão futura)
        const paymentDate = p.paymentDate || p.createdAt;
        const appointmentDate = p.appointment?.date || p.session?.date;
        console.log(`    appointmentDate: ${appointmentDate}, targetDate: ${targetDate}`);
        
        // Se tem data de agendamento/sessão e é futura = adiantamento
        let isAdvance = false;
        if (appointmentDate) {
            const aptDateStr = typeof appointmentDate === 'string' 
                ? appointmentDate.substring(0, 10) 
                : moment(appointmentDate).format('YYYY-MM-DD');
            if (aptDateStr > targetDate) {
                isAdvance = true;
            }
        }

        if (isAdvance) {
            // ⏩ ADIANTAMENTO - dinheiro entrou hoje, mas serviço é futuro
            result.advancePayments += amount;
            result.advanceCount++;
            result.cashInToday += amount; // Entra no caixa
            result.details.advance.push(baseInfo);
        } else {
            // ✅ SESSÃO DE HOJE - realizada e paga hoje
            result.realTodaySessions += amount;
            result.realTodayCount++;
            result.cashInToday += amount; // Entra no caixa
            result.details.realToday.push(baseInfo);
        }
    }

    // Total de caixa é a soma de adiantamentos + sessões de hoje
    // (pacotes e convênios são separados)
    
    console.log(`[DailyClosingService] CashFlow:`, {
        cashInToday: result.cashInToday,
        advancePayments: result.advancePayments,
        realTodaySessions: result.realTodaySessions,
        packageConsumption: result.packageConsumption,
        insuranceProduction: result.insuranceProduction
    });

    return result;
}

export default { calculateDailyClosing };
