// scripts/test-interrupcoes-e2e.js
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

// Teste 1: Interrupção por preço no meio do agendamento
const CENARIO_INTERRUPCAO_PRECO = [
    { msg: 'Oi quero fono para minha filha', espera: 'queixa' },
    { msg: 'Ela tem 4 anos e não fala direito', espera: 'idade_ok' },
    { msg: '4 anos', espera: 'periodo' },
    { msg: 'manha', espera: 'slots' }, // Aqui deve oferecer horários
    { msg: 'qual o valor?', espera: 'preco' }, // INTERRUÇÃO: pergunta preço
    { msg: 'A', espera: 'nome' }, // VOLTA: escolhe slot A
    { msg: 'Maria Silva', espera: 'confirmacao' } // Finaliza
];

// Teste 2: Interrupção por info terapia + retomada
const CENARIO_INTERRUPCAO_INFO = [
    { msg: 'Psicologo para ansiedade', espera: 'idade' },
    { msg: '12 anos', espera: 'periodo' },
    { msg: 'tarde', espera: 'slots' },
    { msg: 'o que é psicologia?', espera: 'explicacao' }, // INTERRUÇÃO
    { msg: 'B', espera: 'nome' }, // VOLTA: escolhe slot B
    { msg: 'Joao Pedro', espera: 'confirmacao' }
];

// Teste 3: Múltiplas interrupções
const CENARIO_MULTIPLAS_INTERRUPCOES = [
    { msg: 'To para autismo', espera: 'idade' },
    { msg: '7 anos', espera: 'periodo' },
    { msg: 'quanto custa?', espera: 'preco' }, // INTERRUÇÃO 1
    { msg: 'manha', espera: 'slots' }, // VOLTA
    { msg: 'qual a diferença de TO e psico?', espera: 'explicacao' }, // INTERRUÇÃO 2
    { msg: 'A', espera: 'nome' }, // VOLTA
    { msg: 'Lucas', espera: 'confirmacao' }
];

async function simularConversa(cenario, nomeCenario) {
    console.log(`\n\n${'='.repeat(60)}`);
    console.log(`🧪 TESTE: ${nomeCenario}`);
    console.log(`${'='.repeat(60)}`);

    // Limpa e cria lead
    await Leads.deleteMany({ 'contact.phone': TEST_PHONE });
    let lead = await Leads.create({
        name: `Teste - ${nomeCenario}`,
        contact: { phone: TEST_PHONE },
        status: 'novo',
        qualificationData: { extractedInfo: {} }
    });

    const orch = new WhatsAppOrchestrator();
    let passo = 1;

    for (const etapa of cenario) {
        console.log(`\n📨 Passo ${passo}: "${etapa.msg}"`);
        console.log(`   Esperado: ${etapa.espera}`);

        try {
            const result = await orch.process({
                lead,
                message: { text: etapa.msg, type: 'text' },
                services: {}
            });

            const resposta = result?.payload?.text || '[sem resposta]';
            console.log(`   📤 Resposta: "${resposta.substring(0, 80)}..."`);

            // Validações específicas
            if (etapa.espera === 'preco') {
                const temPreco = resposta.toLowerCase().includes('r$') ||
                    resposta.toLowerCase().includes('valor') ||
                    resposta.toLowerCase().includes('preço');
                console.log(`   ✅ Validação: ${temPreco ? 'Mencionou preço' : 'NÃO mencionou preço'}`);

                // Verifica se o contexto do agendamento foi preservado
                const leadAtual = await Leads.findById(lead._id);
                const temSlot = leadAtual.pendingSchedulingSlots || leadAtual.pendingChosenSlot;
                console.log(`   💾 Contexto preservado: ${temSlot ? 'SIM' : 'NÃO'}`);
            }

            if (etapa.espera === 'slots') {
                const temOpcoes = resposta.includes('A)') || resposta.includes('B)') || resposta.includes('C)');
                console.log(`   ✅ Ofereceu opções: ${temOpcoes ? 'SIM' : 'NÃO'}`);
            }

            if (etapa.espera === 'confirmacao') {
                const temConfirmacao = resposta.toLowerCase().includes('reservado') ||
                    resposta.toLowerCase().includes('confirmado') ||
                    resposta.toLowerCase().includes('agendado');
                console.log(`   ✅ Confirmação: ${temConfirmacao ? 'SIM' : 'NÃO'}`);
            }

            // Atualiza lead para próximo passo
            lead = await Leads.findById(lead._id);

        } catch (err) {
            console.error(`   ❌ ERRO: ${err.message}`);
        }

        passo++;
    }

    // Resumo final
    const leadFinal = await Leads.findById(lead._id);
    console.log(`\n📊 RESUMO FINAL:`);
    console.log(`   Terapia: ${leadFinal.therapyArea || 'N/A'}`);
    console.log(`   Queixa: ${leadFinal.primaryComplaint || 'N/A'}`);
    console.log(`   Idade: ${leadFinal.patientInfo?.age || 'N/A'}`);
    console.log(`   Slot escolhido: ${leadFinal.pendingChosenSlot ? 'SIM' : 'NÃO'}`);
    console.log(`   Nome paciente: ${leadFinal.patientInfo?.name || 'N/A'}`);

    await Leads.deleteMany({ 'contact.phone': TEST_PHONE });
    console.log(`\n✅ Teste ${nomeCenario} concluído!`);
}

// Roda todos os testes
async function runTests() {
    console.log('🚀 INICIANDO TESTES DE INTERRUÇÃO E RETOMADA\n');

    await mongoose.connect(process.env.MONGODB_URI || process.env.MONGO_URI);
    console.log('✅ MongoDB conectado\n');

    try {
        await simularConversa(CENARIO_INTERRUPCAO_PRECO, 'Interrupção por Preço');
        await simularConversa(CENARIO_INTERRUPCAO_INFO, 'Interrupção por Info Terapia');
        await simularConversa(CENARIO_MULTIPLAS_INTERRUPCOES, 'Múltiplas Interrupções');

        console.log(`\n\n${'='.repeat(60)}`);
        console.log('🎉 TODOS OS TESTES CONCLUÍDOS!');
        console.log('='.repeat(60));

    } catch (err) {
        console.error('❌ Erro nos testes:', err);
    }

    await mongoose.disconnect();
    process.exit(0);
}

runTests();