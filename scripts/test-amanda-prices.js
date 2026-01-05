// ✅ FUNÇÃO 100% CORRIGIDA
function priceLineForTopic(topic, userText, conversationSummary = '') {
    const mentionsCDL = /\bcdl\b/i.test(userText || "");

    switch (topic) {
        case "neuropsicologica":
            return "A avaliação neuropsicológica completa (10 sessões) é R$ 2.000 (6x)";
        case "teste_linguinha":
            return "O Teste da Linguinha custa R$ 150,00.";
        case "sessao":
            return "Sessão avulsa R$ 200; no pacote mensal sai por R$ 180/sessão (~R$ 720/mês).";
        case "psicopedagogia":
            return "Psicopedagogia: anamnese R$ 200; pacote mensal R$ 160/sessão (~R$ 640/mês).";
    }

    const ctx = (conversationSummary || '').toLowerCase();
    const msg = (userText || '').toLowerCase();
    const combined = `${ctx} ${msg}`;

    if (/\b(tea|autis|tdah|neuro|laudo|avalia[çc][aã]o\s+completa|cognitiv)\b/.test(combined)) {
        return "A avaliação neuropsicológica completa (10 sessões) é R$ 2.000 (6x)";
    }

    if (/\b(psicopedagog|dificuldade.{0,20}aprend)/i.test(combined)) {
        return "Psicopedagogia: anamnese R$ 200; pacote mensal R$ 160/sessão (~R$ 640/mês).";
    }

    if (/\b(psic[oó]log|ansiedade|emocional|comportamento)\b/.test(combined)) {
        return "Avaliação inicial R$ 200; pacote mensal R$ 640 (1x/semana, R$ 160/sessão).";
    }

    if (/\b(terapia\s+ocupacional|to\b|integra[çc][aã]o\s+sensorial)\b/.test(combined)) {
        return "Avaliação inicial R$ 200; pacote mensal R$ 720 (1x/semana, R$ 180/sessão).";
    }

    if (/\b(fisioterap|fisio\b|reabilita[çc][aã]o)\b/.test(combined)) {
        return "Avaliação inicial R$ 200; pacote mensal R$ 640 (1x/semana, R$ 160/sessão).";
    }

    if (/\b(fono|fala|linguagem|crian[çc]a|beb[eê]|atraso)\b/.test(combined)) {
        return "Avaliação inicial R$ 200; pacote mensal R$ 720 (1x/semana, R$ 180/sessão).";
    }

    if (mentionsCDL) {
        return "A avaliação CDL é R$ 200,00.";
    }

    return null;
}

// TODOS OS TESTES
const tests = [
    {
        name: 'TEA Adulto',
        topic: 'avaliacao_inicial',
        text: 'Qual o valor?',
        summary: 'Lead adulto, 26 anos, precisa laudo TEA para trabalho.',
        expect: r => r?.includes('2.000')
    },
    {
        name: 'Criança Fala',
        topic: 'avaliacao_inicial',
        text: 'Quanto custa?',
        summary: 'Criança 2 anos e 11 meses. Fala poucas palavras.',
        expect: r => r?.includes('200') && r?.includes('720')
    },
    {
        name: 'Psicologia',
        topic: 'avaliacao_inicial',
        text: 'Qual o valor?',
        summary: 'Lead interessado em psicologia para ansiedade.',
        expect: r => r?.includes('200') && r?.includes('640')
    },
    {
        name: 'TO',
        topic: 'avaliacao_inicial',
        text: 'Me fala o preço',
        summary: 'Criança 5 anos coordenação motora. Mãe perguntou TO.',
        expect: r => r?.includes('200') && r?.includes('720')
    },
    {
        name: 'Sem Contexto',
        topic: 'avaliacao_inicial',
        text: 'Quanto custa?',
        summary: '',
        expect: r => r === null
    },
    {
        name: 'Fisioterapia',
        topic: 'avaliacao_inicial',
        text: 'Valor da fisioterapia?',
        summary: 'Adulto com dor crônica, reabilitação funcional.',
        expect: r => r?.includes('200') && r?.includes('640')
    },
    {
        name: 'Psicopedagogia',
        topic: 'avaliacao_inicial',
        text: 'Quanto é?',
        summary: 'Criança 8 anos com dificuldade de aprendizagem.',
        expect: r => r?.includes('200') && r?.includes('640')
    }
];

console.log('='.repeat(80));
console.log('🧪 SUITE COMPLETA DE TESTES - VERSÃO FINAL');
console.log('='.repeat(80));

let passed = 0;

tests.forEach((test, i) => {
    const result = priceLineForTopic(test.topic, test.text, test.summary);
    const success = test.expect(result);

    console.log(`\n${i + 1}. ${success ? '✅' : '❌'} ${test.name}`);
    console.log(`   Resultado: ${result === null ? 'null' : result.substring(0, 60)}...`);

    if (success) passed++;
});

console.log('\n' + '='.repeat(80));
console.log(`🎯 RESULTADO: ${passed}/${tests.length} testes passaram`);
console.log('='.repeat(80));

if (passed === tests.length) {
    console.log('\n✅ 100% DOS TESTES PASSARAM!');
    console.log('🚀 Sistema pronto para produção.');
} else {
    console.log(`\n⚠️ ${tests.length - passed} teste(s) falharam.`);
}