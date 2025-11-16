import axios from "axios";
import { getMetaToken } from "../utils/metaToken.js";

const META_URL = "https://graph.facebook.com/v21.0";

/**
 * 🔎 Resolve URL de mídia a partir do mediaId
 * Retorna: { url, mimeType, fileSize }
 */
export async function resolveMediaUrl(mediaId) {
    if (!mediaId) {
        throw new Error('mediaId é obrigatório');
    }

    const token = await getMetaToken();
    const url = `${META_URL}/${mediaId}?fields=id,mime_type,sha256,file_size,url`;

    console.log(`🔍 Resolvendo mídia: ${mediaId}`);

    try {
        const res = await axios.get(url, {
            headers: { Authorization: `Bearer ${token}` },
            timeout: 15000
        });

        if (!res.data?.url) {
            throw new Error(`Graph não retornou URL (mediaId=${mediaId})`);
        }

        console.log(`✅ URL resolvida: ${res.data.url.substring(0, 50)}...`);

        return {
            url: res.data.url,
            mimeType: res.data.mime_type || "application/octet-stream",
            fileSize: res.data.file_size || null,
        };
    } catch (err) {
        console.error(`❌ Erro ao resolver mídia ${mediaId}:`, err.message);
        throw err;
    }
}

/**
 * 📥 Baixa o binário da mídia
 * Retorna: Buffer
 */
export async function downloadMedia(mediaUrl) {
    if (!mediaUrl) {
        throw new Error('mediaUrl é obrigatória');
    }

    const token = await getMetaToken();

    console.log(`📥 Baixando mídia...`);

    try {
        const res = await axios.get(mediaUrl, {
            responseType: 'arraybuffer',
            headers: {
                Authorization: `Bearer ${token}`,
                'User-Agent': 'FonoInovaProxy/1.0',
                'Accept': '*/*'
            },
            timeout: 20000
        });

        const buffer = Buffer.from(res.data);
        console.log(`✅ Mídia baixada: ${buffer.length} bytes`);

        return buffer;
    } catch (err) {
        console.error('❌ Erro ao baixar mídia:', err.message);
        throw err;
    }
}

/**
 * 🎯 FUNÇÃO COMPLETA: Resolve + Baixa
 */
export async function getMediaBuffer(mediaId) {
    const { url, mimeType } = await resolveMediaUrl(mediaId);
    const buffer = await downloadMedia(url);
    return { buffer, mimeType, url };
}