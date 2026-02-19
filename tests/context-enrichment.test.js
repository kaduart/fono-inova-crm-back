/**
 * Testes para verificar enriquecimento de contexto
 * detectManualIntent, computeTeaStatus, shouldOfferScheduling
 */

import { detectManualIntent, computeTeaStatus } from '../utils/flagsDetector.js';
import { shouldOfferScheduling } from '../utils/amandaPrompt.js';

console.log('🧪 Testando enriquecimento de contexto...\n');

// Teste 1: detectManualIntent
console.log('1️⃣ Testando detectManualIntent():');
const manualTests = [
    { text: 'Qual o endereço?', expected: 'address' },
    { text: 'Vocês atendem Unimed?', expected: 'plans' },
    { text: 'Oi, tudo bem?', expected: 'greeting' },
    { text: 'Quanto custa a avaliação?', expected: 'price_generic' },
    { text: 'Quero agendar fonoaudiologia', expected: null }, // Não é manual
];

for (const test of manualTests) {
    const result = detectManualIntent(test.text);
    const detected = result?.intent || null;
    const passed = detected === test.expected;
    console.log(`  ${passed ? '✅' : '❌'} "${test.text}"`);
    console.log(`     Esperado: ${test.expected} | Detectado: ${detected}`);
}

// Teste 2: computeTeaStatus
console.log('\n2️⃣ Testando computeTeaStatus():');
const teaTests = [
    { 
        flags: { mentionsTEA_TDAH: true, mentionsLaudo: true, mentionsDoubtTEA: false },
        text: 'Meu filho tem laudo de TEA',
        expected: 'laudo_confirmado'
    },
    { 
        flags: { mentionsTEA_TDAH: true, mentionsLaudo: false, mentionsDoubtTEA: true },
        text: 'Suspeita de autismo',
        expected: 'suspeita'
    },
    { 
        flags: { mentionsTEA_TDAH: false, mentionsLaudo: false },
        text: 'Atraso de fala',
        expected: 'desconhecido'
    },
];

for (const test of teaTests) {
    const result = computeTeaStatus(test.flags, test.text);
    const passed = result === test.expected;
    console.log(`  ${passed ? '✅' : '❌'} "${test.text.substring(0, 30)}..."`);
    console.log(`     Esperado: ${test.expected} | Detectado: ${result}`);
}

// Teste 3: shouldOfferScheduling
console.log('\n3️⃣ Testando shouldOfferScheduling():');
const schedulingTests = [
    { 
        context: { stage: 'novo', messageCount: 1, hasTherapyContext: false },
        expected: false // Primeiro contato, não oferece ainda
    },
    { 
        context: { stage: 'engajado', messageCount: 5, hasTherapyContext: true, hasPriceObjection: false },
        expected: true // Já engajado, tem contexto de terapia
    },
    { 
        context: { stage: 'pesquisando_preco', messageCount: 3, hasTherapyContext: true, hasPriceObjection: true },
        expected: false // Tem objeção de preço, não oferece agendamento ainda
    },
];

for (const test of schedulingTests) {
    const result = shouldOfferScheduling(test.context);
    const passed = result === test.expected;
    console.log(`  ${passed ? '✅' : '❌'} Estágio: ${test.context.stage}, msgs: ${test.context.messageCount}`);
    console.log(`     Esperado: ${test.expected} | Retornado: ${result}`);
}

console.log('\n✨ Testes concluídos!');
