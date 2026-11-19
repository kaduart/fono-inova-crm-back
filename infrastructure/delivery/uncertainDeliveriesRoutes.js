// infrastructure/delivery/uncertainDeliveriesRoutes.js
// Envios com resultado incerto (status `unknown` em outbound_deliveries) para
// decisão humana. Só admin. Ver docs/ENVIOS_ANTI_REENVIO.md §4.
//
//   GET  /api/observability/deliveries/uncertain?limit=100
//   POST /api/observability/deliveries/resolve  { key, as: 'sent'|'failed', note? }
//
// `sent`  = a pessoa conferiu no WhatsApp que a mensagem chegou; a chave fecha.
// `failed`= conferiu que NÃO chegou; a chave aceita nova tentativa.
// Nenhuma das duas reenvia nada: só registra a decisão (com autor) na trilha.

import {
    listUncertainDeliveries,
    resolveUncertainDelivery,
    markAbandonedAsUnknown
} from './deliveryGuard.js';
import { sendApiError } from '../../errors/buildErrorResponse.js';
import { AppError } from '../../errors/AppError.js';
import { adminOnly } from '../../middleware/observabilityAccess.js';

const KEY_RE = /^[A-Za-z0-9._:@-]{3,300}$/;

export async function listUncertainHandler(req, res) {
    try {
        const out = await listUncertainDeliveries({ limit: req.query?.limit });
        return res.json({ success: true, ...out });
    } catch (err) {
        console.error('[deliveries] erro ao listar incertos:', err?.message);
        return sendApiError(res, new AppError('DELIVERIES_LIST_FAILED', 'Falha ao listar envios incertos', { status: 500 }), req);
    }
}

export async function resolveUncertainHandler(req, res) {
    const { key, as, note } = req.body || {};
    if (typeof key !== 'string' || !KEY_RE.test(key)) {
        return sendApiError(res, new AppError('BAD_REQUEST', 'Chave de envio inválida', { status: 400 }), req);
    }
    if (!['sent', 'failed'].includes(as)) {
        return sendApiError(res, new AppError('BAD_REQUEST', "Campo 'as' deve ser 'sent' ou 'failed'", { status: 400 }), req);
    }
    const by = req.user?._id || req.user?.id;
    try {
        await markAbandonedAsUnknown(key);
        const ok = await resolveUncertainDelivery(key, { as, by, note: typeof note === 'string' ? note : undefined });
        if (!ok) {
            return sendApiError(res, new AppError('DELIVERY_NOT_UNCERTAIN', 'Este envio não está mais incerto (já resolvido, em andamento ou inexistente)', { status: 409 }), req);
        }
        console.log(JSON.stringify({ msg: 'delivery_resolved_manually', key, as, by: String(by) }));
        return res.json({ success: true, key, status: as });
    } catch (err) {
        console.error('[deliveries] erro ao resolver:', err?.message);
        return sendApiError(res, new AppError('DELIVERY_RESOLVE_FAILED', 'Falha ao registrar a decisão', { status: 500 }), req);
    }
}

export function mountUncertainDeliveries(router) {
    router.get('/deliveries/uncertain', ...adminOnly, listUncertainHandler);
    router.post('/deliveries/resolve', ...adminOnly, resolveUncertainHandler);
    return router;
}

