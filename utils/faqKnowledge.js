// utils/faqKnowledge.js - NOVO ARQUIVO
export const FAQ_DATABASE = {
    // 🎯 CATEGORIA: PROCEDIMENTOS
    procedures: {
        "como_funciona_avaliacao_neuropsico": {
            question: "Como funciona a avaliação neuropsicológica?",
            answer: `A avaliação neuropsicológica é feita em 10 sessões de 50 minutos cada, realizadas 1x por semana. 

        Etapas:
        1️⃣ Entrevista inicial com responsáveis (anamnese)
        2️⃣ Aplicação de testes específicos com a criança (6-8 sessões)
        3️⃣ Correção e análise dos resultados
        4️⃣ Entrega do laudo completo + devolutiva

        O laudo é detalhado e serve para:
        ✅ Diagnóstico de TDAH, TEA, dificuldades de aprendizagem
        ✅ Laudos para escola, INSS, processos judiciais
        ✅ Orientação para família e professores

        Valor: R$ 2.000 em 6x no cartão.`,
            keywords: ["neuropsico", "como funciona", "etapas", "laudo"],
            relatedQuestions: ["quanto_tempo_neuropsico", "idade_minima_neuropsico"]
        },

        "quanto_tempo_neuropsico": {
            question: "Quanto tempo demora a avaliação neuropsicológica?",
            answer: "São 10 sessões de 50min, realizadas 1x por semana. No total, dura cerca de 2 meses e meio. Após a última sessão, entregamos o laudo em até 15 dias úteis 💚",
            keywords: ["neuropsico", "quanto tempo", "duração", "prazo"],
            relatedQuestions: ["como_funciona_avaliacao_neuropsico"]
        },

        "idade_minima_neuropsico": {
            question: "Qual a idade mínima para avaliação neuropsicológica?",
            answer: "A partir de 4 anos completos. Para crianças menores, recomendamos avaliação com neuropediatra ou fono/TO para estimulação precoce 💚",
            keywords: ["neuropsico", "idade", "quantos anos", "criança"],
            relatedQuestions: ["como_funciona_avaliacao_neuropsico"]
        }
    },

    // 🎯 CATEGORIA: CONVÊNIOS
    health_plans: {
        "aceita_unimed": {
            question: "Aceita Unimed?",
            answer: "Estamos em processo de credenciamento com Unimed, IPASGO e Amil. Previsão de conclusão: dezembro/2025. No momento atendemos particular, mas emitimos nota fiscal para você solicitar reembolso junto ao seu plano 💚",
            keywords: ["unimed", "convenio", "plano"],
            relatedQuestions: ["nota_fiscal_reembolso"]
        },

        "nota_fiscal_reembolso": {
            question: "Emite nota fiscal para reembolso?",
            answer: "Sim! Emitimos nota fiscal de todas as consultas e sessões. Você pode usar para solicitar reembolso junto ao seu plano de saúde. Basta pedir para a recepcionista após o atendimento 💚",
            keywords: ["nota fiscal", "reembolso", "plano"],
            relatedQuestions: ["aceita_unimed"]
        }
    },

    // 🎯 CATEGORIA: LOGÍSTICA
    logistics: {
        "como_chegar": {
            question: "Como chego na clínica?",
            answer: `Estamos na Av. Minas Gerais, 405 - Bairro Jundiaí, Anápolis-GO.

        📍 Referência: Em frente ao SESI
        🗺️ Link do Google Maps: [enviar quando disponível]

        Vindo do centro: pegar Av. Brasil até Av. Minas Gerais 💚`,
            keywords: ["endereço", "como chegar", "localização", "maps"],
        }
    },

    // 🎯 CATEGORIA: PAGAMENTO
    payment: {
        "formas_pagamento": {
            question: "Quais as formas de pagamento?",
            answer: `Aceitamos:
💳 Cartão de crédito (até 6x sem juros)
💳 Cartão de débito
💰 PIX
💵 Dinheiro

Para pacotes mensais, também temos condições especiais 💚`,
            keywords: ["pagamento", "cartão", "pix", "dinheiro", "parcelar"],
            relatedQuestions: ["valor_pacote_mensal"]
        },

        "valor_pacote_mensal": {
            question: "Qual o valor do pacote mensal?",
            answer: "O pacote mensal (4 sessões de 40min) sai por R$ 640. Isso dá R$ 160 por sessão, ao invés de R$ 160 avulsa. Você economiza R$ 160 por mês! 💚",
            keywords: ["pacote", "mensal", "sessão", "desconto"],
            relatedQuestions: ["formas_pagamento"]
        }
    },
    // 🎯 CATEGORIA: TERAPIAS
    therapies: {
        "o_que_e_terapia_ocupacional": {
            question: "O que é Terapia Ocupacional?",
            answer: `A Terapia Ocupacional (TO) trabalha a autonomia e independência nas atividades do dia a dia.

            Para crianças, ajuda com:
            ✅ Coordenação motora fina (escrever, recortar, amarrar)
            ✅ Integração sensorial (hipersensibilidade a sons, texturas)
            ✅ Autorregulação (controle de impulsos, rotina)
            ✅ AVDs (vestir, comer, escovar dentes)

            A avaliação inicial custa R$ 200 e dura cerca de 50 minutos 💚`,
            keywords: ["terapia ocupacional", "to", "o que é", "como funciona", "coordenação", "sensorial"],
        },

        "diferenca_fono_psicopedagogo": {
            question: "Qual a diferença entre Fono e Psicopedagogo?",
            answer: `**Fonoaudiologia** trabalha fala, linguagem, audição e deglutição.
            Indicada para: atraso de fala, gagueira, dificuldade de pronunciar sons.

            **Psicopedagogia** (aqui chamamos Neuropsicopedagogia) trabalha aprendizagem.
            Indicada para: dificuldade escolar, baixo rendimento, organização de estudos.

            Na dúvida, a avaliação inicial (R$ 200) ajuda a direcionar certinho 💚`,
            keywords: ["diferença", "fono", "psicopedagogo", "psicopedagogia", "qual"],
        },
    },

    // 🎯 CATEGORIA: ATENDIMENTO
    attendance: {
        "atende_adulto": {
            question: "Atende adulto?",
            answer: `Sim! Atendemos todas as idades.

            Para adultos, oferecemos:
            ✅ Fonoaudiologia (voz, fala, deglutição)
            ✅ Psicologia (ansiedade, depressão, autoconhecimento)
            ✅ Fisioterapia (dor, postura, reabilitação)

            Valor da avaliação: R$ 200 💚`,
            keywords: ["adulto", "adultos", "maior de 18", "para mim", "atende"],
        },

        "atende_bebe": {
            question: "Atende bebê?",
            answer: `Atendemos a partir de recém-nascidos!

            Para bebês, oferecemos:
            ✅ Teste da Linguinha (R$ 150)
            ✅ Fisioterapia pediátrica (cólica, torcicolo, atraso motor)
            ✅ Avaliação do desenvolvimento

            O primeiro passo é sempre uma avaliação (R$ 200) pra entender o caso 💚`,
            keywords: ["bebê", "bebe", "recém nascido", "nenem", "meses"],
        },

        "sabado_domingo": {
            question: "Atende sábado e domingo?",
            answer: "Atendemos de segunda a sexta, das 8h às 18h. Aos sábados, apenas em casos especiais com agendamento prévio. Domingos e feriados não funcionamos 💚",
            keywords: ["sábado", "sabado", "domingo", "fim de semana", "feriado"],
        },
    },

    // 🎯 CATEGORIA: CANCELAMENTO/REMARCAÇÃO
    scheduling: {
        "como_cancelar": {
            question: "Como cancelo minha consulta?",
            answer: `Para cancelar ou remarcar, basta me avisar aqui pelo WhatsApp com pelo menos **24 horas de antecedência**.

            Se precisar cancelar em cima da hora, o valor da sessão pode ser cobrado.

            Quer remarcar pra outro dia? Me fala se prefere manhã ou tarde 💚`,
            keywords: ["cancelar", "desmarcar", "remarcar", "adiar", "não vou poder"],
        },
    },
};

// ✅ BUSCA INTELIGENTE NO FAQ
export function searchFAQ(query, minKeywords = 1) {
    const queryLower = query.toLowerCase();
    const results = [];

    for (const [category, faqs] of Object.entries(FAQ_DATABASE)) {
        // faqs é um OBJETO, não array!
        for (const [faqId, faq] of Object.entries(faqs)) {
            const matchedKeywords = faq.keywords.filter(kw =>
                queryLower.includes(kw.toLowerCase())
            );

            if (matchedKeywords.length >= minKeywords) {
                results.push({
                    id: faqId,
                    ...faq,
                    category,
                    matchedKeywords,
                    confidence: matchedKeywords.length / faq.keywords.length
                });
            }
        }
    }

    // Retorna o com maior confiança
    return results.sort((a, b) => b.confidence - a.confidence)[0] || null;
}

