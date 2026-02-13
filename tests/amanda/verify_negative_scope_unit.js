
import { buildSystemPrompt } from '../../utils/amandaPrompt.js';

function verify() {
    console.log("📝 Testando Injeção de Escopo Negativo DESACOPLADO (Unitário)...");

    // Cenário 1: Learnings NULL, mas Negative Scope PRESENTE (Simula Kill Switch + Regra verificada antiga)
    const context = {
        patientName: "Maria",
        learnings: null, // Kill switch ativado
        negativeScope: [
            { term: "raio-x", phrase: "infelizmente não realizamos raio-x" }
        ]
    };

    const prompt = buildSystemPrompt(context);

    // Verifica se a seção existe MESMO SEM LEARNINGS
    if (prompt.includes("⛔ O QUE NÃO FAZEMOS")) {
        console.log("✅ SUCESSO: Seção de escopo negativo encontrada (mesmo com learnings=null)!");
    } else {
        console.error("❌ FALHA: Seção de escopo negativo NÃO encontrada.");
        process.exit(1);
    }

    // Verifica se os termos estão lá
    if (prompt.includes("RAIO-X")) {
        console.log("✅ SUCESSO: Termo 'RAIO-X' encontrado no prompt.");
    } else {
        console.error("❌ FALHA: Termo 'RAIO-X' deveria estar lá.");
        process.exit(1);
    }

    console.log("---------------------------------------------------");
}

verify();
