// utils/metaToken.js
import NodeCache from 'node-cache';
import fetch from 'node-fetch';

const cache = new NodeCache({ stdTTL: 3300 }); // 55 minutos

export async function getMetaToken(forceRefresh = false) {
    // 1️⃣ Verifica cache (se não for forçado refresh)
    if (!forceRefresh) {
        const cached = cache.get('wa_token');
        if (cached) {
            console.log('✅ Token do cache');
            return cached;
        }
    }

    // 2️⃣ Tenta gerar LONG-LIVED token primeiro (se tiver credenciais)
    const shortToken = process.env.META_WABA_TOKEN;
    const appId = process.env.META_APP_ID || process.env.APP_ID;
    const appSecret = process.env.META_APP_SECRET || process.env.APP_SECRET;

    if (appId && appSecret && shortToken) {
        try {
            console.log('🔄 Tentando gerar token long-lived...');
            const url =
                `https://graph.facebook.com/oauth/access_token` +
                `?grant_type=fb_exchange_token` +
                `&client_id=${appId}` +
                `&client_secret=${appSecret}` +
                `&fb_exchange_token=${shortToken}`;

            const res = await fetch(url);
            const data = await res.json();

            if (res.ok && data.access_token) {
                console.log('✅ Token long-lived gerado (60 dias)');
                cache.set('wa_token', data.access_token);
                return data.access_token;
            }
            console.log('⚠️ Não foi possível gerar long-lived, usando token curto');
        } catch (err) {
            console.error('❌ Erro ao gerar long-lived:', err.message);
        }
    }

    // 3️⃣ Fallback para token curto direto
    if (shortToken) {
        console.log('✅ Usando token direto do .env');
        cache.set('wa_token', shortToken);
        return shortToken;
    }

    // 3️⃣ Tenta gerar long-lived token
    if (process.env.APP_ID && process.env.APP_SECRET && shortToken) {
        try {
            const url =
                `https://graph.facebook.com/oauth/access_token` +
                `?grant_type=fb_exchange_token` +
                `&client_id=${process.env.APP_ID}` +
                `&client_secret=${process.env.APP_SECRET}` +
                `&fb_exchange_token=${shortToken}`;

            const res = await fetch(url);
            const data = await res.json();

            if (!res.ok) {
                throw new Error(data.error?.message || 'Erro ao gerar token');
            }

            console.log('✅ Token long-lived gerado');
            cache.set('wa_token', data.access_token);
            return data.access_token;
        } catch (err) {
            console.error('❌ Erro ao gerar token:', err.message);
        }
    }

    // 4️⃣ Fallback para variáveis antigas
    const fallback = process.env.WHATSAPP_ACCESS_TOKEN;

    if (fallback) {
        console.log('✅ Usando token fallback');
        cache.set('wa_token', fallback);
        return fallback;
    }

    throw new Error('❌ Nenhum token WhatsApp configurado');
}

// 🆕 Limpa o cache do token (usar quando der erro 401)
export function clearMetaTokenCache() {
    cache.del('wa_token');
    console.log('🗑️ Cache do token limpo');
}