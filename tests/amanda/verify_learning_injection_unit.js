
import { buildSystemPrompt } from '../../utils/amandaPrompt.js';

function verify() {
    console.log("📝 Testando Injeção no Prompt (Unitário)...");

    // Mock dos learnings
    const mockLearnings = {
        openings: [{ text: "Olá Mock!", origin: "test" }],
        priceHandling: [{ text: "O valor é X", scenario: "general" }],
        closings: [{ text: "Podemos agendar?", stage: "closing" }]
    };

    const context = {
        patientName: "João",
        learnings: mockLearnings
    };

    const prompt = buildSystemPrompt(context);

    if (prompt.includes("APRENDIZADOS AUTOMÁTICOS") && prompt.includes("Olá Mock!")) {
        console.log("✅ SUCESSO: Seção de aprendizado encontrada no prompt!");
        console.log("---------------------------------------------------");
        const sections = prompt.split("APRENDIZADOS AUTOMÁTICOS");
        const relevantPart = sections[1].split("##")[0];
        console.log(relevantPart.trim());
        console.log("---------------------------------------------------");
    } else {
        console.error("❌ FALHA: Seção de aprendizado NÃO encontrada.");
        console.log("Prompt gerado (primeiros 500 chars):", prompt.substring(0, 500));
    }
}

verify();
