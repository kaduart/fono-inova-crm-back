// services/dailyClosing/calculators.js
/**
 * Cálculos puros (sem queries, só processamento)
 */

import {
    isCanceled,
    isConfirmed,
    isCompleted,
    normalizePaymentMethod,
    getPaymentDate
} from './helpers.js';

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
        const sessionValue = Number(appt.sessionValue || 0);

        summary.total++;
        summary.expectedValue += sessionValue;

        if (isCanceled(opStatus)) summary.canceled++;
        else if (isConfirmed(opStatus) || isCompleted(clinicalStatus)) summary.attended++;
        else summary.pending++;

        // Novos vs Recorrentes
        if (appt.isFirstAppointment || appt.patientType === 'new') {
            summary.novos++;
        } else {
            summary.recorrentes++;
        }
    }

    return summary;
};

// Calculate summary.financial
export const calculateFinancialSummary = (payments, appointments) => {
    const byMethod = { dinheiro: 0, pix: 0, cartão: 0 };
    
    payments.forEach(p => {
        const method = normalizePaymentMethod(p.paymentMethod);
        if (byMethod[method] !== undefined) {
            byMethod[method] += p.amount || 0;
        }
    });

    const totalReceived = payments.reduce((sum, p) => sum + (p.amount || 0), 0);
    const totalExpected = appointments.reduce((sum, a) => sum + Number(a.sessionValue || 0), 0);
    const totalCanceled = appointments
        .filter(a => isCanceled(a.operationalStatus))
        .reduce((sum, a) => sum + Number(a.sessionValue || 0), 0);

    return {
        totalReceived,
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
        s.paymentMethod === 'convenio' ||
        s.billingType === 'convenio'
    );

    for (const session of insuranceSessions) {
        const pkg = session.package;
        const insuranceValue = pkg?.insuranceGrossAmount || pkg?.sessionValue || 80;
        const isSessionCompleted = session.status === 'completed';

        if (isSessionCompleted) {
            summary.production += insuranceValue;
            summary.sessionsCount += 1;
            
            if (session.isPaid) {
                summary.received += insuranceValue;
            } else {
                summary.pending += insuranceValue;
            }
        }
    }

    return summary;
};

// Build payment maps for O(1) lookup
export const buildPaymentMaps = (payments) => {
    const byAppt = new Map();
    const byPackage = new Map();
    const byPatient = new Map();

    payments.forEach(p => {
        const apptId = p.appointment?._id?.toString();
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

    // Group appointments by doctor
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
        const sessionValue = Number(appt.sessionValue || 0);
        const opStatus = appt.operationalStatus || 'scheduled';
        const clinicalStatus = appt.clinicalStatus || 'pending';

        prof.scheduled++;
        prof.scheduledValue += sessionValue;

        if (isCompleted(clinicalStatus)) {
            prof.completed++;
            prof.completedValue += sessionValue;
        } else if (isCanceled(opStatus)) {
            prof.absences++;
        }
    });

    // Add payments to professionals
    payments.forEach(p => {
        const doctorId = p.doctor?._id?.toString();
        if (!doctorId || !profMap.has(doctorId)) return;

        const prof = profMap.get(doctorId);
        prof.payments.total += p.amount || 0;
        
        const method = normalizePaymentMethod(p.paymentMethod);
        if (prof.payments.methods[method] !== undefined) {
            prof.payments.methods[method] += p.amount || 0;
        }
    });

    return Array.from(profMap.values());
};
