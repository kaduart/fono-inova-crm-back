/**
 * 🧪 Teste do Modo LP (Landing Page)
 * Valida se as mensagens do site são detectadas corretamente
 */

import { detectLPContext, isLikelyLandingPageMessage, inferAreaFromLPText } from '../../orchestrators/AmandaOrchestrator-LP-PATCH.js';

// Mensagens do teste site completo
const TEST_CASES = [
    // Caso #1 - Home (genérico)
    { msg: "Oi, é para meu filho", expected: 'lp_generic', desc: "Home - genérico" },
    
    // Caso #2 - Home (neuro específico)
    { msg: "Quero avaliação neuropsicológica", expected: 'neuro', desc: "Home - neuro direto" },
    
    // Casos #5-7 - Dislexia
    { msg: "Quero avaliação para dislexia", expected: 'neuro', desc: "Dislexia LP" },
    { msg: "Quero informações sobre dislexia", expected: 'neuro', desc: "Dislexia LP (info)" },
    
    // TEA/TDAH
    { msg: "Quero avaliação TEA", expected: 'neuro', desc: "TEA LP" },
    { msg: "Avaliação neuropsicológica TDAH", expected: 'neuro', desc: "TDAH LP" },
    
    // Fonoaudiologia
    { msg: "Quero fonoaudiologia para meu filho", expected: 'fono', desc: "Fono LP" },
    { msg: "Teste da linguinha", expected: 'fono', desc: "Linguinha LP" },
    
    // Psicologia
    { msg: "Quero psicologia", expected: 'psico', desc: "Psico LP" },
    
    // TO
    { msg: "Terapia ocupacional", expected: 'to', desc: "TO LP" },
    
    // Conversa orgânica (NÃO deve detectar como LP)
    { msg: "Oi, tudo bem? Meu filho está com atraso na fala", expected: null, desc: "Orgânica - greeting longo" },
    { msg: "Bom dia! Gostaria de informações sobre atendimento", expected: null, desc: "Orgânica - formal" },
];

console.log('🧪 TESTE DO MODO LP\n');
console.log('='.repeat(60));

let passed = 0;
let failed = 0;

for (const test of TEST_CASES) {
    const result = detectLPContext(test.msg, {});
    const detected = result?.context || null;
    const area = result?.area || null;
    
    const isPass = detected === test.expected || 
                   (test.expected && detected?.includes(test.expected)) ||
                   (!test.expected && !detected);
    
    const status = isPass ? '✅' : '❌';
    
    console.log(`\n${status} ${test.desc}`);
    console.log(`   Mensagem: "${test.msg}"`);
    console.log(`   Esperado: ${test.expected || 'null'}`);
    console.log(`   Detectado: ${detected || 'null'}`);
    console.log(`   Área: ${area || 'nenhuma'}`);
    
    if (isPass) passed++;
    else failed++;
}

console.log('\n' + '='.repeat(60));
console.log(`\n📊 RESULTADO: ${passed} passaram, ${failed} falharam`);

if (failed === 0) {
    console.log('\n✅ Todos os testes passaram! Modo LP está funcionando corretamente.');
} else {
    console.log('\n⚠️ Alguns testes falharam. Revisar implementação.');
    process.exit(1);
}
