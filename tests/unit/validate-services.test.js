/**
 * Testes para validação de serviços
 * Verifica se a Amanda não oferece serviços que não existem
 */

import { validateServiceAvailability, detectMedicalSpecialty } from '../utils/flagsDetector.js';
import { getMedicalSpecialtyResponse, SERVICE_REDIRECT_WISDOM } from '../utils/clinicWisdom.js';
import { clinicalEligibility } from '../domain/policies/ClinicalEligibility.js';

// Testes de especialidades médicas
console.log('🧪 Testando detecção de especialidades médicas...\n');

const medicalTests = [
    // ✅ ATUALIZADO Abr/2026: Neuropediatra agora é serviço disponível na clínica!
    // { text: 'Tem neuropediatra?', expected: 'neurologista', shouldBlock: true },
    { text: 'Vocês têm neurologista?', expected: 'neurologista', shouldBlock: true },
    { text: 'Preciso de pediatra', expected: 'pediatra', shouldBlock: true },
    { text: 'Tem psiquiatra?', expected: 'psiquiatra', shouldBlock: true },
    { text: 'Quero agendar fonoaudiologia', expected: null, shouldBlock: false },
    { text: 'Tem neuropsicologia?', expected: null, shouldBlock: false },
    { text: 'Tem neuropediatra?', expected: null, shouldBlock: false }, // ✅ Agora disponível
];

let passed = 0;
let failed = 0;

for (const test of medicalTests) {
    const result = detectMedicalSpecialty(test.text);
    const detected = result?.specialty || null;
    const shouldBlock = result?.isMedical || false;
    
    if (detected === test.expected && shouldBlock === test.shouldBlock) {
        console.log(`✅ PASS: "${test.text}"`);
        console.log(`   Detected: ${detected}, Blocked: ${shouldBlock}`);
        passed++;
    } else {
        console.log(`❌ FAIL: "${test.text}"`);
        console.log(`   Expected: ${test.expected} (block: ${test.shouldBlock})`);
        console.log(`   Got: ${detected} (block: ${shouldBlock})`);
        failed++;
    }
}

// Testes de respostas humanizadas
console.log('\n🧪 Testando respostas humanizadas...\n');

const responseTests = [
    // ✅ ATUALIZADO Abr/2026: Neuropediatra agora tem hasRedirect: false (disponível na clínica!)
    { specialty: 'neuropediatra', shouldRedirect: false },
    { specialty: 'pediatra', shouldRedirect: false },
    { specialty: 'neurologista', shouldRedirect: true },
];

for (const test of responseTests) {
    const response = getMedicalSpecialtyResponse(test.specialty);
    
    console.log(`\n📋 ${test.specialty.toUpperCase()}:`);
    console.log('─'.repeat(60));
    console.log(response.text.substring(0, 300) + '...');
    console.log('─'.repeat(60));
    console.log(`Has redirect: ${response.hasRedirect} (expected: ${test.shouldRedirect})`);
    
    if (response.hasRedirect === test.shouldRedirect) {
        passed++;
    } else {
        failed++;
    }
}

// Teste de ClinicalEligibility
console.log('\n🧪 Testando ClinicalEligibility...\n');

const eligibilityTests = [
    // ✅ ATUALIZADO Abr/2026: Neuropediatra agora disponível - não deve ser bloqueado
    { 
        text: 'Tem neuropediatra para meu filho?',
        therapy: 'neuropediatria',
        age: 8,
        expectedBlocked: false
    },
    {
        text: 'Quero neuropsicologia',
        therapy: 'neuropsicologia',
        age: 10,
        expectedBlocked: false
    },
    {
        text: 'Psicologia para adulto de 30 anos',
        therapy: 'psicologia',
        age: 30,
        expectedBlocked: true  // Psicologia só até 16
    }
];

(async () => {
    for (const test of eligibilityTests) {
        const result = await clinicalEligibility.validate({
            therapy: test.therapy,
            age: test.age,
            text: test.text,
            clinicalHistory: {}
        });
        
        if (result.blocked === test.expectedBlocked) {
            console.log(`✅ PASS: "${test.text.substring(0, 40)}..."`);
            console.log(`   Blocked: ${result.blocked}, Reason: ${result.reason || 'N/A'}`);
            passed++;
        } else {
            console.log(`❌ FAIL: "${test.text.substring(0, 40)}..."`);
            console.log(`   Expected blocked: ${test.expectedBlocked}, Got: ${result.blocked}`);
            failed++;
        }
    }

    // Resultado final
    console.log('\n' + '='.repeat(60));
    console.log(`📊 RESULTADO: ${passed} passaram, ${failed} falharam`);
    console.log('='.repeat(60));
    
    process.exit(failed > 0 ? 1 : 0);
})();
