/**
 * 📚 CLINIC WISDOM — Base de Conhecimento Real da Clínica Fono Inova
 * 
 * Regras de negócio EXATAS extraídas de 75K+ linhas de conversas reais.
 * A Amanda CONSULTA esse arquivo para saber O QUE responder.
 * O TOM (acolhedor) vem do amandaPrompt.js — aqui são dados frios.
 * 
 * USO: getWisdomForContext(topic, flags) → bloco de texto pro prompt
 */

import { THERAPY_PRICING, formatPrice, getTherapyPricing } from '../config/pricing.js';

// ================================================================
// 👅 TESTE DA LINGUINHA (separado de Fono)
// ================================================================

const TESTE_LINGUINHA_WISDOM = {
    teste: {
        regra: 'Teste da Linguinha: R$200 (avaliação fonoaudiológica específica)',
        script: 'Realizamos o Teste da Linguinha, que é uma avaliação fonoaudiológica específica para verificar a necessidade de intervenção. O valor é R$200.',
        detalhes: 'O teste da linguinha é um exame simples e indolor para avaliar se o bebê tem anquiloglossia (língua presa). Observamos a pega do bebê ao mamar, a sucção (se ele consegue sugar de forma eficiente), o jeito de abocanhar a mama e se há dificuldade que atrapalhe a amamentação.'
    },
    cirurgia: {
        regra: 'NÃO realizamos cirurgia (frenectomia/pique). Apenas reabilitação pós.',
        script: 'Nós não realizamos a cirurgia (frenectomia/pique da língua). Aqui na clínica fazemos apenas o Teste da Linguinha (avaliação) e a fonoterapia para reabilitação após a cirurgia (caso você faça o procedimento em outro local).',
        acolhimento: 'Entendo a preocupação. O ideal é realizar o teste primeiro para confirmar a necessidade, ou se já tiver indicação, buscar um odontopediatra para o procedimento e depois voltar conosco para a reabilitação.',
    }
};

// ================================================================
// 📋 REGRAS DE PREÇO (extraídas das conversas reais)
// ================================================================

const PRICE_WISDOM = {
    // Como a clínica apresenta preços (padrão real)
    avaliacao: {
        regra: 'Avaliação inicial: R$200 (valor promocional, normalmente R$250)',
        anchorDesconto: true,
        valorDe: 250,
        valorPor: 200,
        script: 'A primeira consulta é uma avaliação inicial que de R$250,00 está por R$200,00',
        oQueInclui: 'A avaliação consiste em uma anamnese completa, onde realizamos uma entrevista detalhada para conhecer o histórico do paciente, suas queixas, dificuldades e rotina. Esse processo é fundamental para compreendermos melhor as necessidades e traçarmos o plano de tratamento mais adequado.',
        acolhimentoAntes: 'Antes de falar preço, contextualize o VALOR do trabalho. Fale o que a avaliação inclui e como vai ajudar a família.',
    },

    pacoteMensal: {
        regra: 'Pacote mensal (1x/semana): R$640/mês = R$160/sessão',
        script: 'Se você paga o mês fechado, por exemplo 1 sessão por semana, fica no valor de R$640,00 por mês, que sai R$160,00 cada sessão.',
    },

    sessaoAvulsa: {
        regra: 'Sessão avulsa: R$180/sessão (pode variar: R$170-R$190 conforme área)',
        script: 'Sessão avulsa: toda vez que vier para a sessão você paga R$180,00 cada sessão.',
    },

    neuropsicologia: {
        regra: 'Avaliação neuropsicológica completa: R$2.000 em até 6x sem juros. ~10 sessões + laudo.',
        laudoIncluso: true,
        parcelamento: '6x sem juros',
        script: 'A avaliação neuropsicológica completa é R$2.000 — pode parcelar em até 6x sem juros. Já inclui tudo: as sessões, os testes e o laudo completo.',
        detalhes: 'O neuropsicólogo observa o comportamento, aplica testes cognitivos e produz um laudo que serve para escola, médicos e planejamento terapêutico.',
    },

    // Estratégia de objeção de preço (padrão real)
    objecaoPreco: {
        regra: 'Quando lead acha caro: mencionar promoção, pacote mais em conta, valor do trabalho',
        scripts: [
            'Esse valor continua com a condição especial que estamos mantendo. É uma ótima oportunidade de começar.',
            'Trabalhamos com pacotes que acabam se tornando mais em conta — cada sessão sai por R$160 no pacote mensal.',
            'Muitas famílias começam com a avaliação avulsa (R$200) e depois optam pelo pacote, que tem o melhor custo-benefício.',
        ],
        acolhimento: 'Entendo que investimento em saúde pesa no orçamento. Mas quando a gente vê a criança evoluindo, cada centavo faz sentido.',
    },
};

// ================================================================
// 🏥 REGRAS DE CONVÊNIO (extraídas das conversas reais)
// ================================================================

const CONVENIO_WISDOM = {
    geral: {
        regra: 'Clínica está em processo de credenciamento. Atende PARTICULAR com opção de reembolso.',
        script: 'Ainda estamos em processo de credenciamento com os planos de saúde. No momento atendemos de forma particular, com opção de reembolso.',
        bridge: 'Muitas famílias fazem particular e solicitam o reembolso pelo plano. A gente fornece toda a documentação necessária.',
    },

    ipasgo: {
        regra: 'IPASGO: documentação já foi enviada para credenciamento',
        script: 'Pelo IPASGO já encaminhamos todas as documentações para o credenciamento. Estamos aguardando o retorno deles.',
    },

    unimed: {
        regra: 'UNIMED: emite nota fiscal para reembolso',
        script: 'Com a Unimed emitimos nota fiscal para você solicitar o reembolso. Muitas famílias fazem assim e funciona super bem.',
    },

    bradesco: {
        regra: 'BRADESCO: reembolso via nota fiscal',
        script: 'Com o Bradesco, emitimos nota fiscal certinha para você solicitar o reembolso pelo app do plano.',
    },

    particular: {
        regra: 'Quando lead pergunta se atende plano: bridge para particular + gostaria de conhecer valores?',
        script: 'No momento estamos somente particular. Gostaria de conhecer nossos valores?',
        bridgeCompleto: 'No momento atendemos somente de forma particular ou com opção de reembolso. Gostaria que eu te enviasse os valores do nosso atendimento para você conhecer melhor?',
    },
};

// ================================================================
// 📝 FICHA DE CADASTRO (template real extraído)
// ================================================================

const FICHA_CADASTRO_WISDOM = {
    regra: 'Quando lead quer agendar, enviar ficha de pré-cadastro para coletar dados',
    template: `Por gentileza, preencha essa pré-ficha de cadastro para podermos agendar!

📋 *Avaliação*

*Ficha de cadastro do paciente*
• Nome da criança:
• Data de nascimento:
• Nome do responsável:
• Principal queixa do paciente:

Valor da avaliação: R$200,00`,

    acolhimento: 'Que bom que quer dar esse passo! Vou precisar só de algumas informações para agendar:',
    posAgendamento: 'Seu agendamento foi realizado com sucesso. Agradecemos pela confiança em nosso trabalho e ficamos à disposição caso precise de algo antes da avaliação.',
    lembrete: 'Caso haja desistência ou imprevisto, por favor nos avisar com antecedência.',
};

// ================================================================
// ⏰ HORÁRIOS (extraídos das conversas reais)
// ================================================================

const HORARIOS_WISDOM = {
    padrao: {
        regra: 'Seg-Sex, 8h-18h',
        script: 'Nosso horário padrão é de segunda a sexta, das 8h às 18h.',
    },
    especial: {
        regra: 'Após 18h: segunda e quarta-feira (neuropsico)',
        script: 'Temos horários após as 18h na segunda e na quarta-feira — perfeito pra quem trabalha durante o dia.',
    },
};

// ================================================================
// 🎯 TERAPIAS — Dados + como apresentar (extraído das conversas)
// ================================================================

const THERAPY_WISDOM = {
    fonoaudiologia: {
        queixasComuns: ['não fala', 'atraso de fala', 'gagueira', 'troca letras', 'linguinha', 'frenulo'],
        comoApresentar: 'Na fonoaudiologia, trabalhamos o desenvolvimento da comunicação de forma lúdica e natural. Cada sessão é planejada especificamente para as necessidades da criança.',
        avaliacaoInclui: 'avaliação funcional da fala, linguagem e motricidade oral',
    },
    psicologia: {
        queixasComuns: ['comportamento', 'ansiedade', 'birra', 'agressividade', 'emocional', 'medo'],
        comoApresentar: 'Na psicologia, criamos um espaço seguro onde a criança pode explorar emoções e comportamentos. O trabalho é totalmente individualizado.',
        avaliacaoInclui: 'entrevista com responsáveis e observação clínica',
    },
    terapia_ocupacional: {
        queixasComuns: ['coordenação motora', 'sensorial', 'integração sensorial', 'autonomia', 'escrita'],
        comoApresentar: 'Na terapia ocupacional, focamos nas habilidades do dia a dia — desde a coordenação motora até a autonomia. É um trabalho prático e divertido.',
        avaliacaoInclui: 'avaliação de processamento sensorial e habilidades motoras',
    },
    fisioterapia: {
        queixasComuns: ['motor', 'postura', 'reabilitação', 'bobath', 'dor'],
        comoApresentar: 'Na fisioterapia infantil, trabalhamos o desenvolvimento motor com exercícios que parecem brincadeira. Cada sessão é adaptada à idade.',
        avaliacaoInclui: 'avaliação do desenvolvimento neuropsicomotor',
    },
    musicoterapia: {
        queixasComuns: ['socialização', 'interação', 'estímulo', 'autismo', 'musical'],
        comoApresentar: 'A musicoterapia usa a música como ferramenta terapêutica — é um trabalho incrível para socialização, comunicação e regulação emocional.',
        avaliacaoInclui: 'avaliação musicoterapêutica e observação da interação',
    },
    psicopedagogia: {
        queixasComuns: ['aprendizagem', 'escola', 'leitura', 'escrita', 'dislexia', 'rendimento escolar'],
        comoApresentar: 'Na psicopedagogia, identificamos como a criança aprende melhor e trabalhamos estratégias para superar as dificuldades escolares.',
        avaliacaoInclui: 'avaliação dos processos de aprendizagem',
    },
    neuropsicologia: {
        queixasComuns: ['laudo', 'TEA', 'TDAH', 'cognitivo', 'atenção', 'neuropediatra pediu'],
        comoApresentar: 'A avaliação neuropsicológica é um processo completo que mapeia todas as funções cognitivas. O laudo serve para escola, médicos e planejamento terapêutico.',
        avaliacaoInclui: 'bateria de testes cognitivos + laudo completo',
    },
};

// ================================================================
// 🚨 CANCELAMENTOS E REMARCAÇÕES (Dados reais de 2026)
// ================================================================

const CANCELLATION_WISDOM = {
    familiar: {
        regra: 'Cancelamentos por problemas familiares são os mais comuns (9 casos + 13 remarcações no export 2026)',
        exemplos: [
            'minha esposa tá passando mal',
            'imprevisto familiar',
            'infelizmente terei q cancelar'
        ],
        script: 'Entendo totalmente! Situações assim acontecem mesmo. A saúde da família vem sempre em primeiro lugar. Quer remarcar para quando vocês conseguirem ou prefere que eu entre em contato mais pra frente? 💚',
        acolhimento: 'NUNCA fazer o cliente se sentir culpado. Empatia primeiro, solução depois.',
    },
    esposo: {
        regra: 'Quando OUTRA pessoa desmarca (esposo/marido)',
        exemplo: 'Meu esposo acabou de desmarcar a sessão do Igor',
        script: 'Sem problema! Recebemos o cancelamento. Assim que vocês quiserem remarcar, é só me chamar que a gente ajeita um novo horário pra vocês, ok? 💚'
    },
    semMotivo: {
        regra: 'Cancelamento genérico sem explicação',
        script: 'Tudo bem! Entendo que imprevistos acontecem. Se quiser remarcar, estou à disposição. Qualquer coisa é só me chamar 💚'
    },
    reagendar: {
        regra: '13 casos de remarcação no export 2026 - Lead QUER continuar',
        script: 'Claro! Vou verificar os horários disponíveis. Prefere manhã ou tarde? E qual semana funciona melhor pra vocês?',
        oportunidade: 'Remarcação é sinal POSITIVO - lead não desistiu. Priorize!'
    }
};

// ================================================================
// ⚡ URGÊNCIA (98 casos no export 2026!)
// ================================================================

const URGENCY_WISDOM = {
    regra: '98 casos de urgência detectados - "urgente", "logo", "rápido", "hoje"',
    prioridade: 'ALTA - Resposta rápida é crítica',
    palavras: ['urgente', 'urgencia', 'logo', 'rápido', 'hoje', 'amanhã', 'essa semana'],
    script: 'Entendo a urgência! Vou verificar agora mesmo a disponibilidade mais próxima. Me dá só um minutinho? 💚',
    estrategia: [
        'Mostrar que entendeu a urgência',
        'Agir rápido (não deixar esperando)',
        'Oferecer o slot MAIS PRÓXIMO disponível',
        'Se não tiver vaga próxima: oferecer lista de espera'
    ]
};

// ================================================================
// 💚 ACOLHIMENTO — Regras de tom (pais de TEA/TDAH)
// ================================================================

const ACOLHIMENTO_RULES = {
    regra: 'Muitos pais chegam PREOCUPADOS com filhos com TEA/TDAH. Valide a emoção ANTES de dar informação.',
    principios: [
        'NUNCA mande tabela de preços seca. Contextualize o valor do trabalho primeiro.',
        'Se o pai/mãe expressa preocupação → acolha ANTES de perguntar dados.',
        'Use nome da criança quando souber. Faz diferença.',
        'Não diga "Disponha" — diga "Estou aqui pra qualquer dúvida 💚"',
        'TEA/TDAH: valide que buscar ajuda é um grande passo. Não minimize.',
    ],
    exemplosAcolhimento: [
        'Entendo a preocupação... É um passo muito importante que vocês estão dando.',
        'Sinto muito que estejam passando por essa fase difícil... Mas buscar ajuda já é um grande sinal de cuidado.',
        'Faz todo sentido a preocupação. Vamos juntos encontrar o melhor caminho.',
    ],
    teaTdah: {
        regra: 'PROTOCOL TEA: 6 meses de intervenção -> Relatório Terapêutico -> Neuropediatra (Laudo). Terapeutas NÃO dão diagnóstico antes disso.',
        script: 'Sobre o diagnóstico: A criança passa por um período de intervenção de 6 meses. A terapeuta avalia e faz um relatório completo para a família levar ao neuropediatra. O laudo médico é somente com o neuropediatra ou com avaliação neuropsicológica. Nós terapeutas não fechamos diagnóstico antes desse acompanhamento.',
    },
};

// ================================================================
// 🎯 FUNÇÃO PRINCIPAL — Consulta contextual
// ================================================================

/**
 * Retorna bloco de sabedoria para injetar no prompt do Claude.
 * Chamado pelo AmandaOrchestrator antes de montar o prompt.
 * 
 * @param {string} topic - 'fono', 'psicologia', etc. (do resolveTopicFromFlags)
 * @param {Object} flags - Flags detectadas (do detectAllFlags)
 * @returns {Object} { wisdomBlock: string, wisdom: Object }
 */
export function getWisdomForContext(topic, flags = {}) {
    const blocks = [];
    let wisdom = null; // Para context.wisdom do amandaPrompt.js

    // ── PREÇO ──────────────────────────────────────────────
    if (flags.asksPrice || flags.insistsPrice) {
        const area = topic || 'fonoaudiologia';
        const pricing = getTherapyPricing(area);

        if (area === 'neuropsicologia' || area === 'neuropsico') {
            blocks.push(`💰 REGRA DE PREÇO (NEUROPSICOLÓGICA):
- ${PRICE_WISDOM.neuropsicologia.regra}
- ${PRICE_WISDOM.neuropsicologia.detalhes}
- Parcelamento: ${PRICE_WISDOM.neuropsicologia.parcelamento}
- ⚠️ SEMPRE mencione que o laudo está incluso
- ⚠️ Acolha antes: "${PRICE_WISDOM.avaliacao.acolhimentoAntes}"`);

            wisdom = {
                tipo: 'price',
                valorAtual: 'R$2.000 (6x sem juros)',
                estrategia: { anchor: false, packageFirst: false, laudoIncluso: true },
                template: PRICE_WISDOM.neuropsicologia.script,
                respostaExemplo: PRICE_WISDOM.neuropsicologia.script,
            };
        } else {
            blocks.push(`💰 REGRA DE PREÇO (${(area || 'geral').toUpperCase()}):
- Avaliação: De R$250 por R$200 (USE esse anchor de desconto!)
- Pacote mensal (1x/semana): R$640/mês = R$160/sessão
- Sessão avulsa: R$180/sessão
- O que a avaliação inclui: "${PRICE_WISDOM.avaliacao.oQueInclui}"
- ⚠️ NUNCA mande preço seco. Diga o que INCLUI e o VALOR primeiro.
- ⚠️ Use o anchor de desconto: "de R$250 está por R$200"` +
                (pricing ? `\n- Pacote desta área: ${formatPrice(pricing.pacoteMensal)}/mês (${formatPrice(pricing.sessaoPacote)}/sessão)` : ''));

            wisdom = {
                tipo: 'price',
                valorAtual: `Avaliação R$200 (de R$250). Pacote R$${pricing?.pacoteMensal || 640}/mês`,
                estrategia: { anchor: true, valorDe: 250, valorPor: 200, packageFirst: false },
                template: PRICE_WISDOM.avaliacao.script,
                respostaExemplo: `${PRICE_WISDOM.avaliacao.script}\n\n${PRICE_WISDOM.pacoteMensal.script}\n\n${PRICE_WISDOM.sessaoAvulsa.script}`,
            };
        }
    }

    // ── OBJEÇÃO DE PREÇO ──────────────────────────────────
    if (flags.mentionsPriceObjection) {
        const scripts = PRICE_WISDOM.objecaoPreco.scripts;
        const scriptIdx = Math.floor(Math.random() * scripts.length);
        blocks.push(`💰 OBJEÇÃO DE PREÇO DETECTADA:
- ${PRICE_WISDOM.objecaoPreco.regra}
- Acolhimento: "${PRICE_WISDOM.objecaoPreco.acolhimento}"
- Script sugerido: "${scripts[scriptIdx]}"
- ⚠️ NÃO diga "é barato". Foque no VALOR do trabalho.`);
    }

    // ── CONVÊNIO / PLANO ──────────────────────────────────
    if (flags.asksPlans) {
        const normalized = (flags.normalizedText || '').toLowerCase();
        let convenioBlock = `🏥 REGRA DE CONVÊNIO:
- ${CONVENIO_WISDOM.geral.regra}
- Bridge: "${CONVENIO_WISDOM.geral.bridge}"`;

        if (/ipasgo/i.test(normalized)) {
            convenioBlock += `\n- IPASGO: "${CONVENIO_WISDOM.ipasgo.script}"`;
        } else if (/unimed/i.test(normalized)) {
            convenioBlock += `\n- UNIMED: "${CONVENIO_WISDOM.unimed.script}"`;
        } else if (/bradesco/i.test(normalized)) {
            convenioBlock += `\n- BRADESCO: "${CONVENIO_WISDOM.bradesco.script}"`;
        }

        convenioBlock += `\n- ⚠️ SEMPRE faça bridge para particular + valores: "${CONVENIO_WISDOM.particular.bridgeCompleto}"`;
        blocks.push(convenioBlock);

        if (!wisdom) {
            wisdom = {
                tipo: 'convenio',
                respostaExemplo: CONVENIO_WISDOM.particular.bridgeCompleto,
            };
        }
    }

    // ── NOTA FISCAL (Fluxo de Coleta) ─────────────────────
    if (flags.wantsInvoice) {
        blocks.push(`🧾 NOTA FISCAL SOLICITADA:
- A clínica emite nota fiscal para reembolso.
- Para emitir, PRECISAMOS DOS DADOS:
  1. Nome Completo do Responsável (CPF na nota)
  2. CPF
  3. Endereço Completo (Rua, Bairro, CEP, Cidade)
  4. Nome do Paciente
- Script: "Claro! Para emitir a nota fiscal, preciso que você me envie: Nome completo do responsável (CPF na nota), o número do CPF e o Endereço completo. Assim que me passar, já encaminho para o financeiro."`);
    }

    // ── REEMBOLSO (Dúvida Geral) ──────────────────────────
    if (flags.mentionsReembolso) {
        blocks.push(`📋 REEMBOLSO:
- A clínica fornece nota fiscal para reembolso de QUALQUER plano
- Unimed: "${CONVENIO_WISDOM.unimed.script}"
- Bradesco: "${CONVENIO_WISDOM.bradesco.script}"
- Bridge: "${CONVENIO_WISDOM.geral.bridge}"`);
    }

    // ── AGENDAMENTO / FICHA ───────────────────────────────
    if (flags.wantsSchedule && !flags.alreadyScheduled) {
        blocks.push(`📅 FLUXO DE AGENDAMENTO:
- Acolher: "${FICHA_CADASTRO_WISDOM.acolhimento}"
- Coletar: nome da criança + data de nascimento + principal queixa
- Valor da avaliação: R$200
- Após confirmar: "${FICHA_CADASTRO_WISDOM.posAgendamento}"
- Pedir para avisar em caso de imprevisto`);
    }

    // ── HORÁRIO ESPECIAL ──────────────────────────────────
    if (flags.asksAboutAfterHours) {
        blocks.push(`⏰ HORÁRIO ESPECIAL:
- ${HORARIOS_WISDOM.especial.script}
- Horário padrão: ${HORARIOS_WISDOM.padrao.script}`);
    }

    // ── TERAPIA ESPECÍFICA ────────────────────────────────
    if (topic && THERAPY_WISDOM[topic]) {
        const t = THERAPY_WISDOM[topic];
        blocks.push(`🎯 TERAPIA: ${topic.toUpperCase()}
- ${t.comoApresentar}
- Avaliação inclui: ${t.avaliacaoInclui}
- Queixas comuns: ${t.queixasComuns.join(', ')}`);
    }

    // ── TEA / TDAH ────────────────────────────────────────
    if (flags.mentionsTEA_TDAH) {
        blocks.push(`🧩 TEA/TDAH DETECTADO:
- ${ACOLHIMENTO_RULES.teaTdah.regra}
- Acolhimento: "${ACOLHIMENTO_RULES.teaTdah.script}"
- ⚠️ Valide que buscar ajuda é um GRANDE PASSO. Não minimize.`);
    }

    // ── ACOLHIMENTO GERAL (se detecta queixa emocional) ──
    if (flags.mentionsChild && !flags.asksPrice && !flags.wantsSchedule) {
        const exemplo = ACOLHIMENTO_RULES.exemplosAcolhimento[
            Math.floor(Math.random() * ACOLHIMENTO_RULES.exemplosAcolhimento.length)
        ];
        blocks.push(`💚 REGRA DE ACOLHIMENTO:
- "${exemplo}"
- ${ACOLHIMENTO_RULES.principios[0]}
- ${ACOLHIMENTO_RULES.principios[1]}`);
    }

    // ── 🚨 AMBIGUIDADE: PSICOLOGIA vs NEUROPSICOLOGIA 🚨 ──
    // Se pede "psicologia" mas cita sintomas de TEA/TDAH, investigação ou "saber se tem" OU pede explicitamente "avaliação" (termo confuso)
    if (topic === 'psicologia' && (flags.mentionsTEA_TDAH || flags.mentionsInvestigation || flags.mentionsDoubtTEA || flags.talksAboutTypeOfAssessment)) {
        blocks.push(`🤔 AMBIGUIDADE DETECTADA (VISÃO CLÍNICA):
- O lead pediu "Psicologia" ou "Avaliação", mas pode estar buscando DIAGNÓSTICO (Neuropsicologia).
- Mães muitas vezes confundem "Avaliação Psicológica" (terapia) com "Avaliação Neuropsicológica" (bateria de testes).
- 🛑 NÃO dê o preço de R$200 direto. Explique a diferença PRIMEIRO.
- SCRIPT OBRIGATÓRIO: "Para eu te passar as informações certinhas: você busca a **Psicoterapia** (acompanhamento semanal para questões emocionais/comportamentais) ou a **Avaliação Neuropsicológica** (bateria de testes para investigar TEA/TDAH e fechar diagnóstico)?"`);
    }

    // ── LOCALIZAÇÃO ───────────────────────────────────────
    if (flags.asksAddress || flags.asksLocation) {
        blocks.push(`📍 LOCALIZAÇÃO:
- Endereço: Av. Minas Gerais, 405 - Jundiaí, Anápolis - GO
- ⚠️ O orchestrator JÁ envia pin de localização automaticamente`);
    }



    // ── TESTE DA LINGUINHA / CIRURGIA ─────────────────────
    if (flags.mentionsTongueTieSurgery || (topic === 'teste_linguinha' && flags.mentionsGeneralSurgery)) {
        blocks.push(`🚫 CIRURGIA DE LINGUINHA (FRENECTOMIA):
- A clínica NÃO realiza a cirurgia (pique/frenectomia).
- Realizamos apenas o TESTE DA LINGUINHA e a fonoterapia pós-cirúrgica (reabilitação).
- Script OBRIGATÓRIO: "${TESTE_LINGUINHA_WISDOM.cirurgia.script}"
- Acolhimento: "${TESTE_LINGUINHA_WISDOM.cirurgia.acolhimento}"`);
    } else if (topic === 'teste_linguinha') {
        blocks.push(`👅 TESTE DA LINGUINHA:
- O teste é realizado pela fonoaudióloga.
- Valor: R$200 (avaliação inicial).
- Script DE RESPOSTA OBRIGATÓRIO (Adapte com o nome da criança se souber): "${TESTE_LINGUINHA_WISDOM.teste.detalhes}"
- Se já fez cirurgia: "A fonoaudiologia é essencial para reabilitar a função da língua após o procedimento."`);
    }

    // ── 🚨 CANCELAMENTO (Dados reais 2026) ────────────────
    if (flags.wantsCancellation || flags.mentionsCancellation) {
        blocks.push(`🚨 CANCELAMENTO DETECTADO (${CANCELLATION_WISDOM.familiar.regra.split(' - ')[0]}):
- ${CANCELLATION_WISDOM.familiar.acolhimento}
- Script RECOMENDADO: "${CANCELLATION_WISDOM.familiar.script}"
- ⚠️ NUNCA fazer o cliente se sentir culpado
- 💡 Se mencionar REMARCAR: "${CANCELLATION_WISDOM.reagendar.script}"
- Insight: ${CANCELLATION_WISDOM.reagendar.oportunidade}`);
    }

    // ── ⚡ URGÊNCIA (98 casos no export 2026!) ────────────
    if (flags.mentionsUrgency || flags.expressedUrgency) {
        blocks.push(`⚡ URGÊNCIA DETECTADA (${URGENCY_WISDOM.regra}):
- ${URGENCY_WISDOM.prioridade}
- Script: "${URGENCY_WISDOM.script}"
- Estratégia:
  ${URGENCY_WISDOM.estrategia.map(e => `• ${e}`).join('\n  ')}
- ⚠️ Responda RÁPIDO - não deixe esperando!`);
    }

    // Monta bloco final
    const wisdomBlock = blocks.length > 0
        ? blocks.join('\n\n')
        : '';

    return { wisdomBlock, wisdom };
}

// ================================================================
// 📦 EXPORTS
// ================================================================

export {
    PRICE_WISDOM,
    CONVENIO_WISDOM,
    FICHA_CADASTRO_WISDOM,
    HORARIOS_WISDOM,
    THERAPY_WISDOM,
    ACOLHIMENTO_RULES,
    TESTE_LINGUINHA_WISDOM,
    CANCELLATION_WISDOM,  // 🆕 Export 2026
    URGENCY_WISDOM,       // 🆕 Export 2026
};

export default {
    getWisdomForContext,
    PRICE_WISDOM,
    CONVENIO_WISDOM,
    FICHA_CADASTRO_WISDOM,
    HORARIOS_WISDOM,
    THERAPY_WISDOM,
    ACOLHIMENTO_RULES,
    TESTE_LINGUINHA_WISDOM,
    CANCELLATION_WISDOM,  // 🆕 Export 2026
    URGENCY_WISDOM,       // 🆕 Export 2026
};
