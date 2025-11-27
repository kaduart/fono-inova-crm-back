/* =========================================================================
   AMANDA INTENTS - Sistema de Fallback Local (VERSÃO FINAL)
   Clínica Fono Inova - Anápolis/GO
   ========================================================================= */

/* =========================================================================
   📖 MANUAL_AMANDA - Respostas Canônicas Expandidas
   ========================================================================= */
export const MANUAL_AMANDA = {
    "saudacao": "Olá! 😊 Sou a Amanda, da Clínica Fono Inova. Como posso ajudar você hoje? 💚",

    "localizacao": {
        "endereco": "Ficamos na Av. Minas Gerais, 405 - Jundiaí, Anápolis-GO!💚",
        "como_chegar": "Estamos em frente ao SESI no Jundiaí! Precisa do link do Google Maps? 💚"
    },

    "valores": {
        "avaliacao": "A avaliação inicial é R$ 220; é o primeiro passo para entender a queixa e traçar o plano ideal. Prefere agendar essa avaliação pra essa semana ou pra próxima? 💚",
        "neuropsico": "Avaliação Neuropsicológica completa (10 sessões): R$ 2.500 em até 6x ou R$ 2.300 à vista 💚",
        "teste_linguinha": "Teste da Linguinha: R$ 150. Avaliamos o frênulo lingual de forma rápida e segura 💚",
        "sessao": "Sessão avulsa R$ 220 | Pacote mensal (1x/semana): R$ 180/sessão (~R$ 720/mês) 💚",
        "psicopedagogia": "Psicopedagogia: Anamnese R$ 200 | Pacote mensal R$ 160/sessão (~R$ 640/mês) 💚"
    },

    "planos_saude": {
        "credenciamento": "Entendo, muita gente prefere usar o plano mesmo. Hoje na Fono Inova todos os atendimentos são particulares, ainda não temos credenciamento com Unimed, IPASGO ou outros convênios. Se isso mudar, posso te avisar por aqui, combinado? 💚"
    },


    "agendamento": {
        "horarios": "Perfeito! 💚 Qual período funciona melhor: manhã ou tarde?",
        "dados": "Vou precisar de: Nome e idade do paciente, nome do responsável e principal queixa 💚"
    },

    "especialidades": {
        "tea_tdah": "Compreendo perfeitamente! 💚 Temos equipe multiprofissional especializada em neurodiversidades. A avaliação inicial é essencial para traçar o plano ideal",
        "fono": "Entendo sua preocupação! 💚 Nossas fonoaudiólogas são especializadas em desenvolvimento da linguagem. A intervenção precoce faz toda diferença",
        "psicologia": "Que bom que pensou em buscar ajuda! 💚 Nossas psicólogas são especializadas em infantil. Vamos agendar uma avaliação?",
        "caa": "Temos fono especializada em CAA! 💚 Trabalhamos com PECS e outros sistemas para comunicação não-verbal"
    },

    "duvidas_frequentes": {
        "duracao": "Cada sessão dura 40 minutos. É um tempo pensado para que a criança participe bem, sem ficar cansada 💚",
        "idade_minima": "Atendemos a partir de 1 ano! 💚 A avaliação neuropsicológica é a partir de 4 anos e adulto",
        "pagamento": "Aceitamos PIX, cartão em até 6x e dinheiro 💚",
        "pedido_medico": "Não precisa de pedido médico para agendar! 💚 A avaliação é o primeiro passo"
    },

    "despedida": "Foi um prazer conversar! Qualquer dúvida, estou à disposição. Tenha um ótimo dia! 💚"
};

/* =========================================================================
   🔍 HELPER - Busca no manual
   ========================================================================= */
export function getManual(cat, sub) {
    if (!cat) return null;
    const node = MANUAL_AMANDA?.[cat];
    if (!node) return null;
    if (sub && typeof node === 'object') return node[sub] ?? null;
    return typeof node === 'string' ? node : null;
}