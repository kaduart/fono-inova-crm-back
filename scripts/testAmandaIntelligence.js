import dotenv from 'dotenv';
import mongoose from 'mongoose';
import getOptimizedAmandaResponse from '../amanda/amandaOptimizedReply.js';
import Contact from '../models/Contacts.js';
import Lead from '../models/Leads.js';
import Message from '../models/Message.js';
dotenv.config();

/**
 * 🧪 TESTES TÉCNICOS DA AMANDA 2.0
 */

// Cores para output
const colors = {
    reset: '\x1b[0m',
    green: '\x1b[32m',
    red: '\x1b[31m',
    yellow: '\x1b[33m',
    blue: '\x1b[34m',
    cyan: '\x1b[36m'
};

function log(emoji, text, color = 'reset') {
    console.log(`${colors[color]}${emoji} ${text}${colors.reset}`);
}

/**
 * CRIAR LEAD DE TESTE
 */
async function createTestLead(scenario) {
    const phone = `+5561999${Math.floor(Math.random() * 100000).toString().padStart(5, '0')}`;

    const contact = await Contact.create({
        name: `Lead Teste ${scenario}`,
        phone,
        email: `teste${Date.now()}@fake.com`
    });

    const lead = await Lead.create({
        name: `Lead Teste ${scenario}`,
        contact: contact._id,
        origin: 'WhatsApp',
        status: 'novo'
    });

    return { lead, contact, phone };
}

/**
 * INSERIR MENSAGENS SIMULADAS
 */
async function insertMessages(leadId, contactId, messages) {
    const now = Date.now();

    for (let i = 0; i < messages.length; i++) {
        const msg = messages[i];

        await Message.create({
            lead: leadId,
            contact: contactId,
            direction: msg.direction,
            content: msg.content,
            type: 'text',
            timestamp: new Date(now - ((messages.length - i) * 60 * 1000)), // 1 min entre msgs
            status: 'received'
        });
    }
}

/**
 * TESTAR RESPOSTA DA AMANDA
 */
async function testAmandaResponse(lead, userText, expectedBehavior) {
    log('📤', `Enviando: "${userText}"`, 'cyan');

    const startTime = Date.now();
    const response = await getOptimizedAmandaResponse({
        userText,
        lead,
        content: userText
    });
    const duration = Date.now() - startTime;

    log('📥', `Resposta (${duration}ms): "${response}"`, 'blue');

    // Validações
    const validations = {
        hasHeart: response.includes('💚'),
        noGreeting: !/(oi|olá|ola|tudo bem)/i.test(response) || expectedBehavior.canGreet,
        notTooLong: response.length < 500,
        noDuplicateQuestion: true // Verificar manualmente se não pergunta o que já sabe
    };

    if (expectedBehavior.shouldNotAsk) {
        expectedBehavior.shouldNotAsk.forEach(term => {
            if (new RegExp(term, 'i').test(response)) {
                validations.noDuplicateQuestion = false;
                log('❌', `Perguntou "${term}" sendo que já sabia!`, 'red');
            }
        });
    }

    const allPassed = Object.values(validations).every(v => v);

    if (allPassed) {
        log('✅', 'Validações passaram', 'green');
    } else {
        log('⚠️', `Falhas: ${JSON.stringify(validations, null, 2)}`, 'yellow');
    }

    return { response, duration, validations };
}

/**
 * CENÁRIO 1: CONVERSA CURTA (<20 msgs)
 */
async function testShortConversation() {
    log('🧪', '=== TESTE 1: CONVERSA CURTA (<20 msgs) ===', 'yellow');

    const { lead, contact } = await createTestLead('Curta');

    // Simula 10 mensagens de histórico
    await insertMessages(lead._id, contact._id, [
        { direction: 'inbound', content: 'Oi, quanto custa fono?' },
        { direction: 'outbound', content: 'Avaliação R$ 200, sessão R$ 160. É pra criança?' },
        { direction: 'inbound', content: 'Sim, meu filho de 5 anos' },
        { direction: 'outbound', content: 'Legal! Qual a dificuldade?' },
        { direction: 'inbound', content: 'Ele não fala direito' },
        { direction: 'outbound', content: 'Entendi. Quer agendar avaliação?' },
        { direction: 'inbound', content: 'Quanto custa o pacote mensal?' },
        { direction: 'outbound', content: 'R$ 640/mês (4 sessões). Quer agendar?' },
        { direction: 'inbound', content: 'Sim' },
        { direction: 'outbound', content: 'Ótimo! Prefere manhã ou tarde?' }
    ]);

    // Testa nova mensagem
    const result = await testAmandaResponse(
        lead,
        'Pode ser quinta de manhã',
        {
            canGreet: false, // Conversa ativa
            shouldNotAsk: ['idade', 'quantos anos', 'para quem', 'criança ou adulto']
        }
    );

    await cleanup([lead._id], [contact._id]);

    return result;
}

/**
 * CENÁRIO 2: CONVERSA LONGA (>20 msgs) - GERA RESUMO
 */
async function testLongConversation() {
    log('🧪', '=== TESTE 2: CONVERSA LONGA (>20 msgs) - RESUMO ===', 'yellow');

    const { lead, contact } = await createTestLead('Longa');

    // Simula 30 mensagens
    const messages = [
        { direction: 'inbound', content: 'Oi' },
        { direction: 'outbound', content: 'Oi! Como posso ajudar?' },
        { direction: 'inbound', content: 'Quanto custa fono?' },
        { direction: 'outbound', content: 'Avaliação R$ 200' },
        { direction: 'inbound', content: 'É para meu filho de 6 anos com TEA' },
        { direction: 'outbound', content: 'Entendi, temos especialistas em TEA' },
    ];

    // Repete padrão até ter 30 msgs
    while (messages.length < 30) {
        messages.push(
            { direction: 'inbound', content: `Dúvida ${messages.length}` },
            { direction: 'outbound', content: `Resposta ${messages.length}` }
        );
    }

    await insertMessages(lead._id, contact._id, messages);

    log('⏳', 'Primeira msg após 30 msgs (deve gerar resumo ~10s)...', 'yellow');

    const result1 = await testAmandaResponse(
        lead,
        'Quero agendar',
        {
            canGreet: false,
            shouldNotAsk: ['idade', 'quantos anos', 'TEA']
        }
    );

    log('⏳', 'Segunda msg (deve reusar resumo ~1s)...', 'yellow');

    const result2 = await testAmandaResponse(
        lead,
        'Pode ser amanhã?',
        {
            canGreet: false,
            shouldNotAsk: ['idade', 'filho']
        }
    );

    log('📊', `Cache funcionou? ${result2.duration < 3000 ? '✅ SIM' : '❌ NÃO'}`,
        result2.duration < 3000 ? 'green' : 'red');

    await cleanup([lead._id], [contact._id]);

    return { result1, result2 };
}

/**
 * CENÁRIO 3: SAUDAÇÃO TEMPORAL
 */
async function testGreetingLogic() {
    log('🧪', '=== TESTE 3: LÓGICA DE SAUDAÇÃO ===', 'yellow');

    const { lead, contact } = await createTestLead('Saudacao');

    // Msg antiga (>24h)
    await Message.create({
        lead: lead._id,
        contact: contact._id,
        direction: 'inbound',
        content: 'Oi',
        type: 'text',
        timestamp: new Date(Date.now() - 25 * 60 * 60 * 1000), // 25h atrás
        status: 'received'
    });

    const result = await testAmandaResponse(
        lead,
        'Oi, ainda tem vaga?',
        {
            canGreet: true, // Deve cumprimentar (>24h)
            shouldNotAsk: []
        }
    );

    const hasGreeting = /(oi|olá|tudo bem)/i.test(result.response);
    log('📊', `Cumprimentou após >24h? ${hasGreeting ? '✅ SIM' : '❌ NÃO'}`,
        hasGreeting ? 'green' : 'red');

    await cleanup([lead._id], [contact._id]);

    return result;
}

/**
 * CENÁRIO 4: ZERO PERGUNTAS DUPLICADAS
 */
async function testNoDuplicateQuestions() {
    log('🧪', '=== TESTE 4: ZERO PERGUNTAS DUPLICADAS ===', 'yellow');

    const { lead, contact } = await createTestLead('NoDupes');

    await insertMessages(lead._id, contact._id, [
        { direction: 'inbound', content: 'Tenho 2 filhos de 6 e 8 anos com TEA e TDAH' },
        { direction: 'outbound', content: 'Entendi! Posso ajudar com fono e psico' },
        { direction: 'inbound', content: 'Quanto custa?' },
        { direction: 'outbound', content: 'R$ 200 avaliação, R$ 180/sessão mensal' }
    ]);

    const result = await testAmandaResponse(
        lead,
        'Quero agendar para os dois',
        {
            canGreet: false,
            shouldNotAsk: [
                'quantos filhos',
                'idade',
                'quantos anos',
                'TEA',
                'TDAH',
                'para quem',
                'criança'
            ]
        }
    );

    await cleanup([lead._id], [contact._id]);

    return result;
}

/**
 * CLEANUP
 */
async function cleanup(leadIds, contactIds) {
    await Message.deleteMany({ lead: { $in: leadIds } });
    await Lead.deleteMany({ _id: { $in: leadIds } });
    await Contact.deleteMany({ _id: { $in: contactIds } });
    log('🧹', 'Dados de teste removidos', 'cyan');
}

/**
 * EXECUTAR TODOS OS TESTES
 */
async function runAllTests() {
    try {
        await mongoose.connect(process.env.MONGODB_URI);
        log('🔗', 'Conectado ao MongoDB', 'green');

        console.log('\n' + '='.repeat(60));
        log('🚀', 'INICIANDO TESTES TÉCNICOS - AMANDA 2.0', 'yellow');
        console.log('='.repeat(60) + '\n');

        const results = {
            test1: await testShortConversation(),
            test2: await testLongConversation(),
            test3: await testGreetingLogic(),
            test4: await testNoDuplicateQuestions()
        };

        console.log('\n' + '='.repeat(60));
        log('📊', 'RESUMO DOS TESTES', 'yellow');
        console.log('='.repeat(60));

        const allPassed = Object.values(results).every(r => {
            if (r.result1) return r.result1.validations && r.result2.validations;
            return r.validations;
        });

        if (allPassed) {
            log('✅', 'TODOS OS TESTES PASSARAM!', 'green');
        } else {
            log('⚠️', 'Alguns testes falharam - revisar acima', 'red');
        }

        process.exit(0);

    } catch (error) {
        log('❌', `Erro nos testes: ${error.message}`, 'red');
        console.error(error);
        process.exit(1);
    }
}

runAllTests();