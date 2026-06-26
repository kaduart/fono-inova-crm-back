/**
 * 🏥 InsuranceResolverService
 *
 * Centraliza a regra de resolução do convênio e do paciente para qualquer
 * endpoint que precise agrupar/consultar dados de convênio.
 *
 * Hierarquia de resolução do convênio (provider):
 *   1. Payment.insurance.provider
 *   2. Session.insuranceProvider
 *   3. Session.insuranceGuide.insurance
 *   4. Appointment.insuranceProvider
 *   5. InsuranceBatch.insuranceProvider
 *   6. Package.insuranceProvider
 *   7. "Outros"
 *
 * Hierarquia de resolução do paciente:
 *   1. Session.patient
 *   2. Appointment.patient
 *   3. Payment.patient
 */

export const DEFAULT_PROVIDER = 'Outros';

/**
 * Resolve o nome do convênio a partir das fontes disponíveis.
 * Aceita tanto documentos populados quanto IDs/objs parciais.
 */
export function resolveInsuranceProvider({ payment, session, appointment, batch, package: pkg }) {
    const candidates = [
        payment?.insurance?.provider,
        session?.insuranceProvider,
        session?.insuranceGuide?.insurance,
        appointment?.insuranceProvider,
        batch?.insuranceProvider,
        pkg?.insuranceProvider
    ];

    for (const candidate of candidates) {
        if (candidate && String(candidate).trim()) {
            return String(candidate).trim().toLowerCase();
        }
    }

    return DEFAULT_PROVIDER;
}

/**
 * Resolve o paciente fonte de verdade a partir das fontes disponíveis.
 * Retorna o objeto populado ou o ID, conforme o input.
 */
export function resolvePatient({ payment, session, appointment }) {
    return session?.patient || appointment?.patient || payment?.patient || null;
}

/**
 * Extrai o ID do paciente resolvido.
 */
export function resolvePatientId(sources) {
    const patient = resolvePatient(sources);
    if (!patient) return null;
    return patient._id?.toString?.() || patient.toString?.();
}

/**
 * Extrai o nome de exibição do paciente resolvido.
 */
export function resolvePatientName(sources, fallback = 'N/A') {
    const patient = resolvePatient(sources);
    return patient?.fullName || fallback;
}

/**
 * Resolve o valor a ser usado para contas a receber/faturamento.
 * Prioriza o valor do seguro/payment, depois o valor da sessão.
 */
export function resolveInsuranceAmount({ payment, session }) {
    if (payment?.insurance?.grossAmount > 0) return payment.insurance.grossAmount;
    if (payment?.amount > 0) return payment.amount;
    if (session?.sessionValue > 0) return session.sessionValue;
    return 0;
}

export default {
    resolveInsuranceProvider,
    resolvePatient,
    resolvePatientId,
    resolvePatientName,
    resolveInsuranceAmount,
    DEFAULT_PROVIDER
};
