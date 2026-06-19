/**
 * ============================================================
 * RESOLVE PAYMENT KIND
 * ============================================================
 *
 * Determina o `kind` de um Payment baseado em seus relacionamentos.
 * Usada tanto no enforcement layer quanto no backfill.
 *
 * Regras (ordem de prioridade):
 *   1. amount < 0 ou descrição de ajuste → manual_adjustment
 *   2. package relacionado → package_payment
 *   3. session ou appointment relacionado → session_payment
 *   4. sem patient → unknown_or_orphan
 *   5. fallback → session_payment (padrão do dataset histórico)
 *
 * Retorna: { kind, confidence, reason }
 * ============================================================
 */

export function resolvePaymentKind(payment) {
    const amount = payment.amount || 0;
    const description = (payment.description || payment.notes || '').toLowerCase();
    const hasPackage = !!payment.package;
    const hasSession = !!payment.session || !!(payment.sessions && payment.sessions.length > 0);
    const hasAppointment = !!payment.appointment;
    const hasPatient = !!payment.patient;

    if (amount < 0 || description.includes('ajuste') || description.includes('correção') || description.includes('correcao') || description.includes('manual') || description.includes('diferença') || description.includes('diferenca')) {
        return { kind: 'manual_adjustment', confidence: 'high', reason: 'amount_negative_or_description' };
    }

    if (hasPackage) {
        return { kind: 'package_payment', confidence: 'high', reason: 'has_package_reference' };
    }

    if (hasSession || hasAppointment) {
        return { kind: 'session_payment', confidence: 'high', reason: 'has_session_or_appointment_reference' };
    }

    if (!hasPatient) {
        return { kind: 'unknown_or_orphan', confidence: 'low', reason: 'no_patient_reference' };
    }

    return { kind: 'session_payment', confidence: 'medium', reason: 'fallback_based_on_dataset_pattern' };
}

export default resolvePaymentKind;
