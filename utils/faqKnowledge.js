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

Valor: R$ 2.500 em 6x no cartão ou R$ 2.300 à vista.`,
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
        "estacionamento": {
            question: "Tem estacionamento?",
            answer: "Sim! Temos estacionamento gratuito na frente da clínica. É bem fácil de estacionar e tem bastante vaga 💚",
            keywords: ["estacionamento", "estacionar", "vaga"],
            relatedQuestions: ["como_chegar"]
        },

        "como_chegar": {
            question: "Como chego na clínica?",
            answer: `Estamos na Av. Minas Gerais, 405 - Jundiaí, Anápolis-GO.

📍 Referência: Em frente ao SESI
🚗 Estacionamento gratuito na frente
🗺️ Link do Google Maps: [enviar quando disponível]

Vindo do centro: pegar Av. Brasil até Av. Minas Gerais 💚`,
            keywords: ["endereço", "como chegar", "localização", "maps"],
            relatedQuestions: ["estacionamento"]
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
            answer: "O pacote mensal (4 sessões de 40min) sai por R$ 720. Isso dá R$ 180 por sessão, ao invés de R$ 220 avulsa. Você economiza R$ 160 por mês! 💚",
            keywords: ["pacote", "mensal", "sessão", "desconto"],
            relatedQuestions: ["formas_pagamento"]
        }
    }
};

// ✅ BUSCA INTELIGENTE NO FAQ
export function searchFAQ(userQuestion) {
    const normalized = userQuestion.toLowerCase();
    let bestMatch = null;
    let bestScore = 0;

    for (const category of Object.values(FAQ_DATABASE)) {
        for (const [id, faq] of Object.entries(category)) {
            let score = 0;

            // Conta quantas keywords aparecem na pergunta
            faq.keywords.forEach(keyword => {
                if (normalized.includes(keyword.toLowerCase())) {
                    score += 1;
                }
            });

            if (score > bestScore) {
                bestScore = score;
                bestMatch = { id, ...faq };
            }
        }
    }

    // Só retorna se tiver pelo menos 2 keywords
    return bestScore >= 2 ? bestMatch : null;
}