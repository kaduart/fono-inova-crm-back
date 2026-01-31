// ======================================================
// 🔹 ContextPack.js
// Fonte única de contexto (Lead + mensagens + modo + urgência)
// 🆕 Gera mensagens de Warm Recall com urgência desenvolvimental sutil
// ======================================================

import Lead from "../../models/Leads.js";
import Message from "../../models/Message.js";
import { determineMode } from "./ModeRouter.js";

/**
 * Monta o pacote de contexto unificado usado por AmandaAI.
 */
export async function buildContextPack(leadId) {
  const lead = await Lead.findById(leadId).lean();
  if (!lead) throw new Error("Lead não encontrado para ContextPack");

  // últimas 20 mensagens
  const messages = await Message.find({ lead: leadId })
    .sort({ createdAt: -1 })
    .limit(20)
    .lean();

  const recentMessages = messages.reverse();
  const lastUserMessage = recentMessages
    .slice()
    .reverse()
    .find((m) => m.from === "user");
  const lastAmandaMessage = recentMessages
    .slice()
    .reverse()
    .find((m) => m.from === "amanda");

  // Define modo (clínico / comercial / booking / suporte)
  const mode = determineMode({
    lead,
    lastUserMessage,
    recentMessages,
  });

  const toneMode = determineToneMode({
    lead,
    lastUserMessage,
  });

  const urgencyLevel =
    lead?.clinicalFlags?.includes("crise") ||
      (lead?.ageGroup === "bebê" && lead?.therapyArea === "fonoaudiologia")
      ? "ALTA"
      : lead?.urgencyLevel || "NORMAL";

  return {
    leadId,
    conversationSummary: lead.conversationSummary || "",
    knownFacts: lead.knownFacts || {},
    recentMessages,
    lastUserMessage,
    lastAmandaMessage,
    stage: lead.stage,
    mode,
    toneMode,
    urgencyLevel,
    lastAgreement: lead.lastAgreement || null,
  };
}

function determineToneMode({
  lead,
  lastUserMessage,
}) {
  const text =
    typeof lastUserMessage?.content === "string"
      ? lastUserMessage.content.toLowerCase()
      : "";

  const messageLength = text.length;

  // ================================
  // PRIORIDADE 1 — EMOÇÃO / MEDO EXPLÍCITO
  // ================================
  const emotionalKeywords = [
    "preocup",
    "medo",
    "insegur",
    "ansios",
    "receio",
    "desesper",
    "aflita",
    "com medo",
  ];

  const hasEmotionalLanguage =
    emotionalKeywords.some((word) => text.includes(word)) ||
    lead?.clinicalFlags?.includes("ansiedade") ||
    lead?.clinicalFlags?.includes("medo");

  if (hasEmotionalLanguage) {
    return "acolhimento";
  }

  // ================================
  // PRIORIDADE 2 — CONTEXTO CLÍNICO SENSÍVEL
  // ================================
  if (
    lead?.mentionsChild === true ||
    lead?.mentionsTEA === true ||
    lead?.mentionsDoubtTEA === true ||
    lead?.ageGroup === "bebê" ||
    messageLength > 300
  ) {
    return "acolhimento";
  }

  // ================================
  // PRIORIDADE 3 — PERFIL DECISOR / ADULTO
  // ================================
  const isAdultDecisor =
    lead?.mentionsAdult === true ||
    lead?.segment === "decisor" ||
    lead?.score >= 70 ||
    /quanto custa|valor|preço|agenda|horário/i.test(text);

  if (isAdultDecisor) {
    return "premium";
  }

  // ================================
  // FALLBACK SEGURO
  // ================================
  return "acolhimento";
}

// ======================================================
// 🆕 WARM RECALL - Mensagens de retorno para leads inativos
// ======================================================

/**
 * Gera mensagem de Warm Recall personalizada
 * REGRA: ≤6 anos = urgência desenvolvimental sutil | >6 anos = afetivo apenas
 */
export function generateWarmRecall(contextPack, lead) {
  const hoursSince = contextPack?.lastDate 
    ? (Date.now() - new Date(contextPack.lastDate)) / (1000 * 60 * 60)
    : 48; // fallback: 48h
  
  const childName = lead?.childData?.name || lead?.knownFacts?.childName;
  const childAge = extractChildAge(lead);
  const parentName = lead?.name?.split(' ')[0] || "";
  const therapyType = lead?.therapyArea || lead?.knownFacts?.therapyType || "avaliação";
  
  // Determina tier de urgência baseado na idade
  const isDevelopmentalWindow = childAge !== null && childAge <= 6;
  
  // Seleciona template apropriado
  if (hoursSince > 72) {
    return generate72hRecall({ parentName, childName, childAge, isDevelopmentalWindow, therapyType });
  } else if (hoursSince > 48) {
    return generate48hRecall({ parentName, childName, childAge, isDevelopmentalWindow, therapyType });
  } else {
    return generate24hRecall({ parentName, childName, isDevelopmentalWindow });
  }
}

/**
 * Extrai idade da criança de várias fontes possíveis
 */
function extractChildAge(lead) {
  // Tenta knownFacts primeiro
  if (lead?.knownFacts?.childAge) {
    return parseInt(lead.knownFacts.childAge);
  }
  
  // Tenta qualificationData
  if (lead?.qualificationData?.childAge) {
    return parseInt(lead.qualificationData.childAge);
  }
  
  // Tenta childData
  if (lead?.childData?.age) {
    return parseInt(lead.childData.age);
  }
  
  // Tenta extrair de texto do summary
  const summary = lead?.conversationSummary || "";
  const ageMatch = summary.match(/(\d+)\s*(?:anos?|anos de idade)/i);
  if (ageMatch) {
    return parseInt(ageMatch[1]);
  }
  
  return null;
}

/**
 * Recall 24h - Tom leve, sem urgência
 */
function generate24hRecall({ parentName, childName, isDevelopmentalWindow }) {
  const templates = [
    `Oi${parentName ? ", " + parentName : ""}! 👋\n\nPassando para relembrar que estou aqui quando precisar. Sei que a rotina é intensa e às vezes a mensagem acaba ficando pra depois.${childName ? ` O ${childName} está bem?` : ""}\n\nQuando sentir que é o momento certo, estou por aqui para ajudar 💚`,
    
    `${parentName ? parentName + ", " : ""}queria tocar base com você 💚\n\nSem pressa nenhuma — sei que tem mil coisas na cabeça. Só queria que soubesse que não esqueci de vocês.${childName ? ` Como vai o ${childName}?` : ""}\n\nQuando puder, me conta como está a situação 🤗`,
  ];
  
  return templates[Math.floor(Math.random() * templates.length)];
}

/**
 * Recall 48h - Tom consultivo, urgência sutil apenas se ≤6 anos
 */
function generate48hRecall({ parentName, childName, childAge, isDevelopmentalWindow, therapyType }) {
  if (isDevelopmentalWindow && childAge !== null) {
    // Urgência desenvolvimental SUTIL - consultiva, não ameaçadora
    const templates = [
      `${parentName ? parentName + ", " : ""}fiquei pensando no que conversamos sobre o${childName ? " " + childName : " seu filho"} 💚\n\nSei que está corrido, mas nessa idade (${childAge} anos), cada semana que passa é uma oportunidade de desenvolvimento que não volta da mesma forma. Não quero pressionar — só quero que saiba que quanto antes iniciarmos, mais leve será o caminho dele.\n\nEstou aqui quando sentir que é o momento 🤗`,
      
      `Oi${parentName ? ", " + parentName : ""}! 💚\n\nNão sei se te contaram, mas trabalho com uma clínica que realmente se importa com o tempo das crianças. Com ${childAge} anos, a ${therapyType} tem um impacto diferente — não é alarme, é ciência. As janelas de desenvolvimento são mais receptivas agora.\n\nSe quiser conversar sobre isso, estou aqui. Sem pressão, só carinho pelo ${childName || "seu pequeno"} 🤗`,
    ];
    
    return templates[Math.floor(Math.random() * templates.length)];
  } else {
    // >6 anos - Tom afetivo apenas, SEM urgência temporal
    const templates = [
      `${parentName ? parentName + ", " : ""}como você está? 💚\n\nSei que passaram alguns dias e a vida não para. Só queria saber se está tudo bem com vocês${childName ? " — e como vai o " + childName : ""}.\n\nQuando quiser retomar nossa conversa sobre a ${therapyType}, estarei aqui. No seu tempo 🤗`,
      
      `Oi${parentName ? ", " + parentName : ""}! 👋\n\nPassando para dizer que não esqueci de vocês. Sei que decidir sobre ${therapyType} leva tempo, e está tudo bem.${childName ? ` Como o ${childName} está se saindo?` : ""}\n\nEstou aqui quando quiser continuar 💚`,
    ];
    
    return templates[Math.floor(Math.random() * templates.length)];
  }
}

/**
 * Recall 72h - Último toque, mais direto mas sempre consultivo
 */
function generate72hRecall({ parentName, childName, childAge, isDevelopmentalWindow, therapyType }) {
  if (isDevelopmentalWindow && childAge !== null) {
    // Urgência consultiva máxima, mas ainda sem pressão
    const templates = [
      `${parentName ? parentName + ", " : ""}preciso ser honesta com você 💚\n\nCom ${childAge} anos, o ${childName || "seu filho"} está em uma fase onde cada mês faz diferença real no desenvolvimento. Não estou dizendo isso para pressionar — estou dizendo porque me importo.\n\nSe for para fazer, quanto antes, melhor para ele. Se não for agora, também tudo bem. Mas não quero que passe mais tempo sem pelo menos saber das opções.\n\nPosso te ajudar com isso? 🤗`,
      
      `${parentName ? parentName + ", " : ""}vou ser direta: não quero que o ${childName || "seu filho"} perca tempo precioso 💚\n\nCom ${childAge} anos, iniciar a ${therapyType} agora versus daqui 3 meses pode significar 6 meses a menos de acompanhamento no futuro. É matemática, não pressão.\n\nSe ainda está em dúvida, que tal uma conversa rápida? Mesmo que seja só para tirar dúvidas. Estou aqui 🤗`,
    ];
    
    return templates[Math.floor(Math.random() * templates.length)];
  } else {
    // >6 anos - Tom afetivo, convite final sem urgência
    const templates = [
      `${parentName ? parentName + ", " : ""}passando para um último toque 💚\n\nSei que a vida é corrida e às vezes a gente acaba deixando as coisas para depois. Mas queria que soubesse que estou aqui se precisar${childName ? " do " + childName : ""}.\n\nNossa ${therapyType} pode fazer diferença — quando você estiver pront${parentName ? "a" : "o"}, estarei aqui 🤗`,
      
      `Oi${parentName ? ", " + parentName : ""}! 💚\n\nNão quero incomodar, mas também não quero que ache que te esqueci. Sei que decidir sobre ${therapyType} não é simples.\n\nSe quiser conversar, estou aqui. Se não for agora, sem problemas — a porta está aberta 🤗`,
    ];
    
    return templates[Math.floor(Math.random() * templates.length)];
  }
}

