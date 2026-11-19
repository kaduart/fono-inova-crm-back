// services/communication/manualSendOnce.js
// Envio MANUAL (atendente clicou "enviar") protegido contra reenvio.
//
// O front manda um Idempotency-Key por mensagem composta. Duplo clique,
// reenvio do navegador depois de timeout e retry de rede chegam com a MESMA
// chave e viram uma só tentativa no provedor (infrastructure/delivery/deliveryGuard.js).
// Sem a chave o comportamento é o antigo (compatibilidade com clientes velhos).
//
// Não é "exatamente uma vez": se o provedor aceitar e a resposta se perder,
// a chave fica `unknown` e o envio NÃO é repetido sozinho; a tela avisa para
// conferir no WhatsApp antes de mandar de novo.
import { guardedSend, DeliveryOutcome, destinationHash } from '../../infrastructure/delivery/deliveryGuard.js';

export const MANUAL_KEY_RE = /^[A-Za-z0-9._:-]{8,128}$/;

export function manualIdempotencyKey(req) {
    const raw = req.get?.('Idempotency-Key') ?? req.headers?.['idempotency-key'];
    if (raw === undefined || raw === null || raw === '') return { key: null };
    const key = String(raw).trim();
    if (!MANUAL_KEY_RE.test(key)) return { error: 'Idempotency-Key inválido (8 a 128 caracteres: letras, números, . _ : -)' };
    return { key };
}

export function manualDeliveryKey({ channel = 'whatsapp', actorId, key, destination }) {
    const prefix = channel === 'whatsapp' ? 'wa' : channel;
    // Destino entra na chave (só hash): a mesma chave para outro número é outro envio.
    return `${prefix}:manual:${actorId || 'anon'}:${key}:${destinationHash(channel, destination).slice(0, 12)}`;
}

/**
 * @returns {Promise<{ outcome, result?, providerMessageId?, guarded: boolean }>}
 */
export async function sendManualOnce({ key, actorId, destination, send, channel = 'whatsapp', guard = guardedSend }) {
    if (!key) return { outcome: DeliveryOutcome.SENT, result: await send(), guarded: false };
    const d = await guard({
        channel,
        deliveryKey: manualDeliveryKey({ channel, actorId, key, destination }),
        destination,
        send
    });
    return { ...d, guarded: true };
}

/** Resposta HTTP quando o envio NÃO aconteceu agora. null = seguir o fluxo normal. */
export function manualSendResponse(outcome, providerMessageId) {
    switch (outcome) {
        case DeliveryOutcome.SENT:
            return null;
        case DeliveryOutcome.ALREADY_SENT:
            return { status: 200, body: { success: true, duplicated: true, messageId: providerMessageId || null, message: 'Mensagem já enviada com esta chave; nada reenviado.' } };
        case DeliveryOutcome.IN_PROGRESS:
            return { status: 409, body: { success: false, code: 'DELIVERY_IN_PROGRESS', retryable: true, message: 'Este envio ainda está em andamento.' } };
        case DeliveryOutcome.UNCERTAIN:
        default:
            return { status: 409, body: { success: false, code: 'DELIVERY_UNCERTAIN', retryable: false, message: 'Não sabemos se o envio anterior saiu. Confira a conversa no WhatsApp antes de mandar de novo.' } };
    }
}
