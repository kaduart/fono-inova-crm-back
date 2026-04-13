/**
 * utils/trackingExtractor.js
 *
 * Extração de dados de tracking de campanhas (Google Ads / Meta Ads)
 * a partir do texto de mensagens do WhatsApp.
 *
 * Extraído de whatsappController.js (inline) → util reutilizável.
 *
 * Formato esperado no texto:
 *   ---ref:source|campaign|clickId|utm_key1=value1|utm_key2=value2
 */

/**
 * Extrai dados de tracking da mensagem do WhatsApp.
 * Retorna null se não houver tracking na mensagem.
 *
 * @param {string} message
 * @returns {{ source, campaign, clickId, ...utmParams } | null}
 */
export function extractTrackingFromMessage(message) {
    if (!message || typeof message !== 'string') return null;

    const match = message.match(/---ref:([^|]+)\|([^|]+)\|([^|]+)\|(.+)$/);
    if (!match) return null;

    const [, source, campaign, clickId, utmPart] = match;

    const utmParams = {};
    utmPart.split('|').forEach(param => {
        const [key, value] = param.split('=');
        if (key && value && value !== 'none') {
            utmParams[key] = value;
        }
    });

    return {
        source:   source   !== 'none' ? source   : null,
        campaign: campaign !== 'none' ? campaign : null,
        clickId:  clickId  !== 'none' ? clickId  : null,
        ...utmParams,
    };
}
