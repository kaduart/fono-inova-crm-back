
import 'dotenv/config';
import mongoose from 'mongoose';
import { getOptimizedAmandaResponse } from '../../orchestrators/AmandaOrchestrator.js';
import Leads from '../../models/Leads.js';

const PHONE = '556299998888';

async function run() {
    try {
        if (!process.env.MONGO_URI) {
            console.error("❌ MONGO_URI não definida no .env");
            process.exit(1);
        }
        await mongoose.connect(process.env.MONGO_URI);

        // Limpa lead de teste anterior
        await Leads.deleteMany({ phone: PHONE });

        // Cria lead simulando estado onde Amanda perguntou "manhã ou tarde"
        // e usuário vai responder com uma data específica
        const lead = await Leads.create({
            name: 'Teste Data',
            phone: PHONE,
            stage: 'interessado_agendamento',
            therapyArea: 'fonoaudiologia',
            patientInfo: {
                age: 5,
                name: 'Luizinho',
                complaint: 'Dificuldade na fala'
            },
            pendingPreferredPeriod: 'manha',  // CORRIGIDO: sem til
            autoBookingContext: {
                active: true,
                awaitingPeriodChoice: true,
                preferredPeriod: 'manha'      // CORRIGIDO: sem til
            },
            qualificationData: {
                extractedInfo: {
                    queixa: 'fala',
                    idade: '5 anos'
                }
            }
        });

        console.log("--- CENÁRIO: Usuário responde data específica ('dia 19/02') ---");

        // Mensagem com data específica sem "a partir"
        const userMsg = "dia 19/02";
        console.log(`👤 User: "${userMsg}"`);

        // Simula chamada do controller
        const response = await getOptimizedAmandaResponse({
            content: userMsg,
            userText: userMsg,
            lead: await Leads.findById(lead._id).lean(),
            context: { source: 'whatsapp-inbound' },
            messageId: `test-date-${Date.now()}`
        });

        const text = response?.payload?.text || response?.text || '';
        console.log(`🤖 AI: "${text}"`);

        // Validação
        const lowerText = text.toLowerCase();

        const isConfirmation = lowerText.includes("confirmad") || lowerText.includes("agendad");
        const isVerification = lowerText.includes("verificar") || lowerText.includes("olhar") || lowerText.includes("checar");
        const isNotFound = lowerText.includes("não encontrei") || lowerText.includes("não achei") || lowerText.includes("sem vaga");
        const isOptions = lowerText.includes("opções") || lowerText.includes("horários");

        if (isConfirmation) {
            console.log("❌ FALHOU: IA confirmou agendamento sem garantia de vaga!");
            process.exit(1);
        } else if (isVerification || isNotFound || isOptions) {
            console.log("✅ PASSOU: IA verificou disponibilidade ou ofereceu opções reais/falha de busca.");
        } else {
            console.log("⚠️ ALERTA: Resposta parece segura (não confirmou), mas verificar se buscou slots.");
        }

    } catch (error) {
        console.error("❌ ERRO NO TESTE:", error);
    } finally {
        await mongoose.disconnect();
    }
}

run();
