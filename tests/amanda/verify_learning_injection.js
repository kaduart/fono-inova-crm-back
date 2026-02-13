
import mongoose from 'mongoose';
import { getActiveLearnings } from '../../services/LearningInjector.js';
import { buildSystemPrompt } from '../../utils/amandaPrompt.js';
import LearningInsight from '../../models/LearningInsight.js';
import dotenv from 'dotenv';
dotenv.config();

async function verify() {
    try {
        console.log("🔌 Conectando ao MongoDB...");
        await mongoose.connect(process.env.MONGO_URI);

        console.log("\n🔍 1. Testando LearningInjector...");
        const learnings = await getActiveLearnings();

        if (!learnings) {
            console.log("⚠️ Nenhum learning encontrado. Criando mock para teste...");
            // Cria um mock se não existir
            await LearningInsight.create({
                type: 'conversation_patterns',
                data: {
                    bestOpeningLines: [{ text: "Olá! Tudo bem?", leadOrigin: "instagram", usageCount: 10 }],
                    effectivePriceResponses: [{ response: "O valor é X e inclui Y...", scenario: "general" }],
                    successfulClosingQuestions: [{ question: "Podemos agendar?", context: "closing" }]
                },
                leadsAnalyzed: 10,
                conversationsAnalyzed: 10
            });
            console.log("✅ Mock criado.");
        } else {
            console.log("✅ Learnings recuperados:", JSON.stringify(learnings, null, 2));
        }

        console.log("\n📝 2. Testando Injeção no Prompt...");
        const context = {
            patientName: "João",
            learnings: learnings || {
                openings: [{ text: "Olá Mock!", origin: "test" }]
            }
        };

        const prompt = buildSystemPrompt(context);

        if (prompt.includes("APRENDIZADOS AUTOMÁTICOS") && prompt.includes("Olá")) {
            console.log("✅ SUCESSO: Seção de aprendizado encontrada no prompt!");
            console.log("---------------------------------------------------");
            const snippet = prompt.split("APRENDIZADOS AUTOMÁTICOS")[1].split("##")[0];
            console.log(snippet.trim());
            console.log("---------------------------------------------------");
        } else {
            console.error("❌ FALHA: Seção de aprendizado NÃO encontrada.");
        }

    } catch (e) {
        console.error("❌ Erro:", e);
    } finally {
        await mongoose.disconnect();
    }
}

verify();
