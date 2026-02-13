
import 'dotenv/config';
import mongoose from 'mongoose';
import { getOptimizedAmandaResponse } from '../../orchestrators/AmandaOrchestrator.js';
import Leads from '../../models/Leads.js';
import Contacts from '../../models/Contacts.js';

const PHONE = '556299997778';

async function run() {
    await mongoose.connect(process.env.MONGO_URI);
    await Leads.deleteMany({ phone: PHONE });
    await Contacts.deleteMany({ phone: PHONE });

    const contact = await Contacts.create({ name: 'Teste Contexto', phone: PHONE });
    const lead = await Leads.create({
        name: 'Teste Contexto',
        phone: PHONE,
        contact: contact._id,
        stage: 'novo',
        therapyArea: 'fonoaudiologia', // Já sabe que é fono/testinha
        topic: 'teste_linguinha'      // Contexto já estabelecido
    });

    console.log("--- CENÁRIO: Contexto já é 'teste_linguinha' ---");

    // Mensagem problemática
    const userMsg = "E se for preciso fazer o procedimento vcs fazem aí mesmo?";
    console.log(`👤 User: "${userMsg}"`);

    const response = await getOptimizedAmandaResponse({
        content: userMsg,
        userText: userMsg,
        lead: await Leads.findById(lead._id).lean(),
        context: { source: 'whatsapp-inbound' },
        messageId: `test-context-${Date.now()}`
    });

    const text = response?.payload?.text || response?.text || '';
    console.log(`🤖 AI: "${text}"`);

    if (text.toLowerCase().includes("não realizamos") || text.toLowerCase().includes("não fazemos")) {
        console.log("✅ PASSOU: Negou a cirurgia");
    } else {
        console.log("❌ FALHOU: Não negou ou confirmou incorretamente");
    }

    await mongoose.disconnect();
}

run();
