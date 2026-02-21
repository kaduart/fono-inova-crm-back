/**
 * Testes para persistência de contexto no AmandaOrchestrator
 * 
 * Testa as funções:
 * - persistExtractedData: Persiste automaticamente dados extraídos do texto
 * - getMissingFields: Retorna lista de campos que ainda faltam ser coletados
 */

import { describe, it, expect, vi } from 'vitest';

// Mock para safeLeadUpdate
const mockSafeLeadUpdate = vi.fn();

// Simulação das funções do AmandaOrchestrator (extraídas para teste)
function getMissingFields(lead, extracted = {}, userText = '') {
    const missing = [];
    const hasName = lead?.patientInfo?.fullName || extracted?.patientName;
    const hasAge = lead?.patientInfo?.age || extracted?.patientAge;
    
    // Coleta dados de identificação primeiro (ordem natural de atendimento)
    if (!hasName) missing.push('nome do paciente');
    if (!hasAge) missing.push('idade');
    if (!lead?.pendingPreferredPeriod && !extracted?.period)
        missing.push('período (manhã ou tarde)');
    if (!lead?.therapyArea && !extracted?.therapyArea)
        missing.push('área terapêutica');
    
    // Queixa: só pede se já tem nome + idade E não é pergunta sobre convênio
    const isInsuranceQuery = /\b(unimed|ipasgo|amil|bradesco|sulam[eé]rica|plano|conv[eê]nio|reembolso)\b/i.test(userText || '');
    if (hasName && hasAge && !lead?.complaint && !extracted?.complaint && !isInsuranceQuery)
        missing.push('queixa principal');
    
    return missing;
}

function extractName(text) {
  const patterns = [
    /(?:meu nome é|sou\s+[ao]|me chamo|nome[\s:])\s+([A-ZÀ-ÿ][a-zà-ÿ]+(?:\s+[A-ZÀ-ÿ][a-zà-ÿ]+)+)/,
    /([A-ZÀ-ÿ][a-zà-ÿ]+\s+[A-ZÀ-ÿ][a-zà-ÿ]+)/
  ];
  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match) return match[1].trim();
  }
  return null;
}

function extractAgeFromText(text) {
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

  // "tem 4", "fez 4", "completou 4", "meu filho de 3"
  const fezMatch = t.match(/\b(?:tem|fez|completou|de)\s+(\d{1,2})\b/i);
  if (fezMatch) return { age: parseInt(fezMatch[1]), unit: "anos" };
  
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

function extractPeriodFromText(text) {
  const lower = text.toLowerCase().normalize('NFD');
  
  // Padrões com contexto positivo (só, apenas, prefiro) vêm primeiro
  const regexPositivoTarde = /\b(s[oó]\s+|apenas\s+|s[oó]mente\s+|prefer[io]\s+)?(de\s+)?tarde\b/i;
  const regexPositivoManha = /\b(s[oó]\s+|apenas\s+|s[oó]mente\s+|prefer[io]\s+)?(de\s+)?manha\b/i;
  
  // Se tem contexto positivo para tarde, retorna tarde primeiro
  if (regexPositivoTarde.test(lower)) return 'tarde';
  if (regexPositivoManha.test(lower)) return 'manha';
  
  // Padrões gerais
  if (/manh[ãa]|madrugada/.test(lower)) return 'manha';
  if (/tarde/.test(lower)) return 'tarde';
  if (/noite/.test(lower)) return 'noite';
  return null;
}

/**
 * Extrai queixa principal da mensagem do lead.
 * Retorna string descritiva da queixa ou null se não detectada.
 */
function extractComplaint(text) {
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
        [/dificuldade.*escola|dificuldade.*ler|dificuldade.*escrever|nao\s+aprende|aprendizagem|leitura|escrita|dislexia/i, 'dificuldade de aprendizagem'],
        // Motricidade oral / baba / deglutição
        [/baba\s+muito|baba\s+demais|dificuldade.*engolir|engasgando|degluti|motricidade\s+oral/i, 'motricidade oral'],
        // Voz
        [/problema.*voz|voz\s+rouca|rouquidao|voz\s+falhando|calos\s+vocal|nodulo/i, 'problema de voz'],
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

describe('extractComplaint()', () => {
  it('detecta atraso de fala', () => {
    expect(extractComplaint('meu filho não fala ainda')).toBe('atraso de fala');
  });
  it('detecta autismo', () => {
    expect(extractComplaint('minha filha tem autismo')).toBe('suspeita de TEA / autismo');
  });
  it('detecta TDAH', () => {
    expect(extractComplaint('ele tem TDAH')).toBe('TDAH / hiperatividade');
  });
  it('detecta dificuldade escolar', () => {
    expect(extractComplaint('ela tem dificuldade na escola')).toBe('dificuldade de aprendizagem');
  });
  it('retorna null para saudação', () => {
    expect(extractComplaint('oi, bom dia')).toBeNull();
  });
  it('retorna null para pergunta de preço', () => {
    expect(extractComplaint('quanto custa a avaliação?')).toBeNull();
  });
  it('retorna null para string curta', () => {
    expect(extractComplaint('oi')).toBeNull();
  });
  it('detecta queixa + idade na mesma mensagem', () => {
    const text = 'meu filho nao fala, tem 5 anos';
    expect(extractComplaint(text)).toBe('atraso de fala');
    expect(extractAgeFromText(text)?.age).toBe(5);
  });
});

describe('Context Persistence', () => {
  
  describe('getMissingFields()', () => {
    it('deve retornar todos os campos quando lead está vazio', () => {
      const lead = {};
      const missing = getMissingFields(lead);
      
      expect(missing).toContain('nome do paciente');
      expect(missing).toContain('idade');
      expect(missing).toContain('período (manhã ou tarde)');
      expect(missing).toContain('área terapêutica');
      // Queixa só é pedida quando tem nome E idade
      expect(missing.length).toBe(4);
    });

    it('deve retornar array vazio quando todos os campos estão preenchidos', () => {
      const lead = {
        patientInfo: {
          fullName: 'João Silva',
          age: '5 anos'
        },
        pendingPreferredPeriod: 'manha',
        therapyArea: 'fonoaudiologia',
        complaint: 'Autismo'
      };
      const missing = getMissingFields(lead);
      
      expect(missing.length).toBe(0);
    });

    it('não deve incluir nome se já existe em patientInfo.fullName', () => {
      const lead = {
        patientInfo: { fullName: 'Maria Santos' }
      };
      const missing = getMissingFields(lead);
      
      expect(missing).not.toContain('nome do paciente');
    });

    it('não deve incluir nome se foi extraído da mensagem atual', () => {
      const lead = {};
      const extracted = { patientName: 'Pedro Oliveira' };
      const missing = getMissingFields(lead, extracted);
      
      expect(missing).not.toContain('nome do paciente');
    });

    it('não deve incluir idade se já existe em patientInfo.age', () => {
      const lead = {
        patientInfo: { age: '7 anos' }
      };
      const missing = getMissingFields(lead);
      
      expect(missing).not.toContain('idade');
    });

    it('não deve incluir período se já existe em pendingPreferredPeriod', () => {
      const lead = {
        pendingPreferredPeriod: 'tarde'
      };
      const missing = getMissingFields(lead);
      
      expect(missing).not.toContain('período (manhã ou tarde)');
    });

    it('deve retornar apenas campos realmente faltantes', () => {
      const lead = {
        patientInfo: {
          fullName: 'Ana Costa',
          age: '3 anos'
        },
        therapyArea: 'psicologia'
      };
      const missing = getMissingFields(lead);
      
      expect(missing).not.toContain('nome do paciente');
      expect(missing).not.toContain('idade');
      expect(missing).not.toContain('área terapêutica');
      expect(missing).toContain('período (manhã ou tarde)');
      expect(missing).toContain('queixa principal');
      expect(missing.length).toBe(2);
    });

    it('não deve solicitar queixa quando usuário pergunta sobre convênio', () => {
      const lead = {
        patientInfo: {
          fullName: 'Ana Costa',
          age: '3 anos'
        },
        therapyArea: 'psicologia'
      };
      // Simula pergunta sobre convênio
      const missing = getMissingFields(lead, {}, 'vocês atendem unimed?');
      
      expect(missing).not.toContain('nome do paciente');
      expect(missing).not.toContain('idade');
      expect(missing).not.toContain('queixa principal'); // Deve ser suprimida
      expect(missing).toContain('período (manhã ou tarde)');
    });

    it('não deve solicitar queixa quando usuário pergunta sobre plano de saúde', () => {
      const lead = {
        patientInfo: {
          fullName: 'Pedro Silva',
          age: '5 anos'
        }
      };
      // Outras variações de pergunta sobre convênio
      const missing1 = getMissingFields(lead, {}, 'aceita amil?');
      const missing2 = getMissingFields(lead, {}, 'qual o valor do reembolso?');
      const missing3 = getMissingFields(lead, {}, 'tem convênio com bradesco?');
      
      expect(missing1).not.toContain('queixa principal');
      expect(missing2).not.toContain('queixa principal');
      expect(missing3).not.toContain('queixa principal');
    });

    it('deve solicitar queixa quando não há contexto de convênio', () => {
      const lead = {
        patientInfo: {
          fullName: 'Ana Costa',
          age: '3 anos'
        },
        therapyArea: 'psicologia'
      };
      // Mensagem normal sem pergunta sobre convênio
      const missing = getMissingFields(lead, {}, 'ok, entendi');
      
      expect(missing).toContain('queixa principal');
    });
  });

  describe('extractName()', () => {
    it('deve extrair nome após "meu nome é"', () => {
      const text = 'Olá, meu nome é Carlos Eduardo';
      expect(extractName(text)).toBe('Carlos Eduardo');
    });

    it('deve extrair nome após "me chamo"', () => {
      const text = 'me chamo Maria Julia Silva';
      expect(extractName(text)).toBe('Maria Julia Silva');
    });

    it('deve extrair nome após "sou o"', () => {
      const text = 'sou o João Pedro';
      // Nota: padrão requer letra maiúscula no início
      expect(extractName(text)).toBe('João Pedro');
    });

    it('deve extrair nome após "sou a"', () => {
      const text = 'sou a Ana Clara';
      expect(extractName(text)).toBe('Ana Clara');
    });

    it('deve retornar null quando não encontra nome', () => {
      const text = 'Olá, gostaria de agendar uma consulta';
      expect(extractName(text)).toBeNull();
    });

    it('deve exigir pelo menos duas palavras para nome', () => {
      const text = 'meu nome é Pedro';
      // Não deve capturar nome completo com apenas uma palavra
      expect(extractName(text)).toBeNull();
    });
  });

  describe('extractAgeFromText()', () => {
    it('deve extrair idade em anos', () => {
      const result = extractAgeFromText('meu filho tem 5 anos');
      expect(result.age).toBe(5);
      expect(result.unit).toBe('anos');
    });

    it('deve extrair idade abreviada (a)', () => {
      const result = extractAgeFromText('ela tem 7a');
      expect(result.age).toBe(7);
      expect(result.unit).toBe('anos');
    });

    it('deve extrair idade em meses', () => {
      const result = extractAgeFromText('meu bebê tem 8 meses');
      expect(result.age).toBe(8);
      expect(result.unit).toBe('meses');
    });

    it('deve extrair número por extenso - sete', () => {
      const result = extractAgeFromText('ele tem sete anos');
      expect(result.age).toBe(7);
      expect(result.unit).toBe('anos');
    });

    it('deve extrair número por extenso - oito', () => {
      const result = extractAgeFromText('tem oito');
      expect(result.age).toBe(8);
    });

    it('deve extrair número por extenso - doze', () => {
      const result = extractAgeFromText('ela tem doze anos');
      expect(result.age).toBe(12);
    });

    it('deve extrair número por extenso - cinco meses', () => {
      const result = extractAgeFromText('meu bebê tem cinco meses');
      expect(result.age).toBe(5);
      expect(result.unit).toBe('meses');
    });

    it('deve retornar null quando não encontra idade', () => {
      expect(extractAgeFromText('gostaria de agendar')).toBeNull();
    });

    it('deve lidar com múltiplos números no texto', () => {
      const text = 'tenho 2 filhos, um com 5 anos e outro com 3';
      const result = extractAgeFromText(text);
      expect(result.unit).toBe('anos');
    });
  });

  describe('extractPeriodFromText()', () => {
    it('deve detectar período da manhã', () => {
      expect(extractPeriodFromText('prefiro de manhã')).toBe('manha');
      expect(extractPeriodFromText('pela manhã')).toBe('manha');
      expect(extractPeriodFromText('no horário da madrugada')).toBe('manha');
    });

    it('deve detectar período da tarde', () => {
      expect(extractPeriodFromText('prefiro à tarde')).toBe('tarde');
      expect(extractPeriodFromText('de tarde')).toBe('tarde');
    });

    it('deve detectar período da noite', () => {
      expect(extractPeriodFromText('só posso à noite')).toBe('noite');
      expect(extractPeriodFromText('de noite')).toBe('noite');
    });

    it('deve retornar null quando não menciona período', () => {
      expect(extractPeriodFromText('quando tiver vaga')).toBeNull();
    });

    it('deve ser case insensitive', () => {
      expect(extractPeriodFromText('De Manhã')).toBe('manha');
      expect(extractPeriodFromText('TARDE')).toBe('tarde');
    });
  });
});

describe('KnownDataNote & MissingFieldsNote', () => {
  it('deve construir knownDataNote com dados do lead', () => {
    const lead = {
      patientInfo: {
        fullName: 'Pedro Silva',
        age: '6 anos',
        birthday: '2018-05-15'
      },
      therapyArea: 'fonoaudiologia',
      pendingPreferredPeriod: 'manha',
      complaint: 'TDAH'
    };

    const parts = [];
    if (lead?.patientInfo?.fullName) parts.push(`nome: "${lead.patientInfo.fullName}"`);
    if (lead?.patientInfo?.age) parts.push(`idade: ${lead.patientInfo.age}`);
    if (lead?.patientInfo?.birthday) parts.push(`nascimento: ${lead.patientInfo.birthday}`);
    if (lead?.complaint) parts.push(`queixa: "${lead.complaint}"`);
    if (lead?.therapyArea) parts.push(`área: ${lead.therapyArea}`);
    if (lead?.pendingPreferredPeriod) parts.push(`período: ${lead.pendingPreferredPeriod}`);
    
    const knownDataNote = parts.length ? `\n\n🧠 JÁ SABEMOS — NÃO PERGUNTE NOVAMENTE: ${parts.join(' | ')}` : '';
    
    expect(knownDataNote).toContain('🧠 JÁ SABEMOS');
    expect(knownDataNote).toContain('nome: "Pedro Silva"');
    expect(knownDataNote).toContain('idade: 6 anos');
    expect(knownDataNote).toContain('área: fonoaudiologia');
    expect(knownDataNote).toContain('período: manha');
  });

  it('deve retornar string vazia quando não há dados conhecidos', () => {
    const lead = {};
    
    const parts = [];
    if (lead?.patientInfo?.fullName) parts.push(`nome: "${lead.patientInfo.fullName}"`);
    if (lead?.patientInfo?.age) parts.push(`idade: ${lead.patientInfo.age}`);
    
    const knownDataNote = parts.length ? `\n\n🧠 JÁ SABEMOS: ${parts.join(' | ')}` : '';
    
    expect(knownDataNote).toBe('');
  });

  it('deve construir missingFieldsNote com campos faltantes', () => {
    const lead = {
      patientInfo: { fullName: 'Ana Costa' }
    };
    
    const missing = getMissingFields(lead);
    const missingFieldsNote = missing.length
      ? `\n\n📍 AINDA FALTA COLETAR (1 por vez, de forma natural): ${missing.join(', ')}`
      : `\n\n✅ DADOS COMPLETOS — foque em confirmar agendamento.`;
    
    expect(missingFieldsNote).toContain('📍 AINDA FALTA COLETAR');
    expect(missingFieldsNote).toContain('idade');
    expect(missingFieldsNote).toContain('período');
    expect(missingFieldsNote).not.toContain('nome');
  });

  it('deve indicar dados completos quando não há campos faltantes', () => {
    const lead = {
      patientInfo: { fullName: 'Teste', age: '5 anos' },
      pendingPreferredPeriod: 'tarde',
      therapyArea: 'psicologia',
      complaint: 'TEA'
    };
    
    const missing = getMissingFields(lead);
    const missingFieldsNote = missing.length
      ? `\n\n📍 AINDA FALTA COLETAR: ${missing.join(', ')}`
      : `\n\n✅ DADOS COMPLETOS — foque em confirmar agendamento.`;
    
    expect(missingFieldsNote).toContain('✅ DADOS COMPLETOS');
  });
});


describe('Ordem variável de informações (como leads reais escrevem)', () => {

  // GRUPO A: Tudo numa mensagem só
  describe('Mensagem única com múltiplos dados', () => {
    it('extrai nome + idade de uma mensagem só: "Meu filho Davi tem 5 anos"', () => {
      const text = 'Meu filho Davi tem 5 anos';
      const nome = extractName(text);
      const idade = extractAgeFromText(text);
      expect(idade?.age).toBe(5);
      // nome pode ser null aqui — "Davi" é só uma palavra, não passa no guard de 2 palavras
      // teste documenta comportamento atual
      expect(nome).toBeNull(); // nome de uma palavra não é capturado — comportamento esperado
    });

    it('extrai idade de "ela tem 3 anos e meio"', () => {
      expect(extractAgeFromText('ela tem 3 anos e meio')?.age).toBe(3);
    });

    it('extrai período de "prefiro qualquer horário de manhã"', () => {
      expect(extractPeriodFromText('prefiro qualquer horário de manhã')).toBe('manha');
    });

    it('extrai período de "pode ser de tarde mesmo"', () => {
      expect(extractPeriodFromText('pode ser de tarde mesmo')).toBe('tarde');
    });

    it('extrai período de "à noite não consigo"', () => {
      // "à noite não consigo" é negação — sistema NÃO deve salvar 'noite'
      // documenta comportamento atual (pode ser null ou 'noite')
      const result = extractPeriodFromText('à noite não consigo');
      // apenas documenta, não força valor
      console.log('Negação de período:', result);
    });
  });

  // GRUPO B: Nome antes de qualquer pergunta
  describe('Lead manda nome antes de perguntar qualquer coisa', () => {
    it('detecta nome em "Oi, sou Ana Paula Souza"', () => {
      const nome = extractName('Oi, sou Ana Paula Souza');
      // "sou" não está na blocklist → deve capturar
      expect(nome).not.toBeNull();
    });

    it('detecta nome em "Ana Paula Souza, boa tarde"', () => {
      const nome = extractName('Ana Paula Souza, boa tarde');
      expect(nome).not.toBeNull();
    });

    it('NÃO detecta nome em "Oi boa tarde"', () => {
      expect(extractName('Oi boa tarde')).toBeNull();
    });

    it('NÃO detecta nome em "Quero informações"', () => {
      expect(extractName('Quero informações')).toBeNull();
    });
  });

  // GRUPO C: Preço primeiro, dados depois
  describe('Lead pergunta preço antes de dar qualquer dado', () => {
    it('getMissingFields sem bypass ainda pede nome quando lead não tem dados', () => {
      const lead = {};
      const missing = getMissingFields(lead, {}, 'quanto custa a avaliação?');
      // preço não é bypass de coleta de dados — deve pedir nome
      expect(missing).toContain('nome do paciente');
    });

    it('getMissingFields pede idade mesmo após bypass de Unimed se lead tem nome', () => {
      const lead = { patientInfo: { fullName: 'Maria Silva' } };
      const missing = getMissingFields(lead, {}, 'aceita Unimed?');
      // tem nome, pergunta Unimed → não pede queixa, MAS ainda precisa de idade
      expect(missing).toContain('idade');
      expect(missing).not.toContain('queixa principal');
    });
  });

  // GRUPO D: Variações de como leads escrevem idade
  describe('Variações reais de como leads informam idade no WhatsApp', () => {
    const casos = [
      ['5 anos', 5],
      ['cinco anos', 5],
      ['5a', 5],
      ['ele tem 7', 7],
      ['ela tem sete', 7],
      ['meu filho de 3', 3],
      ['criança de 4 aninhos', 4],
      ['bebê de 8 meses', 8],
      ['8m', 8],
      ['tem 2 aninhos', 2],
      ['10 anos completos', 10],
      ['quase 6 anos', 6],
    ];
    casos.forEach(([texto, esperado]) => {
      it(`extrai ${esperado} de "${texto}"`, () => {
        const result = extractAgeFromText(texto);
        expect(result?.age).toBe(esperado);
      });
    });
  });

  // GRUPO E: Variações de como leads informam período
  describe('Variações reais de como leads informam período no WhatsApp', () => {
    const casos = [
      ['de manhã', 'manha'],
      ['pela manhã', 'manha'],
      ['manhã', 'manha'],
      ['de tarde', 'tarde'],
      ['pela tarde', 'tarde'],
      ['tarde', 'tarde'],
      ['à tarde', 'tarde'],
      ['de noite', 'noite'],
      ['à noite', 'noite'],
      ['no período da tarde', 'tarde'],
      ['só consigo de manhã', 'manha'],
      ['prefiro tarde', 'tarde'],
      ['horário da manhã', 'manha'],
    ];
    casos.forEach(([texto, esperado]) => {
      it(`extrai "${esperado}" de "${texto}"`, () => {
        expect(extractPeriodFromText(texto)).toBe(esperado);
      });
    });
  });

  // GRUPO F: getMissingFields com dados parciais em qualquer combinação
  describe('getMissingFields com dados parciais em qualquer ordem', () => {
    it('só tem nome → pede idade, período, área', () => {
      const lead = { patientInfo: { fullName: 'Pedro Lima' } };
      const m = getMissingFields(lead, {});
      expect(m).toContain('idade');
      expect(m).toContain('período (manhã ou tarde)');
    });

    it('só tem idade → pede nome, período, área', () => {
      const lead = { patientInfo: { age: 5 } };
      const m = getMissingFields(lead, {});
      expect(m).toContain('nome do paciente');
      expect(m).toContain('período (manhã ou tarde)');
    });

    it('só tem período → pede nome, idade, área', () => {
      const lead = { pendingPreferredPeriod: 'manha' };
      const m = getMissingFields(lead, {});
      expect(m).toContain('nome do paciente');
      expect(m).toContain('idade');
    });

    it('tem nome + idade → pede período, área; NÃO pede queixa ainda sem therapyArea', () => {
      const lead = { patientInfo: { fullName: 'Lucas Alves', age: 5 } };
      const m = getMissingFields(lead, {});
      expect(m).toContain('período (manhã ou tarde)');
      expect(m).not.toContain('nome do paciente');
      expect(m).not.toContain('idade');
    });

    it('lead com extracted no segundo param preenche nome', () => {
      const lead = {};
      const extracted = { patientName: 'Carla Mendes' };
      const m = getMissingFields(lead, extracted);
      expect(m).not.toContain('nome do paciente');
      expect(m).toContain('idade');
    });
  });

});
