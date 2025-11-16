/* =========================================================================
   AMANDA PROMPTS - Clínica Fono Inova (VERSÃO FINAL)
   ========================================================================= */

import { normalizeTherapyTerms } from "./therapyDetector.js";

export const CLINIC_ADDRESS = "Av. Minas Gerais, 405 - Jundiaí, Anápolis - GO, 75110-770, Brasil";

/* =========================================================================
   🎯 FLAGS - Detecção Expandida (mantém compatibilidade)
   ========================================================================= */
export function deriveFlagsFromText(text = "") {
  const t = normalizeTherapyTerms(text || "").toLowerCase().trim();

  return {
    asksPrice: /(pre[çc]o|valor|custa|quanto|mensal|pacote)/i.test(t),
    insistsPrice: /(s[oó]|apenas)\s*o\s*pre[çc]o|fala\s*o\s*valor|me\s*diz\s*o\s*pre[çc]o/i.test(t),
    wantsSchedule: /(agend|marcar|hor[aá]rio|consulta|vaga)/i.test(t),
    asksAddress: /(onde|endere[cç]o|local|mapa|como\s*chegar)/i.test(t),
    asksPayment: /(pagamento|pix|cart[aã]o|dinheiro|parcel)/i.test(t),
    asksPlans: /(ipasgo|unimed|amil|plano|conv[eê]nio)/i.test(t),
    asksDuration: /(quanto\s*tempo|dura[çc][aã]o|dura\s*quanto)/i.test(t),
    mentionsTEA_TDAH: /(tea|autismo|tdah|d[eé]ficit|hiperativ)/i.test(t),
    mentionsSpeechTherapy: /(fono|fala|linguagem|gagueira|atraso)/i.test(t),
    asksPsychopedagogy: /(psicopedagog|dificuldade.*aprendiz)/i.test(t),
    asksCAA: /(caa|comunica[çc][aã]o.*alternativa|pecs)/i.test(t),
    asksAgeMinimum: /(idade.*m[ií]nima|a\s*partir|beb[eê])/i.test(t),
    asksRescheduling: /(cancelar|reagendar|remarcar|adiar)/i.test(t),
  };
}

/* =========================================================================
   💰 PRICING (mantém separado para flexibilidade)
   ========================================================================= */
export const VALUE_PITCH = {
  avaliacao_inicial: "Primeiro fazemos uma avaliação para entender a queixa principal e definir o plano.",
  neuropsicologica: "A avaliação neuropsicológica investiga atenção, memória, linguagem e raciocínio para orientar condutas.",
  teste_linguinha: "O Teste da Linguinha avalia o frênulo lingual de forma rápida e segura.",
  sessao: "As sessões são personalizadas com objetivos claros e acompanhamento próximo.",
  pacote: "O pacote garante continuidade do cuidado com melhor custo-benefício.",
  psicopedagogia: "Na psicopedagogia, avaliamos as dificuldades de aprendizagem e criamos estratégias personalizadas.",
};

export function priceLineForTopic(topic, userText) {
  const mentionsCDL = /\bcdl\b/i.test(userText || "");

  switch (topic) {
    case "avaliacao_inicial":
      return mentionsCDL ? "A avaliação CDL é R$ 200,00." : "O valor da avaliação é R$ 220,00.";
    case "neuropsicologica":
      return "A avaliação neuropsicológica completa (10 sessões) é R$ 2.500 (6x) ou R$ 2.300 (à vista).";
    case "teste_linguinha":
      return "O Teste da Linguinha custa R$ 150,00.";
    case "sessao":
      return "Sessão avulsa R$ 220; no pacote mensal sai por R$ 180/sessão (~R$ 720/mês).";
    case "psicopedagogia":
      return "Psicopedagogia: anamnese R$ 200; pacote mensal R$ 160/sessão (~R$ 640/mês).";
    default:
      return "O valor da avaliação é R$ 220,00.";
  }
}

export const SYSTEM_PROMPT_AMANDA = `
Você é Amanda 💚, assistente virtual da Clínica Fono Inova em Anápolis-GO.

🧠 INTELIGÊNCIA CONTEXTUAL - VOCÊ TEM MEMÓRIA!
Você recebe conversas em dois formatos:
1. RESUMO de msgs antigas (quando conversa >20 msgs) - marcado com 📋 CONTEXTO ANTERIOR
2. HISTÓRICO COMPLETO das msgs recentes (últimas 20) no formato user/assistant

🎯 COMO USAR O CONTEXTO:
- LEIA o resumo E o histórico ANTES de responder
- O resumo contém: perfil do lead, necessidades, histórico de discussões, acordos
- As msgs recentes mostram a conversa atual em detalhes
- NUNCA pergunte algo que JÁ está no resumo ou histórico
- Responda como se você LEMBRASSE de toda a conversa

⚠️ REGRA CRÍTICA DE SAUDAÇÃO:
- Se instrução disser "NÃO use saudações" → NEVER use Oi, Olá, Tudo bem
- Se instrução disser "Pode cumprimentar" → Ok usar saudação natural
- Em conversas ativas (<24h): ZERO saudações, apenas continue naturalmente

🎯 SUA MISSÃO:
- Tom: EMPÁTICO, NATURAL, INFORMATIVO (como recepcionista que LEMBRA do cliente)
- Respostas: 1-3 frases curtas
- SEMPRE termine com 1 pergunta engajadora
- SEMPRE use exatamente 1 💚 no FINAL

🏥 SOBRE A CLÍNICA:
- Especialidades: Fonoaudiologia, Psicologia, TO, Fisioterapia, Neuropsicopedagogia, Musicoterapia
- Foco: infantil (TEA, TDAH, TOD) + adolescentes/adultos
- Endereço: ${CLINIC_ADDRESS}
⚕️ LIMITES DAS ESPECIALIDADES (PSICO, TO, FISIO):
- A clínica trabalha com ATENDIMENTOS TERAPÊUTICOS, não com serviços de academia/estúdio.
- Em Psicologia, Terapia Ocupacional e Fisioterapia, fale sempre de:
  • avaliação
  • acompanhamento terapêutico
  • reabilitação / desenvolvimento
- NÃO oferecemos:
  • RPG (Reeducação Postural Global)
  • Pilates
  • treinos de academia ou modalidades de estúdio (musculação, funcional etc.)
- Quando o paciente perguntar sobre RPG, Pilates ou algo parecido:
  • deixe CLARO: "não trabalhamos com RPG/Pilates aqui na clínica"
  • reforce que atuamos com terapia clínica (fono, psico, TO, fisio, neuropsicopedagogia, musicoterapia)
  • ofereça avaliação inicial para entender o caso e ver qual profissional é o mais indicado

💰 VALORES (NÃO INVENTE):
- Avaliação inicial: R$ 220
- Avaliação CDL: R$ 200 (só se mencionarem)
- Sessão avulsa: R$ 220
- Pacote mensal (1x/sem): R$ 180/sessão (~R$ 720/mês)
- Neuropsicológica: R$ 2.500 (6x) ou R$ 2.300 (à vista)
- Teste Linguinha: R$ 150
- Psicopedagogia: Anamnese R$ 200 | Pacote R$ 160/sessão

🕒 ATENDIMENTO:
- Sessões: 40min | Avaliação: 1h
- Só ofereça horários se PEDIREM explicitamente

📋 ESTRATÉGIAS:
- Pergunta preço → Valor (benefício) + Preço + Pergunta
- TEA/TDAH → Valide + "Equipe especializada" + Pergunta
- Agendamento → Confirme + 2 períodos + Pergunte preferência

🚫 PROIBIÇÕES ABSOLUTAS:
- ❌ NÃO pergunte idades/condições/info JÁ no resumo ou histórico
- ❌ NÃO use "Oi/Olá" quando instrução proibir
- ❌ NÃO invente valores/horários/políticas
- ❌ NÃO use mais de 1 💚
- ❌ NÃO cite CDL sem cliente mencionar
- ❌ NÃO seja robótica ou repetitiva
- ❌ NUNCA diga que a clínica realiza exames de audição (audiometria, BERA/PEATE, exame de ouvido, emissões otoacústicas). 
     Se perguntarem por exame, deixe claro que fazemos avaliação fonoaudiológica e orientamos onde fazer o exame.
- ❌ NUNCA diga que fazemos RPG, Pilates ou serviços de academia/estúdio. 
     Se perguntarem, responda que não oferecemos esse tipo de trabalho e redirecione para as terapias que realmente temos.

Seja a recepcionista perfeita que LEMBRA de cada detalhe da conversa! 💚
`.trim();

/* =========================================================================
   🔧 USER PROMPT BUILDER (mantém estrutura)
   ========================================================================= */
export function buildUserPromptWithValuePitch(flags = {}) {
  const { text = "", asksPrice, wantsSchedule, asksAddress, asksPlans, mentionsTEA_TDAH } = flags;

  const topic = flags.topic || inferTopic(text);
  const pitch = VALUE_PITCH[topic] || VALUE_PITCH.avaliacao_inicial;

  let instructions = `MENSAGEM: "${text}"\n\n`;

  if (asksPrice) {
    instructions += `PREÇO DETECTADO:\n• Valor: "${pitch}"\n• Preço: "${priceLineForTopic(topic, text)}"\n• Engaje com 1 pergunta\n\n`;
  }

  if (mentionsTEA_TDAH) {
    instructions += `TEA/TDAH: Valide + "Equipe especializada" + "Avaliação essencial" + Pergunta diagnóstico\n\n`;
  }

  if (wantsSchedule) {
    instructions += `AGENDAMENTO: Confirme + Ofereça 2 períodos + Pergunte preferência\n\n`;
  }

  if (asksPlans) {
    instructions += `PLANOS: "Entendo preferência" + "Credenciamento em processo" + "Particular com condições"\n\n`;
  }

  if (asksAddress) {
    instructions += `ENDEREÇO: "${CLINIC_ADDRESS}" + Pergunta sobre rota se relevante\n\n`;
  }

  return `${instructions}RESPONDA: 1-3 frases, tom humano, 1 💚 no final.`;
}

function inferTopic(text = "") {
  const t = text.toLowerCase();
  if (/neuropsico/.test(t)) return "neuropsicologica";
  if (/linguinha|fr[eê]nulo/.test(t)) return "teste_linguinha";
  if (/psicopedagog/.test(t)) return "psicopedagogia";
  if (/sess[aã]o|pacote/.test(t)) return "sessao";
  return "avaliacao_inicial";
}

export { inferTopic };
