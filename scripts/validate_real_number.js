
import 'dotenv/config';
import mongoose from 'mongoose';
import { getOptimizedAmandaResponse } from '../orchestrators/AmandaOrchestrator.js';
import Leads from '../models/Leads.js';
import Contacts from '../models/Contacts.js';
import Messages from '../models/Message.js';

const PHONE = '556293377726';

const c = {
    reset: '\x1b[0m', green: '\x1b[32m', blue: '\x1b[34m', dim: '\x1b[2m', bold: '\x1b[1m'
};

async function getOrCreateLead(phone) {
    let contact = await Contacts.findOne({ phone });
    if (!contact) {
        console.log(`[INFO] Contato ${phone} não encontrado. Criando...`);
        contact = await Contacts.create({
            phone,
            name: 'Validação Real',
            source: 'validation_script'
        });
    }

    let lead = await Leads.findOne({ 'contact.phone': phone }).populate('contact');
    if (!lead) {
        // Tenta buscar por ID do contato se não achou por phone direto (depende do schema)
        lead = await Leads.findOne({ contact: contact._id }).populate('contact');
    }

    if (!lead) {
        console.log(`[INFO] Lead para ${phone} não encontrado. Criando...`);
        lead = await Leads.create({
            name: contact.name,
            phone: phone,
            contact: contact._id,
            status: 'novo',
            source: 'validation_script',
            qualificationData: { extractedInfo: {} }
        });
        lead = await Leads.findById(lead._id).populate('contact');
    }

    return lead;
}

async function simulateMessage(lead, text) {
    console.log(c.blue, `\n👤 User (${PHONE}): "${text}"`, c.reset);

    // Salva mensagem inbound (importante para o contexto)
    await Messages.create({
        lead: lead._id,
        contact: lead.contact._id,
        content: text,
        from: PHONE,
        to: process.env.CLINIC_PHONE_E164 || '5562999999999',
        direction: 'inbound',
        type: 'text',
        timestamp: new Date()
    });

    const start = Date.now();
    const response = await getOptimizedAmandaResponse({
        content: text,
        userText: text,
        lead,
        context: { source: 'validation_script' },
        messageId: `val_${Date.now()}`
    });
    const duration = Date.now() - start;

    console.log(c.green, `🤖 Amanda (${duration}ms): "${response}"`, c.reset);

    // Salva mensagem outbound (para manter coerência no próximo turno)
    if (response) {
        await Messages.create({
            lead: lead._id,
            contact: lead.contact._id,
            content: response,
            from: process.env.CLINIC_PHONE_E164 || '5562999999999',
            to: PHONE,
            direction: 'outbound',
            type: 'text',
            timestamp: new Date()
        });
    }

    return response;
}

async function main() {
    try {
        await mongoose.connect(process.env.MONGO_URI || process.env.MONGODB_URI);
        console.log('✅ MongoDB Conectado');

        const lead = await getOrCreateLead(PHONE);
        console.log(`📋 Lead ID: ${lead._id} | Nome: ${lead.name}`);

        // Sequência de validação
        await simulateMessage(lead, "Oi, boa tarde");

        // Aguarda um pouco para simular tempo de digitação/leitura
        await new Promise(r => setTimeout(r, 1000));

        await simulateMessage(lead, "Quanto custa a consulta para fonoaudiólogo?");

        // Aguarda um pouco
        await new Promise(r => setTimeout(r, 1000));

        await simulateMessage(lead, "Vocês aceitam Unimed?");

    } catch (err) {
        console.error('❌ Erro:', err);
    } finally {
        await mongoose.disconnect();
    }
}

main();
