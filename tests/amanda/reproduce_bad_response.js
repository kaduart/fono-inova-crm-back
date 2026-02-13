
import { getOptimizedAmandaResponse } from '../../orchestrators/AmandaOrchestrator.js';
import mongoose from 'mongoose';
import 'dotenv/config';

// Connect to DB
const MONGODB_URI = process.env.MONGODB_URI || "mongodb://user:password@localhost:27017/crm_clinica?authSource=admin"; // Adjust based on environment

// Mock Lead
const mockLead = {
    _id: new mongoose.Types.ObjectId(),
    name: "Juliana Teste",
    status: "novo",
    stage: "novo",
    contact: { phone: "5562999999999" }
};

const userMessage = "Bom dia! Tudo bem? Meu nome é Juliana, estou com pedido médico para fazer fisioterapia assimétrica craniana na minha bebê de 5 meses. Vocês têm profissionais especializados neste tratamento? Aceitam Unimed?";

async function runTest() {
    console.log("🚀 Iniciando teste de reprodução...");

    try {
        if (mongoose.connection.readyState === 0) {
            await mongoose.connect(MONGODB_URI);
            console.log("📦 Conectado ao MongoDB");
        }

        // Mock Lead in DB to avoid Refresh error
        // But we can just ignore refresh error as lead object is passed.

        const response = await getOptimizedAmandaResponse({
            content: userMessage,
            userText: userMessage,
            lead: mockLead,
            context: {}
        });

        console.log("\n💬 Resposta da Amanda:\n", response);

        if (response && response.includes("Consulte a equipe para informações detalhadas")) {
            console.log("\n✅ REPRODUZIDO: Resposta genérica detectada.");
            process.exit(0);
        } else {
            console.log("\n❌ NÃO REPRODUZIDO: Resposta parece correta ou diferente do esperado.");
            process.exit(1);
        }

    } catch (error) {
        console.error("Erro:", error);
        process.exit(1);
    }
}

runTest();
