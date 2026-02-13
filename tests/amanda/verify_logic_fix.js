
import { getWisdomForContext } from '../../utils/clinicWisdom.js';

console.log("=== VERIFICANDO LÓGICA DE DETECÇÃO DE CIRURGIA ===");

// Caso 1: Detecção explícita (teste antigo)
console.log("\n--- TESTE 1: Flag 'mentionsTongueTieSurgery' explícita ---");
const flags1 = { mentionsTongueTieSurgery: true, mentionsGeneralSurgery: true };
const wisdom1 = getWisdomForContext(null, flags1);
// console.log(wisdom1.wisdomBlock);

if (wisdom1.wisdomBlock.includes("NÃO realiza a cirurgia")) {
    console.log("✅ PASSOU: Negou cirurgia (Detecção direta)");
} else {
    console.log("❌ FALHOU: Não negou cirurgia");
}

// Caso 2: Contexto + Detecção genérica (O FIX)
console.log("\n--- TESTE 2: Contexto 'teste_linguinha' + 'mentionsGeneralSurgery' ---");
const flags2 = { mentionsTongueTieSurgery: false, mentionsGeneralSurgery: true };
const topic2 = 'teste_linguinha';
const wisdom2 = getWisdomForContext(topic2, flags2);
// console.log(wisdom2.wisdomBlock);

if (wisdom2.wisdomBlock.includes("NÃO realiza a cirurgia")) {
    console.log("✅ PASSOU: Negou cirurgia (Contexto 'teste_linguinha' + 'procedimento')");
} else {
    console.log("❌ FALHOU: Não negou cirurgia no contexto correto");
    console.log("Block content:", wisdom2.wisdomBlock);
}

// Caso 3: Contexto diferente + Detecção genérica (Controle)
console.log("\n--- TESTE 3: Contexto 'fonoaudiologia' + 'mentionsGeneralSurgery' ---");
const flags3 = { mentionsTongueTieSurgery: false, mentionsGeneralSurgery: true };
const topic3 = 'fonoaudiologia';
const wisdom3 = getWisdomForContext(topic3, flags3);

if (!wisdom3.wisdomBlock.includes("NÃO realiza a cirurgia")) {
    console.log("✅ PASSOU: Não negou cirurgia de linguinha (Contexto irrelevante)");
} else {
    console.log("❌ FALHOU: Negou cirurgia incorretamente");
}
