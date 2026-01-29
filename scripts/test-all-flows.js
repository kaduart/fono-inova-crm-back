console.log('🚀 TESTE E2E - FLUXOS DE AGENDAMENTO\n');

try {
    await import('dotenv/config');
    console.log('✅ .env carregado');
} catch (e) {
    console.error('❌ Erro dotenv:', e.message);
    process.exit(1);
}

const mongoose = (await import('mongoose')).default;
const Leads = (await import('../models/Leads.js')).default;
const { WhatsAppOrchestrator } = await import('../orchestrators/WhatsAppOrchestrator.js');

const TEST_PHONE = '5561999999999';

const SCENARIOS = [
    { name: 'FONO - Atraso Fala', msgs: ['Oi quero fono pro meu filho', 'Ele tem 3 anos e não fala quase nada', 'Manhã'] },
    { name: 'FONO - Linguinha', msgs: ['Preciso fazer teste da linguinha no meu bebê de 2 meses', 'Tarde'] },
    { name: 'PSICO - Ansiedade', msgs: ['Quero psicólogo pro meu filho', 'Não presta atenção e tem ansiedade, 9 anos', 'Tarde'] },
    { name: 'FISIO', msgs: ['Preciso de fisio infantil', 'Minha filha tem 1 ano e não anda', 'Manhã'] },
    { name: 'TO', msgs: ['Quero terapia ocupacional', 'Dificuldade pra segurar lápis, 6 anos', 'Tarde'] },
    { name: 'NEUROPSICO', msgs: ['Avaliação neuropsicológica', 'Escola pediu investigar TDAH, 8 anos', 'Manhã'] }
];

async function runAll() {
    console.log('📡 Conectando MongoDB...');
    await mongoose.connect(process.env.MONGO_URI);
    console.log('✅ MongoDB conectado\n');
    
    const orch = new WhatsAppOrchestrator();
    
    for (const sc of SCENARIOS) {
        console.log(
