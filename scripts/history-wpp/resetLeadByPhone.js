// scripts/history-wpp/resetLeadByPhone.js
import dotenv from 'dotenv';
import mongoose from 'mongoose';
dotenv.config();

import ChatContext from '../../models/ChatContext.js';
import Contact from '../../models/Contacts.js';
import Followup from '../../models/Followup.js';
import Lead from '../../models/Leads.js';
import Message from '../../models/Message.js';
import { normalizeE164BR, tailPattern } from '../../utils/phone.js';

const RAW_PHONE = '61981694922'; // 👈 telefone que você quer resetar

async function main() {
    const uri = process.env.MONGO_URI || process.env.MONGODB_URI;

    if (!uri) {
        console.error('❌ MONGO_URI ou MONGODB_URI não encontrada no .env');
        process.exit(1);
    }

    console.log('🔌 Conectando ao MongoDB...');
    await mongoose.connect(uri);
    console.log('✅ Conectado.');

    // Normaliza igual no resto do sistema
    const normalized = normalizeE164BR(RAW_PHONE);        // ex: +5561981694922
    const numeric = normalized.replace(/\D/g, '');        // ex: 5561981694922
    const tail = tailPattern(numeric, 8, 11);             // ex: regex de final de número

    console.log('📞 Telefones considerados:', { normalized, numeric, tail });

    // 1) Contacts
    const contacts = await Contact.find({
        $or: [
            { phone: normalized },
            { phone: numeric },
            { phone: { $regex: tail } },
        ],
    });

    const contactIds = contacts.map(c => c._id);
    console.log(`👤 Contacts encontrados: ${contacts.length}`);

    // 2) Leads
    const leads = await Lead.find({
        $or: [
            { 'contact.phone': normalized },
            { 'contact.phone': numeric },
        ],
    });

    const leadIds = leads.map(l => l._id);
    console.log(`🧲 Leads encontrados: ${leads.length}`);

    if (leadIds.length === 0 && contactIds.length === 0) {
        console.log('ℹ️ Nenhum lead/contato encontrado para esse telefone. Nada a fazer.');
        await mongoose.disconnect();
        process.exit(0);
    }

    // 3) Messages
    const msgResult = await Message.deleteMany({
        $or: [
            { from: { $in: [normalized, numeric] } },
            { to: { $in: [normalized, numeric] } },
            { lead: { $in: leadIds } },
            { contact: { $in: contactIds } },
        ],
    });
    console.log(`💬 Messages deletadas: ${msgResult.deletedCount}`);

    // 4) Followups
    const followupResult = await Followup.deleteMany({
        lead: { $in: leadIds },
    });
    console.log(`📆 Followups deletados: ${followupResult.deletedCount}`);

    // 5) ChatContext
    const chatCtxResult = await ChatContext.deleteMany({
        lead: { $in: leadIds },
    });
    console.log(`🧠 ChatContexts deletados: ${chatCtxResult.deletedCount}`);

    // 6) Leads
    const leadResult = await Lead.deleteMany({
        _id: { $in: leadIds },
    });
    console.log(`🧲 Leads deletados: ${leadResult.deletedCount}`);

    // 7) Contacts
    const contactResult = await Contact.deleteMany({
        _id: { $in: contactIds },
    });
    console.log(`👤 Contacts deletados: ${contactResult.deletedCount}`);

    console.log('✅ Reset desse telefone concluído com sucesso!');
    await mongoose.disconnect();
    console.log('🔌 Desconectado do MongoDB.');
    process.exit(0);
}

main().catch(err => {
    console.error('❌ Erro ao resetar lead por telefone:', err);
    process.exit(1);
});
