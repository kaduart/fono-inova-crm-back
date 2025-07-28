import dotenv from 'dotenv';
import express from 'express';
import fetch from 'node-fetch';
import Contact from '../models/Contacts.js';
dotenv.config();

const router = express.Router();

const APP_ID = process.env.APP_ID;
const APP_SECRET = process.env.APP_SECRET;
const SHORT_TOKEN = process.env.SHORT_TOKEN;
const PHONE_NUMBER_ID = process.env.PHONE_NUMBER_ID;

async function getAccessToken() {
    const url = 'https://graph.facebook.com/oauth/access_token'
        + `?grant_type=fb_exchange_token`
        + `&client_id=${APP_ID}`
        + `&client_secret=${APP_SECRET}`
        + `&fb_exchange_token=${SHORT_TOKEN}`;

    const res = await fetch(url, { method: 'GET' });
    const data = await res.json();
    if (!res.ok) {
        console.error('[Erro getAccessToken]', data);
        throw new Error(data.error?.message || 'Erro ao obter access_token');
    }
    return data.access_token;
}

router.post('/send-whatsapp', async (req, res) => {
    try {
        const { phone, template, params } = req.body;
        if (!phone || !template || !params) {
            return res.status(400).json({ error: 'Campos obrigatórios ausentes' });
        }

        const accessToken = await getAccessToken();

        const response = await fetch(`https://graph.facebook.com/v18.0/${PHONE_NUMBER_ID}/messages`, {
            method: 'POST',
            headers: {
                Authorization: `Bearer ${accessToken}`,
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({
                messaging_product: 'whatsapp',
                to: phone,
                type: 'template',
                template: {
                    name: template,
                    language: { code: 'pt_BR' },
                    components: [
                        { type: 'body', parameters: params },
                    ],
                },
            }),
        });

        const result = await response.json();
        if (!response.ok) {
            return res.status(response.status).json({ error: result.error || 'Erro ao enviar mensagem' });
        }
        return res.status(200).json(result);
    } catch (err) {
        console.error('[WhatsApp API ERROR]', err);
        return res.status(500).json({ error: err.message || 'Erro interno' });
    }
});

// 1. Verificação do webhook (GET)
router.get('/webhook', (req, res) => {
    const { 'hub.mode': mode, 'hub.verify_token': token, 'hub.challenge': challenge } = req.query;
    if (mode === 'subscribe' && token === process.env.WPP_VERIFY_TOKEN) {
        return res.status(200).send(challenge);
    }
    res.sendStatus(403);
});

// 2. Receber mensagens via webhook (POST)
router.post('/webhook', async (req, res) => {
    const entry = req.body.entry?.[0]?.changes?.[0]?.value;
    const msg = entry?.messages?.[0];
    if (msg) {
        await Message.create({
            from: msg.from,
            text: msg.text?.body,
            timestamp: new Date(parseInt(msg.timestamp) * 1000),
            type: msg.type
        });
    }
    res.sendStatus(200);
});

// 3. Listar histórico por telefone
router.get('/chat/:phone', async (req, res) => {
    const msgs = await Message.find({ from: req.params.phone }).sort('timestamp');
    res.json(msgs);
});

// 4. Enviar mensagem para o cliente
router.post('/chat/:phone/send', async (req, res) => {
    const { text } = req.body;
    try {
        await fetch(`${process.env.API_BASE_URL}/wpp/send-whatsapp`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                phone: req.params.phone,
                template: 'follow_up_ausente',
                params: [{ type: 'text', text }]
            })
        });
        // Salvar envio no histórico
        await Message.create({ from: process.env.PHONE_NUMBER_ID, text, timestamp: new Date(), type: 'text' });
        res.sendStatus(200);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

router.post('/contacts', async (req, res) => {
    try {
        const { name, phone } = req.body;

        if (!name || !phone) {
            return res.status(400).json({ error: 'Nome e telefone são obrigatórios' });
        }

        // Verifica se contato já existe
        const existing = await Contact.findOne({ phone });
        if (existing) {
            return res.status(409).json({ error: 'Contato já existe' });
        }

        const newContact = await Contact.create({ name, phone });
        return res.status(201).json(newContact);
    } catch (err) {
        console.error('[Add Contact ERROR]', err);
        return res.status(500).json({ error: 'Erro interno ao adicionar contato' });
    }
});

router.get('/contacts', async (req, res) => {
    try {
        const contacts = await Contact.find().sort({ name: 1 }); // ordena por nome
        return res.status(200).json(contacts);
    } catch (err) {
        console.error('[List Contacts ERROR]', err);
        return res.status(500).json({ error: 'Erro interno ao listar contatos' });
    }
});

router.put('/contacts/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const { name, phone, avatar } = req.body;

        if (!name && !phone && !avatar) {
            return res.status(400).json({ error: 'Pelo menos um campo deve ser informado para atualização' });
        }

        const updated = await Contact.findByIdAndUpdate(
            id,
            { name, phone, avatar },
            { new: true, runValidators: true }
        );

        if (!updated) {
            return res.status(404).json({ error: 'Contato não encontrado' });
        }

        return res.status(200).json(updated);
    } catch (err) {
        console.error('[Update Contact ERROR]', err);
        return res.status(500).json({ error: 'Erro interno ao atualizar contato' });
    }
});

router.delete('/contacts/:id', async (req, res) => {
    try {
        const { id } = req.params;

        const deleted = await Contact.findByIdAndDelete(id);
        if (!deleted) {
            return res.status(404).json({ error: 'Contato não encontrado' });
        }

        return res.status(200).json({ message: 'Contato deletado com sucesso' });
    } catch (err) {
        console.error('[Delete Contact ERROR]', err);
        return res.status(500).json({ error: 'Erro interno ao deletar contato' });
    }
});

export default router;
