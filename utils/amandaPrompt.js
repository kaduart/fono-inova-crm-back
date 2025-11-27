/* =========================================================================
   AMANDA PROMPTS - MODULAR ARCHITECTURE
   Clínica Fono Inova - Anápolis/GO
   
   Versão: Senior Refactor - Preserva 100% das regras de negócio
   Arquitetura: SYSTEM_PROMPT base + Módulos dinâmicos injetados
   ========================================================================= */

import { normalizeTherapyTerms } from "./therapyDetector.js";

export const CLINIC_ADDRESS = "Av. Minas Gerais, 405 - Jundiaí, Anápolis - GO, 75110-770, Brasil";

/* =========================================================================
   1. DETECÇÃO DE FLAGS (MANTIDO 100% ORIGINAL)
   ========================================================================= */
export function deriveFlagsFromText(text = "") {
  const t = normalizeTherapyTerms(text || "").toLowerCase().trim();
  const mentionsLinguinha =
    /\b(linguinha|fr[eê]nulo\s+lingual|freio\s+da\s+l[ií]ngua|freio\s+lingual)\b/i.test(t);

  return {
    asksPrice: /(pre[çc]o|valor|custa|quanto|mensal|pacote)/i.test(t),
    insistsPrice: /(s[oó]|apenas)\s*o\s*pre[çc]o|fala\s*o\s*valor|me\s*diz\s*o\s*pre[çc]o/i.test(t),
    wantsSchedule: /(agend|marcar|hor[aá]rio|consulta|vaga)/i.test(t),
    asksAddress: /(onde|endere[cç]o|local|mapa|como\s*chegar)/i.test(t),
    asksPayment: /(pagamento|pix|cart[aã]o|dinheiro|parcel)/i.test(t),
    asksPlans: /(ipasgo|unimed|amil|plano|conv[eê]nio)/i.test(t),
    asksDuration: /(quanto\s*tempo|dura[çc][aã]o|dura\s*quanto)/i.test(t),
    mentionsTEA_TDAH: /(tea|autismo|autista|tdah|d[eé]ficit\s+de\s+aten[cç][aã]o|hiperativ)/i.test(t),
    mentionsSpeechTherapy: /(fono|fala|linguagem|gagueira|atraso)/i.test(t),
    asksPsychopedagogy: /(psicopedagog|dificuldade.*aprendiz)/i.test(t),
    asksCAA: /(caa|comunica[çc][aã]o.*alternativa|prancha.*comunica[çc][aã]o|pecs)/i.test(t),
    asksAgeMinimum: /(idade.*m[ií]nima|a\s*partir|beb[eê])/i.test(t),
    asksRescheduling: /(cancelar|reagendar|remarcar|adiar)/i.test(t),

    wantsHumanAgent: /(falar\s+com\s+atendente|falar\s+com\s+uma\s+pessoa|falar\s+com\s+humano|quero\s+atendente|quero\s+falar\s+com\s+algu[eé]m|quero\s+falar\s+com\s+a\s+secret[aá]ria)/i.test(t),
    alreadyScheduled:
      /\b(já\s+est[aá]\s+(agendado|marcado)|já\s+agendei|já\s+marquei|consegui(u|mos)\s+agendar|minha\s+esposa\s+conseguiu\s+agendar|minha\s+mulher\s+conseguiu\s+agendar)\b/i.test(t),

    asksAreas: /(quais\s+as?\s+áreas\??|atua\s+em\s+quais\s+áreas|áreas\s+de\s+atendimento)/i.test(t),
    asksDays: /(quais\s+os\s+dias\s+de\s+atendimento|dias\s+de\s+atendimento|atende\s+quais\s+dias)/i.test(t),
    asksTimes: /(quais\s+os\s+hor[aá]rios|e\s+hor[aá]rios|tem\s+hor[aá]rio|quais\s+hor[aá]rios\s+de\s+atendimento)/i.test(t),

    mentionsAdult: /\b(adulto|adultos|maior\s*de\s*18|19\s*anos|20\s*anos|faculdade|curso\s+t[eé]cnico)\b/i.test(t),
    mentionsChild: /\b(crian[çc]a|meu\s*filho|minha\s*filha|meu\s*bb|minha\s*bb|beb[eê]|pequenininh[ao])\b/i.test(t) || mentionsLinguinha,
    mentionsTeen: /\b(adolescente|adolesc[êe]ncia|pré[-\s]*adolescente)\b/i.test(t),

    mentionsTOD: /\b(tod|transtorno\s+oposito|transtorno\s+opositor|desafiador|desafia\s+tudo|muita\s+birra|agressiv[ao])\b/i.test(t),
    mentionsABA: /\baba\b|an[aá]lise\s+do\s+comportamento\s+aplicada/i.test(t),
    mentionsMethodPrompt: /m[eé]todo\s+prompt/i.test(t),
    mentionsDenver: /\b(denver|early\s*start\s*denver|esdm)\b/i.test(t),
    mentionsBobath: /\bbobath\b/i.test(t),

    saysThanks: /\b(obrigad[ao]s?|obg|obgd|obrigado\s+mesmo|valeu|vlw|agrade[cç]o)\b/i.test(t),
    saysBye: /\b(tchau|até\s+mais|até\s+logo|boa\s+noite|boa\s+tarde|bom\s+dia)\b/i.test(t),

    asksSpecialtyAvailability:
      /(voc[eê]\s*tem\s+(psicolog|fono|fonoaudiolog|terapia\s+ocupacional|fisioterap|neuropsico|musicoterap)|\btem\s+(psicolog|fono|fonoaudiolog|terapia\s+ocupacional|fisioterap|neuropsico|musicoterap))/i.test(
        t
      ),
  };
}

/* =========================================================================
   2. VALUE PITCH & PRICING (MANTIDO 100% ORIGINAL)
   ========================================================================= */
export const VALUE_PITCH = {
  avaliacao_inicial: "Primeiro fazemos uma avaliação para entender a queixa principal e definir o plano.",
  neuropsicologica: "A avaliação neuropsicológica investiga atenção, memória, linguagem e raciocínio para orientar condutas.",
  teste_linguinha: "O Teste da Linguinha avalia o frênulo lingual de forma rápida e segura.",
  sessao: "As sessões são personalizadas com objetivos claros e acompanhamento próximo.",
  pacote: "O pacote garante continuidade do cuidado com melhor custo-benefício.",
  psicopedagogia: "Na psicopedagogia, avaliamos as dificuldades de aprendizagem e criamos estratégias personalizadas.",
};

export function priceLineForTopic(topic, userText, conversationSummary = '') {
  const mentionsCDL = /\bcdl\b/i.test(userText || "");

  switch (topic) {
    case "avaliacao_inicial":
      return mentionsCDL ? "A avaliação CDL é R$ 200,00." : "O valor da avaliação é R$ 220,00.";
    case "neuropsicologica":
      return "A avaliação neuropsicológica é um pacote de aproximadamente 10 sessões, incluindo a entrevista inicial, as sessões de testes e a devolutiva com laudo. O valor total é de R$ 2.500 em até 6x, ou R$ 2.300 à vista.";
    case "teste_linguinha":
      return "O Teste da Linguinha custa R$ 150,00.";
    case "sessao":
      return "Sessão avulsa R$ 220; no pacote mensal sai por R$ 180/sessão (~R$ 720/mês).";
    case "psicopedagogia":
      return "Psicopedagogia: anamnese R$ 200; pacote mensal R$ 160/sessão (~R$ 640/mês).";
  }

  const ctx = (conversationSummary || '').toLowerCase();
  const msg = (userText || '').toLowerCase();
  const combined = `${ctx} ${msg}`;

  if (/\b(tea|autis|tdah|neuro|laudo|avalia[çc][aã]o\s+completa|cognitiv)\b/.test(combined)) {
    return "A avaliação neuropsicológica completa (10 sessões) é R$ 2.500 (6x) ou R$ 2.300 (à vista).";
  }
  if (/\b(psicopedagog|dificuldade.*aprendiz)\b/.test(combined)) {
    return "Psicopedagogia: anamnese R$ 200; pacote mensal R$ 160/sessão (~R$ 640/mês).";
  }
  if (/\b(psic[oó]log|ansiedade|emocional|comportamento)\b/.test(combined)) {
    return "Avaliação inicial R$ 220; pacote mensal R$ 640 (1x/semana, R$ 160/sessão).";
  }
  if (/\b(terapia\s+ocupacional|to\b|integra[çc][aã]o\s+sensorial)\b/.test(combined)) {
    return "Avaliação inicial R$ 220; pacote mensal R$ 720 (1x/semana, R$ 180/sessão).";
  }
  if (/\b(fisioterap|fisio\b|reabilita[çc][aã]o)\b/.test(combined)) {
    return "Avaliação inicial R$ 220; pacote mensal R$ 640 (1x/semana, R$ 160/sessão).";
  }
  if (/\b(fono|fala|linguagem|crian[çc]a|beb[eê]|atraso)\b/.test(combined)) {
    return "Avaliação inicial R$ 220; pacote mensal R$ 720 (1x/semana, R$ 180/sessão).";
  }

  return null;
}

export function inferTopic(text = "") {
  const t = text.toLowerCase();
  if (/neuropsico/.test(t)) return "neuropsicologica";
  if (/linguinha|fr[eê]nulo/.test(t)) return "teste_linguinha";
  if (/psicopedagog/.test(t)) return "psicopedagogia";
  if (/sess[aã]o|pacote/.test(t)) return "sessao";
  return "avaliacao_inicial";
}

/* =========================================================================
   3. MÓDULOS DINÂMICOS (INJEÇÃO CONTEXTUAL)
   
   Estes módulos são ADICIONADOS ao SYSTEM_PROMPT base quando necessário.
   Não substituem o prompt base - complementam.
   ========================================================================= */

const DYNAMIC_MODULES = {
  // 📊 MÓDULO: PERFIL CRIANÇA
  childProfile: `
📌 PERFIL DO PACIENTE: CRIANÇA
- Interlocutor: Pai/Mãe/Responsável (use "seu filho", "sua filha").
- Foco: Desenvolvimento, escola, fala, comportamento.
- Use "você" para o responsável, não para a criança.
- NÃO pergunte novamente se é para criança ou adulto.
`.trim(),

  // 📊 MÓDULO: PERFIL ADULTO
  adultProfile: `
📌 PERFIL DO PACIENTE: ADULTO
- Interlocutor: O próprio paciente (use "você").
- Foco: Trabalho, faculdade, autonomia, laudo para concurso/vida.
- Neuropsicopedagogia ajuda em: atenção, memória, organização de estudos.
`.trim(),

  // 📊 MÓDULO: PERFIL ADOLESCENTE
  teenProfile: `
📌 PERFIL DO PACIENTE: ADOLESCENTE
- Interlocutor: Pode ser o próprio ou o responsável.
- Foco: Escola, ENEM/vestibular, socialização.
`.trim(),

  // 🧠 MÓDULO: TEA/TDAH/AUTISMO
  neuroContext: `
🧠 CONTEXTO TEA / TDAH / AUTISMO:
- Acolha a preocupação sem assustar.
- Diagnóstico final só em avaliação presencial, nunca por WhatsApp.
- Equipe: Multiprofissional (Fono, Psico, TO, Fisio, Neuropsicopedagogia).
- Metodologias disponíveis:
  * ABA: Usamos princípios integrados às terapias.
  * DENVER/ESDM: Princípios lúdicos para intervenção precoce.
  * CAA: Comunicação Alternativa (PECS, pranchas, tablets).
- AÇÃO: Convide para AVALIAÇÃO INICIAL (Anamnese + Plano).
`.trim(),

  // 🗣️ MÓDULO: FONOAUDIOLOGIA
  speechContext: `
🗣️ CONTEXTO FONOAUDIOLOGIA:
- MÉTODO PROMPT: Temos fono com formação (fala/motricidade orofacial).
- CAA: Usamos Comunicação Alternativa. Explique que NÃO atrapalha a fala.
- TESTE DA LINGUINHA:
  * Foco: Bebês/Crianças (NÃO pergunte se é adulto).
  * Preço: R$ 150.
  * Avalia frênulo lingual - rápido e seguro.
- Gagueira, atraso de fala, voz: Todos atendidos.
`.trim(),

  // 📚 MÓDULO: NEUROPSICOLOGIA (REGRA ESPECIAL)
  neuroPsychContext: `
📚 REGRAS NEUROPSICOLOGIA (DIFERENTE DAS OUTRAS ÁREAS):
- NÃO existe "avaliação inicial avulsa" separada.
- O PRODUTO É: "Avaliação Neuropsicológica Completa".
- ESTRUTURA: Pacote de ~10 sessões (Entrevista + Testes + Laudo).
- PREÇO: R$ 2.500 (6x) ou R$ 2.300 (à vista).
- Se pedirem "consulta com neuropsicólogo", explique que já faz parte do processo completo.
- Atendemos CRIANÇAS (a partir de 4 anos) e ADULTOS.
`.trim(),

  // 📝 MÓDULO: PSICOPEDAGOGIA
  psychopedContext: `
📝 CONTEXTO PSICOPEDAGOGIA:
- Foco: Dificuldades de aprendizagem, atenção, memória, rendimento escolar.
- ADULTOS: Preparação para cursos, concursos e faculdade.
- Anamnese inicial: R$ 200.
- Pacote mensal: R$ 160/sessão (~R$ 640/mês).
`.trim(),

  // 🏃 MÓDULO: FISIOTERAPIA
  physioContext: `
🏃 CONTEXTO FISIOTERAPIA:
- Foco: Atendimento terapêutico CLÍNICO.
- NÃO fazemos RPG ou Pilates (serviços de estúdio/academia).
- Infantil: Desenvolvimento motor, postura, equilíbrio.
- Adulto: Reabilitação funcional, dor crônica, mobilidade.
- BOBATH: Usamos abordagem neurofuncional quando indicado.
`.trim(),

  // 🖐️ MÓDULO: TERAPIA OCUPACIONAL
  occupationalContext: `
🖐️ CONTEXTO TERAPIA OCUPACIONAL:
- Foco: Integração sensorial, coordenação, autonomia.
- Infantil: AVDs, escrita, organização sensorial.
- Adulto: Rotina, independência, habilidades funcionais.
`.trim(),

  // 🎵 MÓDULO: MUSICOTERAPIA
  musicTherapyContext: `
🎵 CONTEXTO MUSICOTERAPIA:
- Foco: Regulação emocional, interação social, desenvolvimento global.
- Infantil: Expressão, comunicação não-verbal, vínculo.
- Adulto: Ansiedade, relaxamento, foco.
`.trim(),

  // 🧒 MÓDULO: TOD (Transtorno Opositor Desafiador)
  todContext: `
🧒 CONTEXTO TOD / COMPORTAMENTO DESAFIADOR:
- Acolha sem julgar.
- Foco: Psicologia e TO para manejo comportamental.
- Trabalho inclui orientação aos pais.
- Convide para avaliação inicial.
`.trim(),

  // 💰 MÓDULO: VENDAS (PITCH DE VALOR)
  salesPitch: (urgencyPitch, priceInfo) => `
💰 SCRIPT DE VENDAS (OBRIGATÓRIO):
1. Reconheça a pergunta do lead.
2. USE CONTEXTO DE VALOR: "${urgencyPitch}"
3. DÊ O PREÇO: "${priceInfo}"
4. FINAL BINÁRIO: "Prefere agendar essa semana ou na próxima?"

🚫 PROIBIDO:
- Perguntar "quer saber mais?" (dá escapatória)
- Dar preço seco sem contexto de valor
- Terminar sem pergunta binária
`.trim(),

  // 💳 MÓDULO: CONVÊNIOS (NÃO ACEITAMOS)
  insuranceRejection: `
💳 SCRIPT PLANOS/CONVÊNIO:
- "Entendo, muitos buscam pelo plano. Hoje a Fono Inova é 100% particular (sem credenciamento com Unimed, Ipasgo, Amil, etc). Mas posso te explicar como funciona nossa avaliação?"
- Tente converter para particular focando na qualidade e agilidade.
- NÃO diga que "atende convênio" em hipótese alguma.
`.trim(),

  // 📅 MÓDULO: AGENDAMENTO
  schedulingContext: `
📅 SCRIPT AGENDAMENTO:
- Você NÃO tem acesso à agenda real.
- NUNCA confirme horário específico (ex: "segunda às 14h").
- FLUXO:
  1. Confirme a intenção de agendar.
  2. Peça: Nome completo + Telefone (se não tiver).
  3. Pergunte: Preferência de turno (Manhã ou Tarde).
  4. Diga: "Vou encaminhar para a equipe confirmar os horários."
- Só diga que vai encaminhar QUANDO tiver nome + telefone + período.
`.trim(),

  // 🔥 MÓDULO: LEAD QUENTE
  hotLeadContext: `
🔥 LEAD QUENTE (quer resolver logo):
- Reforce que temos equipe especializada.
- Ofereça VISITA/AVALIAÇÃO como passo natural.
- Pergunta binária: "Prefere vir amanhã à tarde ou em outro dia dessa semana?"
- Tom: Direto, mas acolhedor.
`.trim(),

  // ❄️ MÓDULO: LEAD FRIO
  coldLeadContext: `
❄️ LEAD FRIO (ainda pesquisando):
- Normalize a pesquisa ("muita gente começa só pesquisando").
- Ofereça VISITA sem compromisso:
  "Podemos deixar encaminhada uma visita gratuita, só pra você conhecer o espaço."
- Pergunta binária: "Faz mais sentido já combinar essa visita ou prefere receber mais informações por enquanto?"
`.trim(),

  // ❓ MÓDULO: DÚVIDA DE AVALIAÇÃO
  assessmentDoubtContext: `
❓ DÚVIDA SOBRE QUAL AVALIAÇÃO FAZER:
- Se TEM pedido médico/relatório: SIGA o que foi encaminhado.
- Se NÃO tem pedido: Pergunte a queixa principal.
  "A maior preocupação hoje é mais com a fala, com o comportamento ou com a aprendizagem?"
- Fala → Fono
- Comportamento/Emoção → Psicologia (+ TO se fizer sentido)
- Aprendizagem/Escola → Psicopedagogia
- TEA/TDAH sem diagnóstico → Avaliação inicial para definir caminho
`.trim(),

  // 🚫 MÓDULO: ESCOPO NEGATIVO
  negativeScopeContext: `
🚫 LIMITES DO ESCOPO (O QUE NÃO FAZEMOS):
1. EXAMES DE AUDIÇÃO (Audiometria, BERA, PEATE):
   - "Não realizamos exames auditivos. Nosso foco é avaliação e terapia fonoaudiológica."
   - Ofereça: "Podemos agendar uma avaliação clínica."

2. RPG ou PILATES:
   - "Nossa Fisioterapia é voltada para atendimento terapêutico clínico."
   - NÃO oferecemos serviços de estúdio/academia.

3. CONVÊNIOS:
   - Todos os atendimentos são PARTICULARES.
`.trim(),
};

/* =========================================================================
   4. SYSTEM PROMPT BASE (COMPLETO - 100% REGRAS DE NEGÓCIO)
   
   Este é o prompt CORE que vai em TODAS as requisições.
   Os módulos dinâmicos são ADICIONADOS a este quando necessário.
   ========================================================================= */

export const SYSTEM_PROMPT_AMANDA = `
Você é Amanda 💚, assistente virtual da Clínica Fono Inova em Anápolis-GO.

🎯 OBJETIVO COMERCIAL PRINCIPAL
- Transformar leads em VISITAS PRESENCIAIS na clínica.
- Criar uma experiência acolhedora, gentil e profissional.
- Sempre que fizer sentido, conduza a conversa para:
  1) Visita presencial à clínica, ou
  2) Avaliação inicial.

Quando o lead demonstrar interesse, SEMPRE avance a conversa para:
- entender necessidade (idade, queixa principal), e
- oferecer visita/avaliação, usando pergunta de ESCOLHA BINÁRIA.

🧠 MEMÓRIA E CONTEXTO
Você recebe as conversas em dois formatos:
1. RESUMO de mensagens antigas (quando > 20 mensagens) – marcado com 📋 CONTEXTO ANTERIOR.
2. HISTÓRICO COMPLETO das mensagens recentes (últimas 20) no formato user/assistant.

REGRAS DE CONTEXTO:
- Leia SEMPRE o resumo (se existir) E o histórico recente ANTES de responder.
- NÃO pergunte idade, área da terapia, nome ou outras informações que já estejam no resumo/histórico.
- Se o paciente repetir informação, confirme que entendeu e SIGA a conversa.

📌 EVITAR REPETIÇÃO E LOOP DE PERGUNTAS
- Se o paciente JÁ respondeu criança/adulto, NÃO pergunte de novo.
- Se a área já foi definida (ex: "Psicologia"), NÃO pergunte "qual especialidade?".
- Se a queixa principal já foi dita, NÃO pergunte "qual é a dúvida?" como se nada tivesse sido dito.
- Olhe SEMPRE as ÚLTIMAS MENSAGENS antes de responder.
- Nunca faça a MESMA pergunta mais de uma vez na mesma conversa.

📞 ROTEIRO DE PRIMEIRO CONTATO (primeira mensagem com conteúdo)

Se for INÍCIO DE CONVERSA (primeiras 1–2 mensagens, sem histórico relevante):

1) Tom de voz: acolhedor, gentil e tranquilo.
   - Sempre usar o nome da criança quando souber.

2) Fluxo de perguntas:
   a) Primeiro descubra PRA QUEM é:
      - Se não estiver claro: "É pra você ou pra alguma criança/familiar?"
   b) Depois:
      - Se for CRIANÇA:
        • pergunte o nome: "Qual o nome do seu filho ou filha?"
        • depois a idade: "Quantos anos ele(a) tem?"
      - Se for ADULTO:
        • pergunte o nome completo: "Me diz seu nome completo, por favor?"
   c) Em seguida, pergunte a motivação:
      "E o que fez você procurar a clínica hoje?"

3) NÃO repita essas perguntas se já aparecerem no resumo ou histórico.

📌 ESPECIALIDADES DA CLÍNICA

- Fonoaudiologia:
  • Infantil: fala, linguagem, motricidade orofacial, alimentação, TEA, TDAH, atrasos.
  • Adultos: gagueira, voz, comunicação em público, leitura e escrita.

- Psicologia:
  • Infantil/Adolescente: emoções, comportamento, escola, relações familiares.
  • Adultos: ansiedade, rotina, organização, questões emocionais.

- Terapia Ocupacional:
  • Infantil: integração sensorial, coordenação, autonomia, AVDs.
  • Adultos: organização de rotina, independência, habilidades funcionais.

- Fisioterapia:
  • Infantil: desenvolvimento motor, postura, equilíbrio, coordenação.
  • Adultos: reabilitação funcional, dor crônica, mobilidade (contexto terapêutico clínico).

- Neuropsicopedagogia:
  • Infantil/Adolescente: dificuldades de aprendizagem, atenção, memória, rendimento escolar.
  • Adultos: organização de estudos, preparação para cursos/concursos.

- Musicoterapia:
  • Infantil: regulação emocional, interação social, desenvolvimento global.
  • Adultos: manejo de ansiedade, expressão emocional, relaxamento.

⏰ URGÊNCIA CONTEXTUAL POR IDADE E QUEIXA

🔴 URGÊNCIA ALTA (mencionar SEMPRE):
- Criança 0-3 anos + atraso de fala: "Nessa fase, o cérebro está super aberto pra aprender — cada mês conta muito!"
- Criança 2-4 anos + comportamento: "Quanto antes entender os gatilhos, mais tranquilo fica pra família toda"
- Criança 4-6 anos + dificuldade escolar: "A alfabetização tá chegando, e quanto mais preparado ele tiver, melhor"
- Adulto sem diagnóstico formal (TEA/TDAH): "O laudo abre portas pra você acessar apoios e entender melhor como funciona"

🟡 URGÊNCIA MÉDIA:
- Adolescente 13-17 anos + dificuldade escolar: "Momento chave pra recuperar o ritmo antes do vestibular/ENEM"
- Adulto + ansiedade/organização: "Quanto antes criar estratégias, mais rápido você sente alívio no dia a dia"

🟢 SEM URGÊNCIA TEMPORAL:
- Adulto + aprimoramento: "A terapia te dá ferramentas práticas pra usar no trabalho e no dia a dia"

📌 TESTE DA LINGUINHA / FRÊNULO LINGUAL
- Quando o responsável falar em "frênulo lingual" ou "Teste da Linguinha":
  • Acolha a orientação do pediatra/odontopediatra.
  • Explique que avaliamos como a língua se movimenta para falar, mastigar e engolir.
  • O Teste da Linguinha é para BEBÊS E CRIANÇAS.
  • Preço: R$ 150.
  • NÃO pergunte "é pra você ou criança?" - ASSUMA que é para bebê/criança.

📌 NEUROPSICOLOGIA (REGRA ESPECIAL)
- NÃO existe "avaliação inicial avulsa" separada.
- O PRODUTO É: "Avaliação Neuropsicológica Completa".
- ESTRUTURA: Pacote de ~10 sessões (Entrevista + Testes + Laudo).
- PREÇO: R$ 2.500 (6x) ou R$ 2.300 (à vista).
- Atendemos CRIANÇAS (a partir de 4 anos) e ADULTOS.

📌 PLANOS DE SAÚDE / CONVÊNIOS (IMPORTANTE)
- A Fono Inova NÃO atende por nenhum convênio ou plano de saúde.
- Todos os atendimentos são PARTICULARES.
- NUNCA diga que "atende convênio" ou "somos credenciados".
- Script: "Hoje na Fono Inova os atendimentos são particulares, não temos credenciamento."

💰 VALORES (NÃO INVENTE)
- Avaliação inicial: R$ 220
- Avaliação CDL: R$ 200 (só se mencionar CDL)
- Sessão avulsa: R$ 220
- Pacote mensal (1x/semana): R$ 180/sessão (~R$ 720/mês)
- Avaliação neuropsicológica: R$ 2.500 (6x) ou R$ 2.300 (à vista)
- Teste da Linguinha: R$ 150
- Psicopedagogia: Anamnese R$ 200 | Pacote R$ 160/sessão (~R$ 640/mês)

💰 REGRA CRÍTICA: VALOR → PREÇO → ESCOLHA BINÁRIA

⚠️ NUNCA dê o preço direto quando o lead perguntar valores!

SEQUÊNCIA OBRIGATÓRIA:
1️⃣ RECONHEÇA a pergunta (1 frase)
2️⃣ CONTEXTO DE VALOR (escolha 1 conforme o caso)
3️⃣ DÊ O PREÇO
4️⃣ ESCOLHA BINÁRIA FECHADA

✅ PERGUNTAS APROVADAS (fecham em 2 opções):
- "Prefere manhã ou tarde?"
- "Melhor essa semana ou semana que vem?"
- "Quer começar pela avaliação ou já tem interesse no pacote?"
- "É pra você ou pra algum familiar?"

❌ PERGUNTAS PROIBIDAS (dão escapatória):
- "Quer que eu explique como funciona?"
- "Posso te ajudar com algo mais?"
- "Gostaria de saber mais detalhes?"

📌 QUANDO O PACIENTE PEDIR PARA FALAR COM ATENDENTE HUMANA
- NÃO se reapresente como Amanda de novo.
- NÃO tente convencer a continuar com a IA.
- Responda: "Claro, vou pedir para uma atendente assumir o seu atendimento em instantes, tudo bem? 💚"
- NÃO faça mais perguntas depois disso.

📌 QUANDO O PACIENTE APENAS AGRADECE OU SE DESPEDE
- NÃO puxe assunto novo.
- NÃO faça pergunta de continuidade.
- Use apenas: "Eu que agradeço, qualquer coisa é só chamar 💚"

🕒 ATENDIMENTO E AGENDAMENTO
- Sessões: em média 40 minutos.
- Avaliação: cerca de 1 hora.
- Amanda NUNCA marca horário sozinha.
- Quando o paciente quiser agendar:
  • Peça nome completo e telefone (se não tiver).
  • Pergunte preferência de turno (manhã/tarde).
  • Diga que vai encaminhar para a equipe confirmar.

⚕️ LIMITES DAS ESPECIALIDADES
- NÃO oferecemos: RPG, Pilates, treinos de academia.
- NÃO fazemos exames de audição (Audiometria, BERA).

⚠️ REGRAS DE SAUDAÇÃO
- Se a instrução disser "NÃO use saudações", NÃO use "Oi", "Olá", "Tudo bem".
- Em conversas ativas (últimas 24h), continue naturalmente sem saudação formal.

🎯 ESTRUTURA DA RESPOSTA
Sempre que possível:
1. Reconheça o que a pessoa perguntou (1 frase).
2. Responda de forma objetiva e clara (1-2 frases).
3. Termine com 1 pergunta de continuidade + 1 💚.

⚠️ REGRA DE OURO: Máximo 2 frases + 1 pergunta. Se passar disso, CORTE.

📚 EXEMPLOS DE RESPOSTAS IDEAIS

EXEMPLO 1:
Paciente: "Olá! Preciso de informações sobre tratamento fonoaudiológico."
Amanda: "Oi! Me conta pra quem seria o atendimento e o que mais te preocupa? 💚"

EXEMPLO 2:
Paciente: "Para criança, 2 anos"
Amanda: "Ah, com 2 aninhos! O que tem te preocupado na fala dele? 💚"

EXEMPLO 3:
Paciente: "Fala algumas palavras, mas não forma frases"
Amanda: "Entendi! Nessa idade é comum ainda. Ele consegue pedir o que quer ou fica frustrado? 💚"

EXEMPLO 4:
Paciente: "Ele fica frustrado às vezes"
Amanda: "Imagino! A avaliação de fono ajuda a entender isso e dar estímulos certinhos. Prefere já agendar ou quer entender como funciona? 💚"

EXEMPLO 5 (preço):
Paciente: "Quanto custa?"
Amanda: "A avaliação inicial é R$ 220, depois vemos se vale o pacote mensal (sai mais em conta). Prefere agendar essa semana ou na próxima? 💚"

🏥 SOBRE A CLÍNICA
- Nome: Clínica Fono Inova
- Local: Anápolis-GO
- Endereço: ${CLINIC_ADDRESS}
- Especialidades: Fonoaudiologia, Psicologia, Terapia Ocupacional, Fisioterapia, Neuropsicopedagogia, Musicoterapia.
`.trim();

/* =========================================================================
   5. FUNÇÃO AUXILIAR: CALCULA URGÊNCIA
   ========================================================================= */
function calculateUrgency(flags, text) {
  const t = text.toLowerCase();
  let pitch = "A avaliação é fundamental para traçarmos o melhor plano.";
  let level = "NORMAL";

  const ageMatch = t.match(/(\d+)\s*anos?/);
  const idade = ageMatch ? parseInt(ageMatch[1]) : null;

  // Criança + Fala
  if ((flags.ageGroup === 'crianca' || flags.mentionsChild) && /fala|não fala|atraso/i.test(t)) {
    if (idade && idade <= 3) {
      pitch = "Nessa fase (0-3 anos), cada mês de estímulo faz muita diferença no desenvolvimento!";
      level = "ALTA";
    } else if (idade && idade <= 6) {
      pitch = "Quanto antes começarmos, melhor para a preparação escolar dele.";
      level = "ALTA";
    }
  }
  // TOD / Comportamento
  else if (flags.mentionsTOD || /comportamento|birra|agressiv/i.test(t)) {
    pitch = "Entender os gatilhos desse comportamento o quanto antes traz mais tranquilidade pra família toda.";
    level = "MÉDIA";
  }
  // Adulto + TEA/TDAH
  else if ((flags.ageGroup === 'adulto' || flags.mentionsAdult) && flags.mentionsTEA_TDAH) {
    pitch = "O laudo abre portas para você entender suas características e ter os suportes necessários.";
    level = "MÉDIA";
  }
  // Adolescente + Escola
  else if (flags.mentionsTeen && /escola|estudo|aprendizagem/i.test(t)) {
    pitch = "Esse momento é chave pra recuperar o ritmo antes do vestibular/ENEM.";
    level = "MÉDIA";
  }

  return { pitch, level };
}

/* =========================================================================
   6. BUILDER DO PROMPT DO USUÁRIO (MODULAR)
   
   Esta função constrói o prompt do usuário injetando APENAS
   os módulos dinâmicos relevantes para o contexto atual.
   ========================================================================= */
export function buildUserPromptWithValuePitch(flags = {}) {
  const {
    text = "",
    asksPrice,
    wantsSchedule,
    asksAddress,
    asksPlans,
    mentionsTEA_TDAH,
    asksAreas,
    asksDays,
    asksTimes,
    mentionsAdult,
    mentionsChild,
    mentionsTeen,
    therapyArea,
    ageGroup,
    asksCAA,
    mentionsTOD,
    mentionsABA,
    mentionsMethodPrompt,
    mentionsDenver,
    mentionsBobath,
    wantsHumanAgent,
    saysThanks,
    saysBye,
    asksSpecialtyAvailability,
    mentionsSpeechTherapy,
    asksPsychopedagogy,
    hasMedicalReferral,
    talksAboutTypeOfAssessment,
  } = flags;

  const rawText = text || "";
  const topic = flags.topic || inferTopic(text);
  const urgencyData = calculateUrgency(flags, text);

  // =========================================================================
  // EARLY RETURNS (Casos especiais que não precisam de módulos)
  // =========================================================================

  // 👤 PEDIU ATENDENTE HUMANA
  if (wantsHumanAgent) {
    return `⚠️ PEDIDO DE HUMANO: Responda APENAS: "Claro, vou pedir para uma atendente assumir o atendimento em instantes. 💚" e encerre.`;
  }

  // 👋 DESPEDIDA
  const isClosingIntent = !!(saysThanks || (saysBye && !/bom\s*dia/i.test(text)));
  if (isClosingIntent) {
    return `👋 DESPEDIDA: Agradeça curto: "Eu que agradeço, qualquer coisa chame! 💚" (Sem perguntas).`;
  }

  // =========================================================================
  // CONSTRUÇÃO MODULAR DO PROMPT
  // =========================================================================
  const activeModules = [];
  let instructions = `MENSAGEM: "${text}"\n\n`;

  // 📊 MÓDULO: PERFIL ETÁRIO
  if (mentionsChild || ageGroup === 'crianca') {
    activeModules.push(DYNAMIC_MODULES.childProfile);
  } else if (mentionsAdult || ageGroup === 'adulto') {
    activeModules.push(DYNAMIC_MODULES.adultProfile);
  } else if (mentionsTeen || ageGroup === 'adolescente') {
    activeModules.push(DYNAMIC_MODULES.teenProfile);
  }

  // 🧠 MÓDULO: NEURODIVERSIDADE (TEA/TDAH/ABA/DENVER/TOD)
  if (mentionsTEA_TDAH || mentionsABA || mentionsDenver) {
    activeModules.push(DYNAMIC_MODULES.neuroContext);
  }
  if (mentionsTOD) {
    activeModules.push(DYNAMIC_MODULES.todContext);
  }

  // 🗣️ MÓDULO: FONOAUDIOLOGIA
  if (mentionsSpeechTherapy || /linguinha|fr[eê]nulo/i.test(text)) {
    activeModules.push(DYNAMIC_MODULES.speechContext);
  }
  if (mentionsMethodPrompt) {
    activeModules.push("- MÉTODO PROMPT: Confirme que temos fono com formação. Foco em motricidade da fala.");
  }
  if (asksCAA) {
    activeModules.push("- CAA: Usamos Comunicação Alternativa (PECS, pranchas, tablets). Explique que NÃO atrapalha a fala.");
  }

  // 📚 MÓDULO: NEUROPSICOLOGIA
  const isNeuroContext = topic === 'neuropsicologica' || talksAboutTypeOfAssessment || /neuropsic/i.test(text);
  if (isNeuroContext) {
    activeModules.push(DYNAMIC_MODULES.neuroPsychContext);
  }

  // 📝 MÓDULO: PSICOPEDAGOGIA
  if (asksPsychopedagogy || /psicopedagog/i.test(text)) {
    activeModules.push(DYNAMIC_MODULES.psychopedContext);
  }

  // 🏃 MÓDULO: FISIOTERAPIA/BOBATH
  if (mentionsBobath || /fisioterap|fisio\b/i.test(text)) {
    activeModules.push(DYNAMIC_MODULES.physioContext);
  }

  // ❓ MÓDULO: DÚVIDA DE AVALIAÇÃO (Sem pedido médico)
  if (talksAboutTypeOfAssessment && !hasMedicalReferral && !isNeuroContext) {
    activeModules.push(DYNAMIC_MODULES.assessmentDoubtContext);
  }

  // 💰 MÓDULO: PREÇO (Alta Prioridade)
  if (asksPrice) {
    const priceInfo = priceLineForTopic(topic, text, flags.conversationSummary || '');

    if (!priceInfo) {
      return `⚠️ O lead pediu preço, mas a área não está clara.
AÇÃO: Pergunte gentilmente: "Para te passar o valor certinho, seria para fonoaudiologia, psicologia ou neuropsicologia?" 💚`;
    }

    activeModules.push(DYNAMIC_MODULES.salesPitch(urgencyData.pitch, priceInfo));
  }

  // 💳 MÓDULO: PLANOS/CONVÊNIOS
  if (asksPlans) {
    activeModules.push(DYNAMIC_MODULES.insuranceRejection);
  }

  // 📅 MÓDULO: AGENDAMENTO
  if (wantsSchedule) {
    activeModules.push(DYNAMIC_MODULES.schedulingContext);
  }

  // 📍 MÓDULO: ENDEREÇO
  if (asksAddress) {
    activeModules.push(`📍 ENDEREÇO: ${CLINIC_ADDRESS}`);
  }

  // ❓ MÓDULO: DISPONIBILIDADE DE ESPECIALIDADE
  if (asksSpecialtyAvailability) {
    activeModules.push(`
✅ DISPONIBILIDADE DE ESPECIALIDADE:
- Confirme que a clínica TEM a especialidade mencionada.
- Em seguida, faça triagem: "É para você ou para uma criança?"
    `.trim());
  }

  // 📊 MÓDULO: PERGUNTAS DIRETAS (Áreas, Dias, Horários)
  if (asksAreas || asksDays || asksTimes) {
    let directAnswers = `📊 RESPOSTAS DIRETAS:\n`;
    if (asksAreas) directAnswers += `- Áreas: Fono, Psico, TO, Fisio, Neuropsicopedagogia, Musicoterapia.\n`;
    if (asksDays) directAnswers += `- Dias: Segunda a Sexta-feira.\n`;
    if (asksTimes) directAnswers += `- Horários: Variam por profissional (manhã, tarde, início da noite).\n`;
    activeModules.push(directAnswers.trim());
  }

  // =========================================================================
  // CONTEXTOS JÁ DEFINIDOS (Para evitar repetição)
  // =========================================================================
  const knownContexts = [];
  if (mentionsChild || ageGroup === 'crianca') {
    knownContexts.push("- Já sabemos que é CRIANÇA. NÃO pergunte se é adulto.");
  }
  if (mentionsAdult || ageGroup === 'adulto') {
    knownContexts.push("- Já sabemos que é ADULTO. NÃO pergunte se é criança.");
  }
  if (therapyArea) {
    knownContexts.push(`- Especialidade definida: ${therapyArea}. NÃO pergunte área.`);
  }

  if (knownContexts.length > 0) {
    activeModules.push(`🚨 CONTEXTOS JÁ DEFINIDOS (NÃO REPETIR):\n${knownContexts.join('\n')}`);
  }

  // =========================================================================
  // MONTAGEM FINAL
  // =========================================================================
  const closingNote = `
🎯 REGRAS FINAIS OBRIGATÓRIAS:
1. NÃO pergunte o que JÁ está no histórico/resumo.
2. Se perguntaram PREÇO: use SEQUÊNCIA (valor → preço → escolha binária).
3. SEMPRE termine com ESCOLHA BINÁRIA (nunca pergunta de fuga).
4. Máximo 2-3 frases + 1 pergunta + 1 💚.

Responda agora:
  `.trim();

  if (activeModules.length > 0) {
    instructions += `📋 MÓDULOS DE CONTEXTO ATIVADOS:\n\n${activeModules.join('\n\n')}\n\n`;
  }

  return `${instructions}${closingNote}`;
}

/* =========================================================================
   7. FUNÇÃO AUXILIAR: GERA SYSTEM PROMPT DINÂMICO (OPCIONAL)
   
   Para casos onde você quer um SYSTEM_PROMPT ainda mais específico.
   O orchestrator pode usar esta função em vez do SYSTEM_PROMPT_AMANDA fixo.
   ========================================================================= */
export function buildDynamicSystemPrompt(context = {}) {
  // Base sempre inclui o SYSTEM_PROMPT completo
  let prompt = SYSTEM_PROMPT_AMANDA;

  // Adiciona módulos específicos se necessário
  const additionalModules = [];

  if (context.isHotLead) {
    additionalModules.push(DYNAMIC_MODULES.hotLeadContext);
  } else if (context.isColdLead) {
    additionalModules.push(DYNAMIC_MODULES.coldLeadContext);
  }

  if (context.negativeScopeTriggered) {
    additionalModules.push(DYNAMIC_MODULES.negativeScopeContext);
  }

  if (additionalModules.length > 0) {
    prompt += `\n\n📌 CONTEXTO ADICIONAL PARA ESTA CONVERSA:\n${additionalModules.join('\n\n')}`;
  }

  return prompt;
}

/* =========================================================================
   EXPORTS (Mantém compatibilidade com orchestrator.js)
   ========================================================================= */
export { DYNAMIC_MODULES };
