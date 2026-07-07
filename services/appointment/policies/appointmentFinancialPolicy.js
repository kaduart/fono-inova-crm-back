// back/services/appointment/policies/appointmentFinancialPolicy.js
/**
 * Appointment Financial Policy
 *
 * Política centralizada de proteção da origem financeira de um agendamento.
 * Responsabilidade: evitar downgrade acidental de origens protegidas
 * (convenio, liminar) para particular/pix em updates genéricos.
 *
 * Regras:
 * 1. Se o appointment atual é 'convenio' ou 'liminar';
 * 2. E o payload solicita billingType='particular';
 * 3. E não há flag explícita de conversão financeira (__allowFinancialConversion);
 * 4. Então preserva billingType e paymentMethod atuais, removendo os valores
 *    de downgrade do payload.
 *
 * Filosofia: defesa em profundidade com preservação silenciosa (compatibilidade
 * com clientes legados). Registra log estruturado para auditoria e detecção de
 * regressões.
 */

const PROTECTED_BILLING_TYPES = ['convenio', 'liminar'];
const PROTECTED_PAYMENT_METHODS = ['convenio', 'liminar_credit'];

/**
 * Verifica se a origem financeira atual é protegida contra downgrade.
 */
function isProtectedOrigin(appointment) {
  const billingType = appointment.billingType;
  const paymentMethod = appointment.paymentMethod;
  return (
    PROTECTED_BILLING_TYPES.includes(billingType) ||
    PROTECTED_PAYMENT_METHODS.includes(paymentMethod)
  );
}

/**
 * Verifica se o payload representa um downgrade para particular/pix.
 */
function isDowngradePayload(payload) {
  const incomingBillingType = payload.billingType;
  const incomingPaymentMethod = payload.paymentMethod;

  const isBillingDowngrade = incomingBillingType === 'particular';
  const isPaymentDowngrade = incomingPaymentMethod === 'pix';

  return isBillingDowngrade || isPaymentDowngrade;
}

/**
 * Verifica se a operação foi explicitamente autorizada a converter a origem financeira.
 *
 * TODO(architecture):
 * `__allowFinancialConversion` é uma flag temporária de compatibilidade.
 * Substituir por um WriteContext/CommandContext ou por um comando dedicado
 * (ex: ConvertAppointmentBillingCommand) após a migração dos clientes legados.
 */
function isExplicitConversionAllowed(payload) {
  return !!payload?.__allowFinancialConversion;
}

/**
 * Aplica a política financeira ao payload de update.
 *
 * @param {Object} appointment - Documento Appointment atual (mongoose ou plain object)
 * @param {Object} payload - Payload de update recebido
 * @returns {Object} payload ajustado
 */
export function applyFinancialProtection(appointment, payload) {
  if (!appointment || !payload) return payload;

  if (!isProtectedOrigin(appointment)) return payload;
  if (!isDowngradePayload(payload)) return payload;
  if (isExplicitConversionAllowed(payload)) return payload;

  const protectedBillingType = appointment.billingType;
  const protectedPaymentMethod = appointment.paymentMethod;
  const appointmentId = appointment._id?.toString?.() || appointment._id;

  const adjusted = { ...payload };

  if (adjusted.billingType === 'particular') {
    console.log(
      `[AppointmentFinancialPolicy] ⚠️ Downgrade bloqueado para appointment ${appointmentId}: ` +
        `billingType '${protectedBillingType}' → 'particular'. Preservando origem.`
    );
    adjusted.billingType = protectedBillingType;
  }

  if (adjusted.paymentMethod === 'pix') {
    console.log(
      `[AppointmentFinancialPolicy] ⚠️ Downgrade bloqueado para appointment ${appointmentId}: ` +
        `paymentMethod '${protectedPaymentMethod}' → 'pix'. Preservando origem.`
    );
    adjusted.paymentMethod = protectedPaymentMethod;
  }

  return adjusted;
}

export default { applyFinancialProtection };
