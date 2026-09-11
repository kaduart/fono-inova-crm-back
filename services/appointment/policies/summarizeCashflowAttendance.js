const remainingStatuses = new Set(['scheduled', 'confirmed', 'pending', 'paid', 'processing_complete']);

// Contagem operacional, independente de recebimentos e valores de produção.
export function summarizeCashflowAttendance(appointments) {
    const summary = { realizados: 0, faltantes: 0 };
    for (const appointment of appointments) {
        if (appointment.operationalStatus === 'completed') {
            summary.realizados++;
        } else if (
            remainingStatuses.has(appointment.operationalStatus) &&
            appointment.missed !== true &&
            appointment.clinicalStatus !== 'missed'
        ) {
            summary.faltantes++;
        }
    }
    return { ...summary, total: summary.realizados + summary.faltantes };
}
