import fetch from 'node-fetch';
import Message from '../models/Message.js';
import { getAccessToken } from './tokenService.js';

function normalizePhone(phone) {
    return phone.replace(/\D/g, '').replace(/^55?/, '55');
}

export async function sendTemplateMessage({ to, template, params, lead }) {
    const phone = normalizePhone(to);
    const accessToken = await getAccessToken();

    const body = {
        messaging_product: 'whatsapp',
        to: phone,
        type: 'template',
        template: {
            name: template,
            language: { code: 'pt_BR' },
            components: [{ type: 'body', parameters: params }]
        }
    };

    const res = await fetch(`https://graph.facebook.com/v18.0/${process.env.PHONE_NUMBER_ID}/messages`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
    });

    const data = await res.json();
    await Message.create({
        to: phone,
        from: process.env.PHONE_NUMBER_ID,
        direction: 'outbound',
        type: 'template',
        content: JSON.stringify(params),
        templateName: template,
        status: res.ok ? 'sent' : 'failed',
        lead
    });

    if (!res.ok) throw new Error(data.error?.message || 'Erro ao enviar mensagem WhatsApp');
    return data;
}

export async function sendTextMessage({ to, text, lead }) {
    const phone = normalizePhone(to);
    const accessToken = await getAccessToken();

    const res = await fetch(`https://graph.facebook.com/v18.0/${process.env.PHONE_NUMBER_ID}/messages`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
            messaging_product: 'whatsapp',
            to: phone,
            text: { body: text }
        })
    });

    const data = await res.json();
    await Message.create({
        to: phone,
        from: process.env.PHONE_NUMBER_ID,
        direction: 'outbound',
        type: 'text',
        content: text,
        status: res.ok ? 'sent' : 'failed',
        lead
    });

    if (!res.ok) throw new Error(data.error?.message || 'Erro ao enviar texto WhatsApp');
    return data;
}

export async function handleWebhookEvent(payload) {
    const entry = payload.entry?.[0]?.changes?.[0]?.value;
    const msg = entry?.messages?.[0];
    const status = entry?.statuses?.[0];

    if (msg) {
        await Message.create({
            from: msg.from,
            to: process.env.PHONE_NUMBER_ID,
            direction: 'inbound',
            type: msg.type,
            content: msg.text?.body,
            status: 'received',
            timestamp: new Date(parseInt(msg.timestamp) * 1000)
        });
    }

    if (status) {
        await Message.updateOne(
            { 'waMessageId': status.id },
            { $set: { status: status.status } }
        );
    }
}
