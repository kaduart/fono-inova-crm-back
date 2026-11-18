// Envio de um job da fila whatsapp-send (WhatsApp Web) pelo guarda de entregas.
// Separado do whatsapp-child.js para poder ser testado com provedor simulado.
import { guardedSend, DeliveryOutcome } from '../../infrastructure/delivery/deliveryGuard.js';

/**
 * @returns {Promise<{ result: object|null, outcome: string }>}
 *   result != null quando a mensagem saiu agora (SENT) ou já tinha saído
 *   (ALREADY_SENT, com o id gravado). null = não enviar e não marcar nada.
 *   Lança o erro original quando ele prova que nada saiu (o BullMQ retenta).
 * leaseMs: modo externo (conector), onde envio + consulta do resultado incerto levam até ~2 min.
 * A chave é a mesma nos dois modos: trocar de modo no meio de um job não reenvia.
 */
export function deliveryKeyFor(jobId) { return `wweb:send:${jobId}`; }

export async function deliverWhatsAppWebJob({ jobId, phone, send, leaseMs }) {
  const delivery = await guardedSend({
    channel: 'whatsapp',
    deliveryKey: deliveryKeyFor(jobId),
    destination: phone,
    providerMessageIdOf: (r) => r?.messageId || null,
    send,
    ...(leaseMs ? { leaseMs } : {}),
  });
  if (delivery.outcome === DeliveryOutcome.SENT) return { result: delivery.result, outcome: delivery.outcome };
  if (delivery.outcome === DeliveryOutcome.ALREADY_SENT) {
    return { result: { success: true, messageId: delivery.providerMessageId || null, alreadySent: true }, outcome: delivery.outcome };
  }
  return { result: null, outcome: delivery.outcome };
}
