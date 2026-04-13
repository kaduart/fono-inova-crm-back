/**
 * utils/whatsappMediaExtractor.js
 *
 * Extração e normalização de conteúdo de mensagens do WhatsApp por tipo de mídia.
 * Encapsula toda a lógica de: text / audio / image / video / document / sticker / location.
 *
 * Extraído de whatsappController.js (inline) → util reutilizável e testável.
 *
 * @returns {{ content: string, mediaUrl: string|null, mediaId: string|null, caption: string|null }}
 */

import { describeWaImage, transcribeWaAudio } from '../services/aiAmandaService.js';
import { resolveMediaUrl } from '../services/whatsappService.js';

/**
 * @param {object} msg   — mensagem bruta do WhatsApp (Meta API format)
 * @param {string} type  — msg.type: 'text' | 'audio' | 'image' | 'video' | 'document' | 'sticker' | 'location'
 * @returns {Promise<{ content: string, mediaUrl: string|null, mediaId: string|null, caption: string|null }>}
 */
export async function extractMessageContent(msg, type) {
    let content  = '';
    let mediaUrl = null;
    let mediaId  = null;
    let caption  = null;

    if (type === 'text') {
        content = msg.text?.body || '';

    } else if (type === 'audio' && msg.audio?.id) {
        mediaId = msg.audio.id;
        caption = '[AUDIO]';

        try {
            const resolved = await resolveMediaUrl(mediaId);
            mediaUrl = resolved.url;
        } catch (e) {
            console.warn('[whatsappMediaExtractor] Falha ao resolver URL do áudio:', e.message);
        }

        content = await transcribeWaAudio({ mediaId });
        if (!content || content.length < 3) {
            content = '[Áudio não pôde ser transcrito]';
        }

    } else if (type === 'image' && msg.image?.id) {
        mediaId = msg.image.id;
        caption = (msg.image.caption || '').trim();

        try {
            const resolved = await resolveMediaUrl(mediaId);
            mediaUrl = resolved.url;
        } catch (e) {
            console.warn('[whatsappMediaExtractor] Falha ao resolver URL da imagem:', e.message);
        }

        try {
            const description = await describeWaImage({
                mediaId,
                mediaUrl,
                mimeType: msg.image?.mime_type,
            });
            content = caption
                ? `${caption}\n[Detalhe da imagem: ${description}]`
                : `Imagem enviada: ${description}`;
        } catch (e) {
            console.warn('[whatsappMediaExtractor] Falha ao descrever imagem:', e.message);
            content = caption || 'Imagem recebida.';
        }

    } else if (type === 'location' && msg.location) {
        content = msg.location.name || msg.location.address || 'Localização enviada';

    } else {
        // video / document / sticker — só resolve URL, não transcreve
        try {
            if (type === 'video' && msg.video?.id) {
                mediaId = msg.video.id;
                caption = msg.video.caption || '[VIDEO]';
                const resolved = await resolveMediaUrl(mediaId);
                mediaUrl = resolved.url;

            } else if (type === 'document' && msg.document?.id) {
                mediaId = msg.document.id;
                caption = msg.document.filename || '[DOCUMENT]';
                const resolved = await resolveMediaUrl(mediaId);
                mediaUrl = resolved.url;

            } else if (type === 'sticker' && msg.sticker?.id) {
                mediaId = msg.sticker.id;
                caption = '[STICKER]';
                const resolved = await resolveMediaUrl(mediaId);
                mediaUrl = resolved.url;
            }
        } catch (e) {
            console.warn('[whatsappMediaExtractor] Falha ao resolver mídia:', e.message);
        }
    }

    return { content, mediaUrl, mediaId, caption };
}
