/**
 * ⏰ Calcula tempo ideal para follow-up
 */
export function calculateOptimalFollowupTime({ lead, score, lastInteraction, attempt = 1 }) {
    const now = new Date();
    let delayHours = 0;

    // base por score (mais espaçado)
    if (score >= 80) delayHours = 24;      // 1 dia
    else if (score >= 50) delayHours = 48; // 2 dias
    else delayHours = 72;                  // 3 dias

    // aumentar por tentativa
    // tentativa 1 → base
    // tentativa 2 → base * 1.5
    // tentativa 3+ → base * 2
    const multiplier = attempt === 1 ? 1 : (attempt === 2 ? 1.5 : 2);
    let delayMs = delayHours * multiplier * 60 * 60 * 1000;

    let scheduledTime = new Date(now.getTime() + delayMs);

    // horário comercial
    const hour = scheduledTime.getHours();
    let day = scheduledTime.getDay();

    if (hour < 8 || hour >= 18) {
        scheduledTime.setHours(9, 0, 0, 0);
        if (hour >= 18) scheduledTime.setDate(scheduledTime.getDate() + 1);
    }

    // fim de semana → segunda 9h
    day = scheduledTime.getDay();
    if (day === 0) {
        scheduledTime.setDate(scheduledTime.getDate() + 1);
        scheduledTime.setHours(9, 0, 0, 0);
    } else if (day === 6) {
        scheduledTime.setDate(scheduledTime.getDate() + 2);
        scheduledTime.setHours(9, 0, 0, 0);
    }

    const recessStart = new Date("2025-12-19T00:00:00-03:00");
    const recessEnd = new Date("2026-01-05T00:00:00-03:00"); // 05/01 já pode

    if (scheduledTime >= recessStart && scheduledTime < recessEnd) {
        scheduledTime = new Date("2026-01-05T09:00:00-03:00");
    }

    return scheduledTime;
}


function inferTopic({ extracted = {}, intentPrimary = '', history = [] }) {
    const pieces = [];

    if (extracted.queixa) pieces.push(String(extracted.queixa));
    if (extracted.indicacao) pieces.push(String(extracted.indicacao));
    if (extracted.motivo) pieces.push(String(extracted.motivo));

    const historyText = history
        .map(m => (m.content || m.text || '').toLowerCase())
        .join(' | ');

    const blob = (pieces.join(' | ') + ' | ' + historyText).toLowerCase();

    const childName = extracted.childName || extractChildNameFromHistory(history);

    // 👉 se tiver nome, usa forma neutra (de João / de Ana)
    if (childName) {
        return `o acompanhamento de ${childName}`;
    }

    // 👇 Casos de família/criança (sem nome)
    if (blob.includes('meu filho') || blob.includes('meu filho ') || blob.includes('meu filho,') || blob.includes('meu filho o ')) {
        return 'o acompanhamento do seu filho';
    }

    if (blob.includes('minha filha') || blob.includes('minha filha ') || blob.includes('minha filha,') || blob.includes('minha filha ')) {
        return 'o acompanhamento da sua filha';
    }

    if (blob.includes('criança') || blob.includes('crianca') || blob.includes('meu neto') || blob.includes('minha neta')) {
        return 'o acompanhamento da criança';
    }

    // 👇 Alzheimer / neuro
    if (blob.includes('alzheimer') || blob.includes('demência') || blob.includes('demencia')) {
        return 'a avaliação neuropsicológica para investigar Alzheimer';
    }

    if (blob.includes('neuropsicol')) {
        return 'a avaliação neuropsicológica';
    }

    // 👇 escola / aprendizagem
    if (blob.includes('escola') || blob.includes('aprendizado') || blob.includes('dificuldade para aprender')) {
        return 'a avaliação para investigar dificuldades de aprendizagem';
    }

    // 👇 psicologia infantil
    if (blob.includes('psicanalista') || blob.includes('psicologia infantil') || blob.includes('psicóloga infantil') || blob.includes('psicologa infantil')) {
        return 'o acompanhamento de psicologia infantil';
    }

    // 👇 fono
    if (blob.includes('atraso de fala') || blob.includes('fala') || blob.includes('fonoaudiolog')) {
        return 'a terapia fonoaudiológica';
    }

    return 'o atendimento na Fono Inova';
}


function extractChildNameFromHistory(history = []) {
    const text = history
        .map(m => (m.content || m.text || ''))
        .join(' ')
        .replace(/\s+/g, ' ')
        .trim();

    // Ex: "meu filho o João Guilherme", "meu filho João Carlos 8 anos"
    const regexes = [
        /meu filho(?: o)? ([A-ZÀ-ÖØ-Ý][A-Za-zÀ-ÖØ-öø-ÿ]+(?: [A-ZÀ-ÖØ-Ý][A-Za-zÀ-ÖØ-öø-ÿ]+){0,2})/g,
        /minha filha(?: a)? ([A-ZÀ-ÖØ-Ý][A-Za-zÀ-ÖØ-öø-ÿ]+(?: [A-ZÀ-ÖØ-Ý][A-Za-zÀ-ÖØ-öø-ÿ]+){0,2})/g
    ];

    for (const r of regexes) {
        const match = r.exec(text);
        if (match && match[1]) {
            return match[1].trim();
        }
    }

    return null;
}


function ensureSingleHeart(text = "") {
    const cleaned = String(text)
        .replace(/💚/g, "")          // remove todos
        .replace(/\s+/g, " ")
        .trim();
    return `${cleaned} 💚`;
}

/**
 * 💬 Gera mensagem contextualizada
 */
export function generateContextualFollowup({ lead, analysis, attempt = 1, history = [], sameDay = false, summaryText = null }) {
    const { extracted = {}, intent = {}, score = lead.conversionScore || 50 } = analysis || {};

    // nome sanitizado
    let firstName = ((lead?.name || "").trim().split(/\s+/)[0]) || "";
    const blacklist = ["contato", "cliente", "lead", "paciente"];
    if (firstName && blacklist.includes(firstName.toLowerCase())) firstName = "";

    // ✅ SEM 💚 aqui (o coração vai só no final)
    const greeting = firstName ? `Oi ${firstName}!` : "Oi!";

    // 🧠 Se existir resumo persistido, injeta no contexto (sem "inventar")
    const historyWithSummary = Array.isArray(history) ? [...history] : [];
    if (summaryText) {
        historyWithSummary.unshift({ direction: "system", content: `[RESUMO] ${summaryText}` });
    }

    // 🧩 pega últimos trechos para follow-up ficar "da conversa de hoje"
    const lastOutbound = [...historyWithSummary].find(m => m && m.direction === "outbound" && (m.content || "").toString().trim().length > 0);
    const lastInbound = [...historyWithSummary].find(m => m && m.direction === "inbound" && (m.content || "").toString().trim().length > 0);
    const lastOutboundText = (lastOutbound?.content || "").toString().trim();
    const lastInboundText = (lastInbound?.content || "").toString().trim();

    const continuityPrefix = sameDay
        ? "Só passando aqui pra dar continuidade no que a gente conversou hoje."
        : "Passei por aqui só pra dar sequência no seu atendimento."

    const intentPrimary = (intent.primary || "").toLowerCase();
    const topic = inferTopic({ extracted, intentPrimary, history: historyWithSummary });

    // === TENTATIVA 3+ → despedida gentil, sem empurrar ===
    if (attempt >= 3) {
        return ensureSingleHeart(
            `${greeting} Esta é a minha última mensagem por aqui, só pra reforçar que, se você decidir seguir com ${topic}, a Fono Inova fica à disposição. Pode chamar quando for um bom momento pra você.`
        );
    }

    // === TENTATIVA 2 → reforço leve, sem pressão ===
    if (attempt === 2) {
        if (score >= 80) {
            return ensureSingleHeart(
                `${greeting} Vi que a gente ainda não finalizou ${topic}. Se quiser, posso te passar agora alguns horários disponíveis pra facilitar.`
            );
        }

        return ensureSingleHeart(
            `${greeting} Passando só pra saber se ficou alguma dúvida sobre ${topic} ou se prefere deixar pra depois. Se eu puder te ajudar com algo específico, é só me falar.`
        );
    }

    // === TENTATIVA 1 → mais direta, mas ainda humana ===
    if (intentPrimary === "agendar_avaliacao" || intentPrimary === "agendar_urgente") {
        return ensureSingleHeart(
            `${opener} Sobre ${topic}, tenho alguns horários livres nos próximos dias. Você prefere período da manhã ou da tarde pra gente tentar encaixar?`
        );
    }

    if (intentPrimary === "informacao_preco") {
        const preco = extracted.precoAvaliacao || extracted.preco || "a avaliação inicial é R$ 220,00";
        return ensureSingleHeart(
            `${opener} Sobre os valores: ${preco}. Se fizer sentido pra você, posso já te ajudar a escolher um horário pra começar.`
        );
    }

    if (score >= 70) {
        return ensureSingleHeart(
            `${opener} Só passando pra saber se ficou alguma dúvida sobre ${topic}. Se quiser, posso te mandar opções de horários ou explicar melhor como funciona o processo.`
        );
    }

    if (score >= 40) {
        return ensureSingleHeart(
            `${opener} Vi seu contato sobre ${topic} e queria saber se ainda posso te ajudar com alguma informação ou orientação.`
        );
    }

    return ensureSingleHeart(
        `${opener} Notei que você entrou em contato sobre ${topic}. Se ainda fizer sentido pra você, fico à disposição pra te ajudar por aqui.`
    );
}

