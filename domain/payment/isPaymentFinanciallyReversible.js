// domain/payment/isPaymentFinanciallyReversible.js
// Predicate canônico: um Payment só pode ser considerado "reversível" (seguro
// pra desfazer — restaurar um cancelado, ou cancelar um ativo) se não houver
// NENHUMA evidência de avanço no ciclo financeiro do convênio. Testável
// isoladamente.
//
// Extraído de services/schedule/replanInsurancePlanSessions.js (2026-08-15)
// pra ser reaproveitado por cancelAppointmentCommand.js sem criar import
// circular (replanInsurancePlanSessions.js → bulkCancelAppointmentsCommand.js
// → cancelAppointmentCommand.js; se cancelAppointmentCommand.js importasse
// de volta de replanInsurancePlanSessions.js fecharia o ciclo).
//
// Nota: o fluxo canônico de cancelamento (cancelAppointmentCommand) sempre
// marca o Payment como status='canceled' — então o check de BLOCKED_STATUSES
// aqui só pega o caso de dado legado/fora do fluxo canônico ou de checagem
// PRÉ-cancelamento (status ainda não é 'canceled'). Quem realmente detecta
// avanço financeiro pós-cancelamento são os campos `insurance.*`/`paidAt`/
// `financialDate`, que o cancelamento nunca limpa (preserva o histórico de
// faturamento/recebimento).
export function isPaymentFinanciallyReversible(payment) {
  if (!payment) return true; // sem payment vinculado, nada a reverter
  const BLOCKED_STATUSES = ['billed', 'paid', 'partial', 'refunded'];
  if (BLOCKED_STATUSES.includes(payment.status)) return false;
  const insuranceStatus = payment.insurance?.status;
  if (insuranceStatus === 'billed' || insuranceStatus === 'received') return false;
  if ((payment.insurance?.receivedAmount || 0) > 0) return false;
  if (payment.insurance?.billedAt || payment.insurance?.receivedAt) return false;
  if (payment.paidAt) return false;
  if (payment.financialDate) return false;
  return true;
}
