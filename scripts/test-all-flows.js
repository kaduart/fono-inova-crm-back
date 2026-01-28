// scripts/test-all-flows.js
import dotenv from "dotenv";
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
dotenv.config({ path: join(__dirname, '../.env') });

const mongoose = (await import('mongoose')).default;
const Leads = (await import('../models/Leads.js')).default;
const { WhatsAppOrchestrator } = await import('../orchestrators/WhatsAppOrchestrator.js');

const TEST_PHONE = '5561999999999';

const mockServices = {
    whatsapp: {
        sendMessage: async () => ({ ok: true })
    },
    llm: {
        generate: async ({ prompt }) => ({
            text: `[MOCK LLM] ${prompt.slice(0, 50)}`
        })
    },
    slots: {
        findAvailableSlots: async () => ([
            { label: 'A', date: '2026-02-10', time: '09:00' },
            { label: 'B', date: '2026-02-10', time: '15:00' },
        ])
    }
};

const SCENARIOS = [
    { name: 'FONO - Atraso Fala', msgs: ['Oi quero fono pro meu filho', 'Ele tem 3 anos e não fala quase nada', 'Manhã'], expected: 'fonoaudiologia' },
    { name: 'FONO - Linguinha', msgs: ['Preciso fazer teste da linguinha no meu bebê de 2 meses', 'Tarde'], expected: 'fonoaudiologia' },
    { name: 'PSICO - Ansiedade', msgs: ['Quero psicólogo pro meu filho', 'Não presta atenção e tem ansiedade, 9 anos', 'Tarde'], expected: 'psicologia' },
    { name: 'FISIO', msgs: ['Preciso de fisio infantil', 'Minha filha tem 1 ano e não anda', 'Manhã'], expected: 'fisioterapia' },
    { name: 'TO', msgs: ['Quero terapia ocupacional', 'Dificuldade pra segurar lápis, 6 anos', 'Tarde'], expected: 'terapia_ocupacional' },
    { name: 'NEUROPSICO', msgs: ['Avaliação neuropsicológica', 'Escola pediu investigar TDAH, 8 anos', 'Manhã'], expected: 'neuropsicologia' },
];

async function createLead(name) {
    await Leads.deleteMany({ 'contact.phone': TEST_PHONE });
    return await Leads.create({
        name: `Teste - ${name}`,
        contact: { phone: TEST_PHONE },
        status: 'novo',
        qualificationData: { extractedInfo: {} }
    });
}

async function simulate(lead, text, orch) {
    const result = await orch.process({
        lead,
        message: { text, type: 'text' },
        services: mockServices
    });
    return {
        response: result?.payload?.text || '[sem resposta]',
        lead: await Leads.findById(lead._id).lean()
    };
}

console.log('🚀 TESTE E2E - FLUXOS DE AGENDAMENTO\n');
await mongoose.connect(process.env.MONGODB_URI || process.env.MONGO_URI);
console.log('✅ MongoDB conectado\n');

const orch = new WhatsAppOrchestrator();

for (const sc of SCENARIOS) {
    console.log(`${'='.repeat(60)}`);
    console.log(`🧪 CENÁRIO: ${sc.name}`);
    console.log(`${'='.repeat(60)}`);

    let lead = await createLead(sc.name);
    console.log(`📝 Lead criado: ${lead.name}`);

    for (let i = 0; i < sc.msgs.length; i++) {
        console.log(`\n📨 Usuário: "${sc.msgs[i]}"`);
        try {
            const r = await simulate(lead, sc.msgs[i], orch);
            lead = r.lead;
            console.log(`📤 Amanda: "${r.response.substring(0, 100)}${r.response.length > 100 ? '...' : ''}"`);
        } catch (e) {
            console.log(`❌ ERRO: ${e.message}`);
            break;
        }
    }

    const ext = lead.qualificationData?.extractedInfo || {};
    const detectedTherapy = (lead.therapyArea || ext.therapyArea || 'não detectada').toLowerCase();
    const expected = sc.expected.toLowerCase();
    const match = detectedTherapy.includes(expected) || expected.includes(detectedTherapy);

    console.log(`\n📋 RESULTADO:`);
    console.log(`   Terapia detectada: ${detectedTherapy}`);
    console.log(`   Esperado: ${expected}`);
    console.log(`   Status: ${match ? '✅ CORRETO' : '⚠️ DIFERENTE'}`);
    console.log(`   Queixa: ${ext.queixa || 'não extraída'}`);
    console.log(`   Idade: ${ext.idade || 'não extraída'}`);

    if (lead.pendingPreferredPeriod || ext.periodo_preferido) {
        console.log(`   Período: ${lead.pendingPreferredPeriod || ext.periodo_preferido}`);
    }

    await Leads.deleteMany({ 'contact.phone': TEST_PHONE });
    console.log('🗑️  Lead de teste removido\n');
}

await mongoose.disconnect();
console.log('✅ Testes finalizados!');
process.exit(0);