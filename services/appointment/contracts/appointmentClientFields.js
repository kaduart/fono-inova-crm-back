/**
 * Contrato único dos campos simples que atravessam cliente → create → banco → DTO.
 *
 * Estes campos não controlam lifecycle, referências internas nem estado financeiro.
 * Campos com transformação/regra de domínio (IDs, data/hora, status, billingType,
 * paymentMethod, sessionValue etc.) continuam explícitos nos commands/services.
 *
 * Para adicionar um novo campo simples do modal:
 *   1. adicione-o ao schema Appointment;
 *   2. registre-o somente aqui, com o default público esperado.
 * Command, HybridService e DTO consomem este mesmo contrato.
 */
export const APPOINTMENT_CLIENT_FIELD_CONTRACT = Object.freeze({
  responsible: { outputDefault: '', normalizeOutput: value => value || '' },
  sessionType: { outputDefault: null, normalizeOutput: value => value || null },
  preferredPeriod: { outputDefault: null, normalizeOutput: value => value || null },
  metadata: {
    outputDefault: null,
    normalizeInput: value => {
      const source = value?.origin?.source;
      return source ? { origin: { source } } : undefined;
    },
    normalizeOutput: value => value || null,
  },
  insuranceProvider: { outputDefault: null, normalizeOutput: value => value || null },
  insuranceValue: { outputDefault: 0, normalizeOutput: value => value ?? 0 },
  authorizationCode: { outputDefault: null, normalizeOutput: value => value || null },
});

export const APPOINTMENT_CLIENT_FIELD_NAMES = Object.freeze(
  Object.keys(APPOINTMENT_CLIENT_FIELD_CONTRACT)
);

/**
 * Copia somente campos declarados no contrato. Nunca propaga chaves `__*` nem
 * campos financeiros/lifecycle não declarados, evitando mass assignment.
 */
export function pickAppointmentClientFields(source, { includeDefaults = false } = {}) {
  const picked = {};
  const input = source || {};
  const nested = input.clientFields && typeof input.clientFields === 'object'
    ? input.clientFields
    : null;

  for (const field of APPOINTMENT_CLIENT_FIELD_NAMES) {
    // O envelope elimina whitelists duplicadas no frontend. Top-level permanece
    // como fallback para clientes atuais e integrações que ainda não o enviam.
    const value = nested?.[field] !== undefined ? nested[field] : input[field];
    if (value !== undefined) {
      const config = APPOINTMENT_CLIENT_FIELD_CONTRACT[field];
      const normalized = includeDefaults
        ? (config.normalizeOutput ? config.normalizeOutput(value) : value)
        : (config.normalizeInput ? config.normalizeInput(value) : value);
      if (normalized !== undefined) picked[field] = normalized;
    } else if (includeDefaults) {
      picked[field] = APPOINTMENT_CLIENT_FIELD_CONTRACT[field].outputDefault;
    }
  }

  return picked;
}

/**
 * Aplica validações que dependem do schema sem duplicá-las nos serviços de create.
 */
export function buildAppointmentClientFieldsForModel(source, AppointmentModel) {
  const fields = pickAppointmentClientFields(source);
  const sessionTypes = AppointmentModel?.schema?.path('sessionType')?.enumValues || [];

  if (fields.sessionType !== undefined && !sessionTypes.includes(fields.sessionType)) {
    delete fields.sessionType;
  }

  return fields;
}
