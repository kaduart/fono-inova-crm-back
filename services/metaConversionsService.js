// services/metaConversionsService.js
import axios from "axios";
import crypto from "crypto";

/**
 * Normaliza e faz hash SHA256 (padrão da Meta)
 */
function normalizeAndHash(value) {
    if (!value) return null;
    const normalized = String(value).trim().toLowerCase();
    return crypto.createHash("sha256").update(normalized).digest("hex");
}

export async function sendLeadToMeta({ email, phone, leadId }) {
    try {
        const pixelId = process.env.META_PIXEL_ID;
        const accessToken = process.env.META_CONVERSIONS_TOKEN;

        if (!pixelId || !accessToken) {
            console.warn("⚠️ Meta CAPI: META_PIXEL_ID ou META_CONVERSIONS_TOKEN não configurados");
            return;
        }

        const url = `https://graph.facebook.com/v20.0/${pixelId}/events?access_token=${accessToken}`;

        // Monta user_data com hashes
        const user_data = {};

        const emailHash = normalizeAndHash(email);
        if (emailHash) user_data.em = [emailHash];

        // remove tudo que não é número, como +55, espaço, parênteses, etc.
        const digitsPhone = phone ? phone.replace(/\D/g, "") : null;
        const phoneHash = digitsPhone ? normalizeAndHash(digitsPhone) : null;
        if (phoneHash) user_data.ph = [phoneHash];

        if (leadId) {
            user_data.lead_id = [String(leadId)];
        }

        const payload = {
            data: [
                {
                    event_name: "Lead",
                    event_time: Math.floor(Date.now() / 1000),
                    action_source: "website", // origem do lead
                    event_source_url: "https://clinicafonoinova.com.br", // opcional
                    user_data,
                },
            ],
        };

        const response = await axios.post(url, payload);
        console.log("✅ Meta CAPI: Lead enviado com sucesso", response.data);
    } catch (err) {
        console.error(
            "💥 Erro ao enviar Lead para Meta CAPI:",
            err.response?.data || err.message
        );
    }
}
