import { parsePtBrDate } from './dateParser.js';

// 🆕 Guard inteligente: rejeita frases-pergunta, aceita nomes
export function isValidPatientName(str) {
    if (!str) return false;
    const words = str.trim().split(/\s+/);
    if (words.length < 2) return false;
    // Rejeita se começa com palavra que não é nome próprio
    const naoSaoNomes = [
        'quero', 'gostaria', 'quanto', 'como', 'meu', 'minha', 'ola', 'olá',
        'oi', 'bom', 'boa', 'tem', 'ela', 'ele', 'não', 'nao', 'sim', 'pode',
        'qual', 'tenho', 'preciso', 'queria', 'fazer', 'agendar', 'marcar',
        'saber', 'info', 'informação', 'obrigado', 'obrigada', 'tudo', 'ok',
        'vocês', 'voces', 'clínica', 'clinica', 'atende', 'atendem',
        'contato', 'whatsapp', 'whatsapp Business' // 🆕 FIX: Rejeita nomes genéricos do WhatsApp
    ];
    const primeira = words[0].toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
    return !naoSaoNomes.includes(primeira);
}

// Extrai nome
export function extractName(msg) {
    const t = String(msg || "").trim();
    
    // Padrão explícito: "nome: João Silva" ou "paciente: Maria"
    const m1 = t.match(/\b(nome|paciente|me chamo|meu nome é|sou o|sou a)\s*[:\-]?\s*([A-ZÀ-Ü][a-zà-ú]+(?:\s+[A-ZÀ-Ü][a-zà-ú]+)+)/i);
    if (m1) return m1[2].trim();

    // Padrão: "sou [Nome]" — introdução direta comum no WhatsApp (aceita nome único)
    const mSou = t.match(/\bsou\s+([A-ZÀ-Ú][a-zà-ú]{2,})(?:[,.\s!?]|$)/i);
    if (mSou) return mSou[1].trim();

    // 🆕 Padrão: nome seguido de idade (ex: "Maria Luísa 7 anos" ou "José 5 anos")
    // Extrai apenas o nome, ignorando a parte numérica
    const mAge = t.match(/^([A-Za-zÀ-ú]+(?:\s+[A-Za-zÀ-ú]+)+?)\s+\d+\s*(anos?|meses?|m|a)/i);
    if (mAge && isValidPatientName(mAge[1].trim())) {
        return mAge[1].trim();
    }

    // Padrão: nome capitalizado após dois-pontos seguido de idade
    // ex: "Tenho dois filhos: Maria Luísa 7 anos e José 5 anos"
    const mColonAge = t.match(/:\s*([A-ZÀ-Ú][a-zà-ú]+(?:\s+[A-ZÀ-Ú][a-zà-ú]+)+)\s+\d+\s*(anos?|meses?)/);
    if (mColonAge && isValidPatientName(mColonAge[1].trim())) {
        return mColonAge[1].trim();
    }
    
    // Padrão de nome próprio (2+ palavras, sem pontuação no final)
    // Rejeita textos com palavras comuns de pergunta/comando
    if (!isValidPatientName(t)) return null;
    
    // Aceita 2+ palavras (independentemente de maiúsculas - WhatsApp é informal)
    // 🆕 Permite que tenha mais texto depois (números, etc)
    const m2 = t.match(/^([A-Za-zÀ-ú]+(?:\s+[A-Za-zÀ-ú]+){1,5})/);
    if (m2 && m2[1].length > 3 && t.length < 100) {
        // Verifica se o que capturou é um nome válido
        if (isValidPatientName(m2[1].trim())) {
            return m2[1].trim();
        }
    }
    
    return null;
};

// Extrai data de nascimento (aceita dd/mm/yyyy, dd-mm-yyyy, "28 de novembro de 2015", etc.)
export function extractBirth(msg) {
    const text = (msg || '').trim();

    // Tenta extrair substring de data do texto livre antes de parsear
    // Ex: "Ela nasceu em 28 de novembro de 2015" → "28 de novembro de 2015"
    const monthNames = 'jan(?:eiro)?|fev(?:ereiro)?|mar[cç]o?|abr(?:il)?|mai(?:o)?|jun(?:ho)?|jul(?:ho)?|ago(?:sto)?|set(?:embro)?|out(?:ubro)?|nov(?:embro)?|dez(?:embro)?';
    const longDateRe = new RegExp(
        `(?:dia\\s+)?(\\d{1,2})\\s+(?:de\\s+)?(${monthNames})(?:\\s+de\\s+|\\s+)(\\d{4})`,
        'i'
    );
    const longMatch = text.match(longDateRe);
    if (longMatch) {
        const d = parsePtBrDate(longMatch[0]);
        if (d) return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    }

    // Numérico: dd/mm/yyyy, dd-mm-yyyy, dd.mm.yyyy
    const numRe = text.match(/\b(\d{2})[\/\-\.](\d{2})[\/\-\.](\d{4})\b/);
    if (numRe) return `${numRe[3]}-${numRe[2]}-${numRe[1]}`;

    // Fallback genérico via parsePtBrDate
    const d = parsePtBrDate(text);
    if (d) return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

    return null;
};

/**
 * Extrai idade da mensagem (aceita "4", "quatro", "4 anos", "tem 4", "fez 4", "4 aninhos")
 */
export function extractAgeFromText(text) {
    const t = (text || "").trim();

    // Mapeamento de números por extenso
    const numerosExtenso = {
        'um': 1, 'uma': 1, 'dois': 2, 'duas': 2, 'três': 3, 'tres': 3, 'quatro': 4,
        'cinco': 5, 'seis': 6, 'sete': 7, 'oito': 8, 'nove': 9, 'dez': 10,
        'onze': 11, 'doze': 12, 'treze': 13, 'quatorze': 14, 'quinze': 15,
        'dezesseis': 16, 'dezessete': 17, 'dezoito': 18, 'dezenove': 19, 'vinte': 20
    };

    // "4 anos", "4anos", "4 aninhos"
    const yearsMatch = t.match(/\b(\d{1,2})\s*(anos?|aninhos?)\b/i);
    if (yearsMatch) return { age: parseInt(yearsMatch[1]), unit: "anos" };
    
    // "cinco anos", "sete aninhos" - números por extenso com anos
    const extensoAnosPattern = new RegExp(
        `\\b(${Object.keys(numerosExtenso).join('|')})\\s*(anos?|aninhos?)\\b`,
        'i'
    );
    const extensoAnosMatch = t.match(extensoAnosPattern);
    if (extensoAnosMatch) {
        const num = numerosExtenso[extensoAnosMatch[1].toLowerCase()];
        if (num) return { age: num, unit: "anos" };
    }

    // "7 dias", "10 dias" - recém-nascidos
    const daysMatch = t.match(/\b(\d{1,3})\s*(dias?)\b/i);
    if (daysMatch) return { age: parseInt(daysMatch[1]), unit: "dias" };

    // "7 meses", "7meses", "cinco meses", "8m"
    const monthsMatch = t.match(/\b(\d{1,2})\s*(m[eê]s|meses|m\b)/i);
    if (monthsMatch) return { age: parseInt(monthsMatch[1]), unit: "meses" };
    
    // Meses por extenso: "cinco meses", "três meses"
    const mesesExtensoPattern = new RegExp(
        `\\b(${Object.keys(numerosExtenso).join('|')})\\s*(m[eê]s|meses)\\b`,
        'i'
    );
    const mesesExtensoMatch = t.match(mesesExtensoPattern);
    if (mesesExtensoMatch) {
        const num = numerosExtenso[mesesExtensoMatch[1].toLowerCase()];
        if (num) return { age: num, unit: "meses" };
    }

    // "tem 4", "fez 4", "completou 4" - COM CONTEXTO OBRIGATÓRIO
    // REMOVIDO: "de" porque pegava "1 sessão" como idade 1
    const fezMatch = t.match(/\b(?:tem|fez|completou)\s+(\d{1,2})\b/i);
    if (fezMatch) {
        // Verificar se tem contexto de idade (anos/meses) próximo
        const contextWindow = t.substring(Math.max(0, fezMatch.index - 20), fezMatch.index + 20);
        const hasAgeContext = /\b(anos?|meses?|aninhos?)\b/i.test(contextWindow);
        // Só aceita se tiver contexto explícito OU for número isolado na mensagem
        if (hasAgeContext || t.match(/^\s*(?:tem|fez|completou)?\s*\d{1,2}\s*$/i)) {
            return { age: parseInt(fezMatch[1]), unit: "anos" };
        }
    }
    
    // Abreviatura: "7a", "5a" (anos)
    const abrevMatch = t.match(/\b(\d{1,2})[a]\b/i);
    if (abrevMatch) return { age: parseInt(abrevMatch[1]), unit: "anos" };

    // Número puro "4" (só se for a mensagem inteira ou quase)
    const pureMatch = t.match(/^\s*(\d{1,2})\s*$/);
    if (pureMatch) return { age: parseInt(pureMatch[1]), unit: "anos" };

    // Números por extenso: "tem sete anos", "ele tem oito"
    const extensoPattern = new RegExp(
        `\\b(?:tem|fez|completou|tem\\s+)\\s*(${Object.keys(numerosExtenso).join('|')})\\s*(anos?|aninhos?)?\\b`,
        'i'
    );
    const extensoMatch = t.match(extensoPattern);
    if (extensoMatch) {
        const num = numerosExtenso[extensoMatch[1].toLowerCase()];
        if (num) return { age: num, unit: "anos" };
    }

    // Número por extenso isolado no final: "ele tem sete"
    const extensoIsolado = t.match(/\b(?:tem|fez|completou)\s+([a-záêíóúç]+)$/i);
    if (extensoIsolado) {
        const num = numerosExtenso[extensoIsolado[1].toLowerCase()];
        if (num) return { age: num, unit: "anos" };
    }

    return null;
}

/**
 * Extrai período da mensagem
 * Prioriza períodos positivos ("só de tarde") sobre mencionados em contexto negativo
 */
export function extractPeriodFromText(text) {
    // Normalizar para NFD para lidar com caracteres acentuados
    let t = (text || "").toLowerCase().normalize('NFD');
    
    // 🆕 FIX: Limpa erros comuns de digitação mobile
    // "Dmanha" → "manha" (quando o usuário digita rápido e o D fica grudado)
    t = t.replace(/^d(manha|tarde|noite)\b/, '$1');
    
    // Padrões com contexto positivo (só, apenas, prefiro) vêm primeiro
    const regexPositivoTarde = /\b(s[oó]\s+|apenas\s+|s[oó]mente\s+|prefer[io]\s+)?(de\s+)?tarde\b/i;
    const regexPositivoManha = /\b(s[oó]\s+|apenas\s+|s[oó]mente\s+|prefer[io]\s+)?(de\s+)?manha\b/i;
    
    // Se tem contexto positivo para tarde, retorna tarde primeiro
    if (regexPositivoTarde.test(t)) return "tarde";
    if (regexPositivoManha.test(t)) return "manha";
    
    // Padrões gerais
    const regexManha = /\b(de\s+)?manha\b|\bpela\s+manha\b|\bcedo\b/i;
    const regexTarde = /\b(de\s+)?tarde\b|\bpela\s+tarde\b/i;
    const regexNoite = /\b(de\s+)?noite\b|\bpela\s+noite\b|\ba\s+noite\b/i;
    
    if (regexManha.test(t)) return "manha";
    if (regexTarde.test(t)) return "tarde";
    if (regexNoite.test(t)) return "noite";
    return null;
}

/**
 * Extrai queixa principal da mensagem do lead.
 * Retorna string descritiva da queixa ou null se não detectada.
 */
export function extractComplaint(text) {
    if (!text || text.trim().length < 3) return null;

    const t = text.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');

    // Mapeamento de padrões → queixa padronizada
    const padroes = [
        // Atraso de fala / linguagem
        [/nao\s+fala|ainda\s+nao\s+fala|nao\s+fala\s+ainda|atraso\s+de\s+fala|demora\s+falar|nao\s+consegue\s+falar|fala\s+pouco|nao\s+desenvolveu\s+fala|sem\s+fala|nao\s+ta\s+falando/i, 'atraso de fala'],
        // TEA / Autismo
        [/autis|tea\b|transtorno\s+do\s+espectro|espectro\s+autista/i, 'suspeita de TEA / autismo'],
        // TDAH
        [/tdah|deficit\s+de\s+atencao|hiperativ|desatento|nao\s+para\s+quieto/i, 'TDAH / hiperatividade'],
        // Trocas fonêmicas (R/L, S/Z etc)
        [/troca.*letra|troca.*r.*l|troca.*l.*r|troca.*s.*z|fala\s+errado|pronuncia\s+errado|nao\s+pronuncia/i, 'trocas fonêmicas'],
        // Gagueira / fluência
        [/gagueir|trava\s+falar|repetindo\s+silaba|travar\s+falar/i, 'gagueira / disfluência'],
        // Dificuldade escolar / leitura
        [/dificuldade.*escola|dificuldade.*ler|dificuldade.*escrever|nao\s+aprende|aprendizagem|leitura|escrita|dislexia|nao\s+consegue\s+ler|letras\s+embaralham/i, 'dificuldade de aprendizagem'],
        // Enurese / xixi na cama
        [/enurese|xixi\s+na\s+cama|mija\s+na\s+cama|molha\s+(a\s+)?cama|xixi\s+dormindo/i, 'enurese'],
        // Motricidade oral / baba / deglutição
        [/baba\s+muito|baba\s+demais|dificuldade.*engolir|engasgando|degluti|motricidade\s+oral/i, 'motricidade oral'],
        // Voz - PROBLEMAS VOCAIS (adulto e criança)
        [/problema.*voz|voz\s+rouca|rouquidao|voz\s+falhando|calos\s+vocal|nodulo|nodulos/i, 'problema de voz'],
        // Fenda vocal / fissura / fenda glótica
        [/fenda\s+vocal|fissura\s+vocal|fenda\s+glotica|fenda\s+na\s+voz/i, 'fenda vocal'],
        // Pre gas vocais não fecham / diastase
        [/pregas?\s+vocai?s?|pregas?\s+nao\s+fecha|diastase|paralisia\s+vocal/i, 'disfunção de pregas vocais'],
        // Ar na voz / escaping / eficiência vocal
        [/ar\s+na\s+voz|escapando|voz\s+fraca|voz\s+sem\s+forca|voz\s+baixa/i, 'ineficiência vocal (ar na voz)'],
        // Cantor / voz profissional
        [/cantor|cantora|voz\s+profissional|uso\s+profissional|professor|locutor|apresentador/i, 'voz profissional / cantor'],
        // Cisto / pólipo vocal
        [/cisto\s+vocal|polipo\s+vocal|edema\s+de\s+reinke/i, 'lesão benigna de pregas vocais'],
        // Disfonia genérica
        [/disfonia|disfonico|disfonica/i, 'disfonia'],
        // Psicologia / saúde mental
        [/ansiedade|depressao|deprimid|comportamento|birra|agress|medo.*excessivo|fobia|choro\s+muito|nao\s+dorme/i, 'saúde mental / comportamento'],
        // TOD / oposição
        [/tod\b|oposi[cç]ao\s+desafiadora|desafia\s+muito|desobediente\s+demais/i, 'TOD / oposição desafiadora'],
        // Psicopedagogia
        [/psicopedagogia|dificuldade.*pedagogic|orientacao.*escolar/i, 'dificuldade pedagógica'],
        // Avaliação neuropsicológica
        [/avalia[cç]ao\s+neuropsicolog|neuropsicolog|avalia[cç]ao\s+cognitiv|relatorio\s+escolar/i, 'avaliação neuropsicológica'],
        // Fono genérico mas com contexto
        [/fonoaudiologi|fono\b.*filho|fono\b.*filha|sessao\s+fono/i, 'fonoaudiologia (queixa não especificada)'],
        // Fisioterapia / desenvolvimento motor
        [/fisioterapi|nao\+andou\s+ainda|atraso\s+motor|desenvolvimento\s+motor/i, 'desenvolvimento motor'],
        // Terapia ocupacional
        [/terapia\s+ocupacional|sensori|hipersensib|processamento\s+sensorial/i, 'integração sensorial / TO'],
        // Musicoterapia
        [/musicoterapi/i, 'musicoterapia'],
    ];

    for (const [regex, queixa] of padroes) {
        if (regex.test(t)) return queixa;
    }

    return null;
}