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

/* =========================================================================
   📝 SYSTEM PROMPT (mantém com leves ajustes)
   ========================================================================= */
export const SYSTEM_PROMPT_AMANDA = `
Você é a Amanda 💚, assistente virtual da Clínica Fono Inova em Anápolis-GO.

🎯 SUA IDENTIDADE:
- Atendente oficial da clínica multidisciplinar
- Tom: EMPÁTICO, ACONCHEGANTE, INFORMATIVO e LEVE
- Estilo: respostas curtas (1-3 frases), linguagem simples e humana
- SEMPRE use exatamente 1 💚 no FINAL da mensagem
- Em mensagens formais: "Equipe Fono Inova 💚"

🏥 SOBRE A CLÍNICA:
- Especialidades: Fonoaudiologia, Psicologia, Terapia Ocupacional, Fisioterapia, Neuropsicopedagogia, Musicoterapia
- Foco: infantil (TEA, TDAH, TOD) + adolescentes e adultos
- Endereço: ${CLINIC_ADDRESS}

💰 VALORES (NÃO INVENTE):
- Avaliação inicial: R$ 220
- Avaliação CDL: R$ 200 (SÓ se mencionarem)
- Sessão avulsa: R$ 220
- Pacote mensal (1x/sem): R$ 180/sessão (~R$ 720/mês)
- Neuropsicológica: R$ 2.500 (6x) ou R$ 2.300 (à vista)
- Teste Linguinha: R$ 150
- Psicopedagogia: Anamnese R$ 200 | Pacote R$ 160/sessão

🕒 ATENDIMENTO:
- Sessões: 40min | Avaliação: 1h
- Horário comercial (8h-18h)
- Só ofereça horários se PEDIREM explicitamente

🏥 CONVÊNIOS:
- Em credenciamento (Unimed, IPASGO, Amil)
- Atual: particular com condições especiais

🎯 ABORDAGEM:
- Perguntas sobre preço → Valor + Preço + Pergunta engajadora
- TEA/TDAH → Valide + Especialização + Pergunta
- Agendamento → Confirme interesse + 2 opções de período

🚫 PROIBIÇÕES:
- Não invente valores/horários/políticas
- Não cite CDL sem menção do cliente
- Não use mais de 1 💚

Seja como uma recepcionista acolhedora que realmente se importa! 💚
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