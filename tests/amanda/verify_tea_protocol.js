
import { getWisdomForContext } from '../../utils/clinicWisdom.js';

console.log("🧩 Verificando Protocolo TEA em clinicWisdom.js...");

// Mock de flags detectadas
const flags = {
    mentionsTEA_TDAH: true,
    normalizedText: "gostaria de saber se meu filho tem tea"
};

const result = getWisdomForContext('psicologia', flags);

console.log("\n--- Bloco Gerado ---");
console.log(result.wisdomBlock);
console.log("--------------------\n");

const has6Months = result.wisdomBlock.includes('6 meses');
const hasNeuro = result.wisdomBlock.includes('neuropediatra');
const hasWarning = result.wisdomBlock.includes('não fechamos diagnóstico');

if (has6Months && hasNeuro && hasWarning) {
    console.log("✅ SUCESSO: Protocolo TEA atualizado corretamente.");
    process.exit(0);
} else {
    console.error("❌ FALHA: Texto não contém todos os elementos obrigatórios (6 meses, neuropediatra, não fecha diagnóstico).");
    process.exit(1);
}
