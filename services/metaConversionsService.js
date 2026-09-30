// services/metaConversionsService.js - MELHORADO

import axios from "axios";
import crypto from "crypto";
import { normalizeE164BR } from "../utils/phone.js";

function normalizeAndHash(value) {
    if (!value) return null;
    const normalized = String(value).trim().toLowerCase();
    return crypto.createHash("sha256").update(normalized).digest("hex");
}

/**
 * Função genérica para enviar qualquer evento
 */
export async function sendEventToMeta({
    eventName,      // 'Lead', 'Purchase', 'Schedule', 'Contact'
    email,
    phone,
    fbc,             // identificador de clique da Meta (fb.1.<ms>.<fbclid>)
    leadId,
    value,          // Valor monetário
    currency = 'BRL',
    customData = {}, // Dados extras
    eventId,         // Deduplicação no Meta (ex: id do agendamento)
    eventTime,       // Date do evento real (default: agora)
    actionSource = 'website'
}) {
    try {
        const pixelId = process.env.META_PIXEL_ID;
        const accessToken = process.env.META_CONVERSIONS_TOKEN;

        if (!pixelId || !accessToken) {
            console.warn("⚠️ Meta CAPI não configurado");
            return;
        }

        const url = `https://graph.facebook.com/v20.0/${pixelId}/events?access_token=${accessToken}`;

        // User data com hashes
        const user_data = {};

        if (email) user_data.em = [normalizeAndHash(email)];
        if (phone) {
            // Meta exige DDI no hash (ex.: 5562999999999). Telefone salvo sem 55 nunca casa com usuário.
            const digitsPhone = normalizeE164BR(phone) || phone.replace(/\D/g, "");
            user_data.ph = [normalizeAndHash(digitsPhone)];
        }
        if (fbc) user_data.fbc = fbc;
        if (leadId) user_data.lead_id = [String(leadId)];

        // Custom data (valor, moeda, etc)
        const event_custom_data = { ...customData };
        if (value) event_custom_data.value = value;
        if (currency) event_custom_data.currency = currency;

        const payload = {
            data: [{
                event_name: eventName,
                event_time: Math.floor((eventTime ? new Date(eventTime).getTime() : Date.now()) / 1000),
                ...(eventId && { event_id: String(eventId) }),
                action_source: actionSource,
                event_source_url: "https://clinicafonoinova.com.br",
                user_data,
                custom_data: event_custom_data
            }]
        };

        const response = await axios.post(url, payload);
        console.log(`✅ Meta CAPI: ${eventName} enviado`, response.data);

        return response.data;

    } catch (err) {
        console.error(`❌ Meta CAPI ${eventName}:`, err.response?.data || err.message);
        throw err;
    }
}

// Atalhos para eventos comuns
export async function sendLeadToMeta(data) {
    return sendEventToMeta({ ...data, eventName: 'Lead' });
}

export async function sendScheduleToMeta(data) {
    return sendEventToMeta({ ...data, eventName: 'Schedule' });
}

export async function sendPurchaseToMeta(data) {
    return sendEventToMeta({ ...data, eventName: 'Purchase' });
}
