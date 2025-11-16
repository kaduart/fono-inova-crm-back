// utils/metaToken.js
import NodeCache from 'node-cache';
import fetch from 'node-fetch';

const cache = new NodeCache({ stdTTL: 3300 }); // 55 minutos

export async function getMetaToken() {
    // 1️⃣ Verifica cache
    const cached = cache.get('wa_token');
    if (cached) {
        console.log('✅ Token do cache');
        return cached;
    }

    // 2️⃣ Tenta SHORT_TOKEN direto (mais comum)
    if (process.env.SHORT_TOKEN) {
        console.log('✅ Usando SHORT_TOKEN');
        cache.set('wa_token', process.env.SHORT_TOKEN);
        return process.env.SHORT_TOKEN;
    }

    // 3️⃣ Tenta gerar long-lived token
    if (process.env.APP_ID && process.env.APP_SECRET && process.env.SHORT_TOKEN) {
        try {
            const url =
                `https://graph.facebook.com/oauth/access_token` +
                `?grant_type=fb_exchange_token` +
                `&client_id=${process.env.APP_ID}` +
                `&client_secret=${process.env.APP_SECRET}` +
                `&fb_exchange_token=${process.env.SHORT_TOKEN}`;

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
    const fallback =
        process.env.WHATSAPP_ACCESS_TOKEN ||
        process.env.META_WABA_TOKEN;

    if (fallback) {
        console.log('✅ Usando token fallback');
        cache.set('wa_token', fallback);
        return fallback;
    }

    throw new Error('❌ Nenhum token WhatsApp configurado');
}
