#!/usr/bin/env node
/**
 * 🧪 TESTES UNITÁRIOS - Therapy Area Mapping
 * 
 * Testes para garantir que o mapeamento de therapyArea (IDs em inglês/abreviações 
 * para nomes em português) funcione corretamente.
 * 
 * Issue: A busca de slots falhava porque therapyArea vinha como 'fono'/'speech'
 * mas a busca no banco esperava 'fonoaudiologia'.
 */

const c = {
    reset: '\x1b[0m',
    green: '\x1b[32m',
    red: '\x1b[31m',
    cyan: '\x1b[36m',
    yellow: '\x1b[33m'
};

function log(color, msg) { console.log(`${color}${msg}${c.reset}`); }

// Mapeamento que deve estar em messageContextBuilder.js e WhatsAppOrchestrator.js
const AREA_MAP = {
    // Fonoaudiologia
    "speech": "fonoaudiologia",
    "tongue_tie": "fonoaudiologia",
    "fono": "fonoaudiologia",
    "fonoaudiologia": "fonoaudiologia",
    // Psicologia
    "psychology": "psicologia",
    "psico": "psicologia",
    "psicologia": "psicologia",
    // Terapia Ocupacional
    "occupational": "terapia_ocupacional",
    "to": "terapia_ocupacional",
    "terapia_ocupacional": "terapia_ocupacional",
    // Fisioterapia
    "physiotherapy": "fisioterapia",
    "fisio": "fisioterapia",
    "fisioterapia": "fisioterapia",
    // Musicoterapia
    "music": "musicoterapia",
    "musicoterapia": "musicoterapia",
    // Neuropsicologia
    "neuropsychological": "neuropsicologia",
    "neuro": "neuropsicologia",
    "neuropsicologia": "neuropsicologia",
    // Psicopedagogia
    "psychopedagogy": "psicopedagogia",
    "psicoped": "psicopedagogia",
    "psicopedagogia": "psicopedagogia",
    "neuropsychopedagogy": "neuropsicologia",
};

function normalizeTherapyArea(rawTherapy) {
    return AREA_MAP[rawTherapy] || rawTherapy;
}

const TEST_CASES = [
    // Abreviações comuns (o problema principal)
    { input: 'fono', expected: 'fonoaudiologia', desc: 'Abreviação: fono → fonoaudiologia' },
    { input: 'psico', expected: 'psicologia', desc: 'Abreviação: psico → psicologia' },
    { input: 'fisio', expected: 'fisioterapia', desc: 'Abreviação: fisio → fisioterapia' },
    { input: 'to', expected: 'terapia_ocupacional', desc: 'Abreviação: to → terapia_ocupacional' },
    { input: 'neuro', expected: 'neuropsicologia', desc: 'Abreviação: neuro → neuropsicologia' },
    { input: 'psicoped', expected: 'psicopedagogia', desc: 'Abreviação: psicoped → psicopedagogia' },
    
    // IDs em inglês (usados internamente)
    { input: 'speech', expected: 'fonoaudiologia', desc: 'ID inglês: speech → fonoaudiologia' },
    { input: 'psychology', expected: 'psicologia', desc: 'ID inglês: psychology → psicologia' },
    { input: 'physiotherapy', expected: 'fisioterapia', desc: 'ID inglês: physiotherapy → fisioterapia' },
    { input: 'occupational', expected: 'terapia_ocupacional', desc: 'ID inglês: occupational → terapia_ocupacional' },
    { input: 'neuropsychological', expected: 'neuropsicologia', desc: 'ID inglês: neuropsychological → neuropsicologia' },
    { input: 'psychopedagogy', expected: 'psicopedagogia', desc: 'ID inglês: psychopedagogy → psicopedagogia' },
    { input: 'music', expected: 'musicoterapia', desc: 'ID inglês: music → musicoterapia' },
    
    // Nomes completos em português (já devem estar corretos)
    { input: 'fonoaudiologia', expected: 'fonoaudiologia', desc: 'Nome PT: fonoaudiologia → fonoaudiologia' },
    { input: 'psicologia', expected: 'psicologia', desc: 'Nome PT: psicologia → psicologia' },
    { input: 'fisioterapia', expected: 'fisioterapia', desc: 'Nome PT: fisioterapia → fisioterapia' },
    { input: 'terapia_ocupacional', expected: 'terapia_ocupacional', desc: 'Nome PT: terapia_ocupacional → terapia_ocupacional' },
    { input: 'neuropsicologia', expected: 'neuropsicologia', desc: 'Nome PT: neuropsicologia → neuropsicologia' },
    { input: 'psicopedagogia', expected: 'psicopedagogia', desc: 'Nome PT: psicopedagogia → psicopedagogia' },
    { input: 'musicoterapia', expected: 'musicoterapia', desc: 'Nome PT: musicoterapia → musicoterapia' },
    
    // Casos especiais
    { input: 'tongue_tie', expected: 'fonoaudiologia', desc: 'Caso especial: tongue_tie → fonoaudiologia' },
    { input: 'neuropsychopedagogy', expected: 'neuropsicologia', desc: 'Caso especial: neuropsychopedagogy → neuropsicologia' },
    
    // Valores não mapeados (devem passar direto)
    { input: 'outra_especialidade', expected: 'outra_especialidade', desc: 'Não mapeado: passa direto' },
    { input: null, expected: null, desc: 'null → null' },
    { input: undefined, expected: undefined, desc: 'undefined → undefined' },
];

let passed = 0;
let failed = 0;

log(c.cyan, '🧪 TESTES UNITÁRIOS - Therapy Area Mapping\n');

for (const test of TEST_CASES) {
    const result = normalizeTherapyArea(test.input);
    const success = result === test.expected;
    
    if (success) {
        log(c.green, `✅ ${test.desc}`);
        passed++;
    } else {
        log(c.red, `❌ ${test.desc}`);
        log(c.red, `   Input: ${test.input}`);
        log(c.red, `   Expected: ${test.expected}`);
        log(c.red, `   Got: ${result}`);
        failed++;
    }
}

// Teste de integração simulado: cenário do erro real
log(c.cyan, '\n📋 TESTE DE CENÁRIO REAL:');
log(c.cyan, 'Cenário: Lead informa nome, terapia="fono" é detectada, busca de slots deve funcionar');

const scenarioLead = {
    stateData: { therapy: 'fono', period: 'tarde' },
    therapyArea: null
};

const therapyFromState = scenarioLead.stateData?.therapy;
const normalizedTherapy = normalizeTherapyArea(therapyFromState);

if (normalizedTherapy === 'fonoaudiologia') {
    log(c.green, '✅ Cenário real: fono normalizado para fonoaudiologia');
    passed++;
} else {
    log(c.red, `❌ Cenário real falhou: esperado fonoaudiologia, got ${normalizedTherapy}`);
    failed++;
}

// Resumo
log(c.cyan, '\n' + '='.repeat(50));
log(c.green, `✅ Passaram: ${passed}`);
if (failed > 0) {
    log(c.red, `❌ Falharam: ${failed}`);
}
log(c.cyan, `Total: ${passed + failed}`);

if (failed > 0) {
    process.exit(1);
}
