// Envio de um job da fila whatsapp-send (WhatsApp Web) pelo guarda de entregas.
// Separado do whatsapp-child.js para poder ser testado com provedor simulado.
import { guardedSend, DeliveryOutcome } from '../../infrastructure/delivery/deliveryGuard.js';

/**
 * @returns {Promise<{ result: object|null, outcome: string }>}
 *   result != null quando a mensagem saiu agora (SENT) ou já tinha saído
 *   (ALREADY_SENT, com o id gravado). null = não enviar e não marcar nada.
 *   Lança o erro original quando ele prova que nada saiu (o BullMQ retenta).
 */
export async function deliverWhatsAppWebJob({ jobId, phone, send }) {
  const delivery = await guardedSend({
    channel: 'whatsapp',
    deliveryKey: `wweb:send:${jobId}`,
    destination: phone,
    providerMessageIdOf: (r) => r?.messageId || null,
    send,
  });
  if (delivery.outcome === DeliveryOutcome.SENT) return { result: delivery.result, outcome: delivery.outcome };
  if (delivery.outcome === DeliveryOutcome.ALREADY_SENT) {
    return { result: { success: true, messageId: delivery.providerMessageId || null, alreadySent: true }, outcome: delivery.outcome };
  }
  return { result: null, outcome: delivery.outcome };
}
