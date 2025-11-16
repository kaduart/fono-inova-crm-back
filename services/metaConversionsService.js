// services/metaConversionsService.js - MELHORADO

import axios from "axios";
import crypto from "crypto";

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
    leadId,
    value,          // Valor monetário
    currency = 'BRL',
    customData = {} // Dados extras
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
            const digitsPhone = phone.replace(/\D/g, "");
            user_data.ph = [normalizeAndHash(digitsPhone)];
        }
        if (leadId) user_data.lead_id = [String(leadId)];

        // Custom data (valor, moeda, etc)
        const event_custom_data = { ...customData };
        if (value) event_custom_data.value = value;
        if (currency) event_custom_data.currency = currency;

        const payload = {
            data: [{
                event_name: eventName,
                event_time: Math.floor(Date.now() / 1000),
                action_source: "website",
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
