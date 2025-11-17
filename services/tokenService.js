import NodeCache from 'node-cache';
import fetch from 'node-fetch';

const cache = new NodeCache({ stdTTL: 3300 }); // 55 minutos

export async function getAccessToken() {
    const cached = cache.get('wa_token');
    if (cached) return cached;

    const url = `https://graph.facebook.com/oauth/access_token` +
        `?grant_type=fb_exchange_token` +
        `&client_id=${process.env.APP_ID}` +
        `&client_secret=${process.env.APP_SECRET}` +
        `&fb_exchange_token=${process.env.META_WABA_TOKEN}`;

    const res = await fetch(url);
    const data = await res.json();
    if (!res.ok) throw new Error(data.error?.message || 'Erro ao gerar token WhatsApp');

    cache.set('wa_token', data.access_token);
    return data.access_token;
}
