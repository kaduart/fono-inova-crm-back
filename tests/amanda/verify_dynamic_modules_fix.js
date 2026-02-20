
import { getOptimizedAmandaResponse } from '../../orchestrators/AmandaOrchestrator.js';
import mongoose from 'mongoose';
import 'dotenv/config';

// Connect to DB
const MONGODB_URI = process.env.MONGODB_URI || "mongodb://user:password@localhost:27017/crm_clinica?authSource=admin";

// Mock Lead
const mockLead = {
    _id: new mongoose.Types.ObjectId(),
    name: "Teste Lead",
    status: "novo",
    stage: "novo",
    contact: { phone: "5562999999999" }
};

async function runTest() {
    console.log("🚀 Testando fix de DYNAMIC_MODULES...\n");

    try {
        if (mongoose.connection.readyState === 0) {
            await mongoose.connect(MONGODB_URI);
            console.log("📦 Conectado ao MongoDB\n");
        }

        // Teste 1: Saudação simples (caso que estava falhando)
        console.log("Teste 1: Saudação simples 'Ola Bom dia'");
        const response1 = await getOptimizedAmandaResponse({
            content: "Ola Bom dia",
            userText: "Ola Bom dia",
            lead: mockLead,
            context: {}
        });
        
        console.log("✅ Resposta:", response1 ? (response1.text || response1).substring(0, 100) + "..." : "null");
        console.log("");

        // Teste 2: Pergunta sobre acompanhamento (caso que estava falhando)
        console.log("Teste 2: Pergunta 'Gostaria de saber como funciona os acompanhamento'");
        const mockLead2 = {
            _id: new mongoose.Types.ObjectId(),
            name: "Teste Lead 2",
            status: "novo", 
            stage: "novo",
            contact: { phone: "5562999999998" }
        };
        
        const response2 = await getOptimizedAmandaResponse({
            content: "Gostaria de saber como funciona os acompanhamento",
            userText: "Gostaria de saber como funciona os acompanhamento",
            lead: mockLead2,
            context: {}
        });
        
        console.log("✅ Resposta:", response2 ? (response2.text || response2).substring(0, 100) + "..." : "null");
        console.log("");

        // Teste 3: Verificar se toneMode funciona
        console.log("Teste 3: Testando toneMode 'premium'");
        const mockLead3 = {
            _id: new mongoose.Types.ObjectId(),
            name: "Teste Lead 3",
            status: "novo",
            stage: "novo",
            contact: { phone: "5562999999997" }
        };
        
        const response3 = await getOptimizedAmandaResponse({
            content: "Quanto custa a avaliação?",
            userText: "Quanto custa a avaliação?",
            lead: mockLead3,
            context: { toneMode: "premium" }
        });
        
        console.log("✅ Resposta:", response3 ? (response3.text || response3).substring(0, 100) + "..." : "null");
        console.log("");

        console.log("🎉 TODOS OS TESTES PASSARAM!");
        console.log("O erro 'DYNAMIC_MODULES is not defined' foi corrigido.");
        process.exit(0);

    } catch (error) {
        if (error.message.includes("DYNAMIC_MODULES is not defined")) {
            console.error("\n❌ FALHA CRÍTICA: O bug 'DYNAMIC_MODULES is not defined' ainda existe!");
            console.error("Stack:", error.stack);
            process.exit(1);
        } else {
            console.error("\n⚠️  Erro (não relacionado ao DYNAMIC_MODULES):", error.message);
            console.error("Stack:", error.stack);
            process.exit(1);
        }
    }
}

runTest();
