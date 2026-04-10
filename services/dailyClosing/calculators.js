// services/dailyClosing/calculators.js
// SIMPLES: Só soma o que foi realizado no dia

import { isCanceled, isCompleted, normalizePaymentMethod, resolveValue } from './helpers.js';

// Calculate summary.appointments
export const calculateAppointmentSummary = (appointments) => {
    const summary = {
        total: 0,
        attended: 0,
        canceled: 0,
        pending: 0,
        expectedValue: 0,
        novos: 0,
        recorrentes: 0
    };

    for (const appt of appointments) {
        const opStatus = appt.operationalStatus || 'scheduled';
        const clinicalStatus = appt.clinicalStatus || 'pending';
        const sessionValue = resolveValue(appt);

        summary.total++;
        
        if (isCanceled(opStatus)) {
            summary.canceled++;
        } else {
            summary.expectedValue += sessionValue;
        }
        
        if (isCompleted(clinicalStatus)) {
            summary.attended++;
        } else if (!isCanceled(opStatus)) {
            summary.pending++;
        }

        if (appt.isFirstAppointment || appt.patientType === 'new') {
            summary.novos++;
        } else {
            summary.recorrentes++;
        }
    }

    return summary;
};

// Calculate summary.financial
// 💰 CAIXA = Soma dos appointments COMPLETADOS (realizados no dia)
export const calculateFinancialSummary = (payments, appointments) => {
    const byMethod = { dinheiro: 0, pix: 0, cartão: 0 };
    
    let totalReceived = 0;
    
    // Só soma appointments completados (realizados no dia)
    appointments.forEach(a => {
        if (isCompleted(a.clinicalStatus) && a.paymentMethod !== 'convenio') {
            const valor = resolveValue(a);
            totalReceived += valor;
            
            const method = normalizePaymentMethod(a.paymentMethod);
            if (byMethod[method] !== undefined) {
                byMethod[method] += valor;
            }
        }
    });
    
    const totalExpected = appointments.reduce((sum, a) => sum + resolveValue(a), 0);
    const totalCanceled = appointments
        .filter(a => isCanceled(a.operationalStatus))
        .reduce((sum, a) => sum + resolveValue(a), 0);

    return {
        totalProduction: totalReceived,  // Produção = Caixa (só realizados)
        totalReceived,                   // 💰 Caixa real
        totalExpected,
        totalRevenue: totalExpected - totalCanceled,
        byMethod
    };
};

// Calculate summary.insurance
export const calculateInsuranceSummary = (sessions) => {
    const summary = {
        production: 0,
        received: 0,
        pending: 0,
        sessionsCount: 0
    };

    const insuranceSessions = sessions.filter(s => 
        s.package?.type === 'convenio' || 
        s.paymentMethod === 'convenio'
    );

    for (const session of insuranceSessions) {
        const pkg = session.package;
        const insuranceValue = pkg?.insuranceGrossAmount || pkg?.sessionValue || 80;

        if (session.status === 'completed') {
            summary.production += insuranceValue;
            summary.sessionsCount++;
            
            if (session.isPaid) {
                summary.received += insuranceValue;
            } else {
                summary.pending += insuranceValue;
            }
        }
    }

    return summary;
};

// Build payment maps
export const buildPaymentMaps = (payments) => {
    const byAppt = new Map();
    const byPackage = new Map();
    const byPatient = new Map();

    payments.forEach(p => {
        const apptId = p.appointment?._id?.toString() || p.appointment?.toString();
        if (apptId) {
            if (!byAppt.has(apptId)) byAppt.set(apptId, []);
            byAppt.get(apptId).push(p);
        }

        const pkgId = p.package?._id?.toString();
        if (pkgId) {
            if (!byPackage.has(pkgId)) byPackage.set(pkgId, []);
            byPackage.get(pkgId).push(p);
        }

        const patientId = p.patient?._id?.toString();
        if (patientId) {
            if (!byPatient.has(patientId)) byPatient.set(patientId, []);
            byPatient.get(patientId).push(p);
        }
    });

    return { byAppt, byPackage, byPatient };
};

// Calculate professionals stats
export const calculateProfessionals = (appointments, payments) => {
    const profMap = new Map();

    appointments.forEach(appt => {
        const doctorId = appt.doctor?._id?.toString();
        if (!doctorId) return;

        if (!profMap.has(doctorId)) {
            profMap.set(doctorId, {
                doctorId,
                doctorName: appt.doctor?.fullName || 'N/A',
                specialty: appt.doctor?.specialty || 'N/A',
                scheduled: 0,
                scheduledValue: 0,
                completed: 0,
                completedValue: 0,
                absences: 0,
                payments: { total: 0, methods: { dinheiro: 0, pix: 0, cartão: 0 } }
            });
        }

        const prof = profMap.get(doctorId);
        const sessionValue = resolveValue(appt);
        const opStatus = appt.operationalStatus || 'scheduled';

        prof.scheduled++;
        prof.scheduledValue += sessionValue;

        if (isCompleted(appt.clinicalStatus)) {
            prof.completed++;
            prof.completedValue += sessionValue;
        } else if (isCanceled(opStatus)) {
            prof.absences++;
        }
    });

    return Array.from(profMap.values());
};
