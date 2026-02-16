#!/usr/bin/env node
/**
 * 🔬 MINERADOR DE PADRÕES REAIS
 *
 * Analisa conversas reais do WhatsApp para extrair padrões empíricos.
 * NÃO usa intuição ou opinião - apenas dados de frequência.
 *
 * Input: whatsapp_export_2026-02-13.txt
 * Output: Datasets estruturados para alimentar detectores
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ============================================================================
// CONFIGURAÇÃO
// ============================================================================

const CONFIG = {
  inputFile: path.join(__dirname, '../../whatsapp_export_2026-02-13.txt'),
  outputDir: path.join(__dirname, '../../config/mined-patterns'),

  // Threshold mínimo de ocorrências para considerar padrão
  minOccurrences: 3,

  // Contexto: quantas mensagens antes/depois para analisar
  contextWindow: 2
};

// ============================================================================
// ESTRUTURA DE DADOS
// ============================================================================

const ANALYSIS = {
  // Intenções detectadas
  intents: {
    price: { patterns: new Map(), total: 0, contexts: [] },
    scheduling: { patterns: new Map(), total: 0, contexts: [] },
    location: { patterns: new Map(), total: 0, contexts: [] },
    insurance: { patterns: new Map(), total: 0, contexts: [] },
    urgency: { patterns: new Map(), total: 0, contexts: [] },
    cancellation: { patterns: new Map(), total: 0, contexts: [] },
    confirmation: { patterns: new Map(), total: 0, contexts: [] }
  },

  // Sintomas mencionados (para TherapyDetector)
  symptoms: {
    speech: new Map(),        // "não fala", "troca letras"
    behavior: new Map(),      // "birra", "agressivo"
    learning: new Map(),      // "dificuldade escola"
    motor: new Map(),         // "não anda", "coordenação"
    attention: new Map(),     // "não concentra", "hiperativo"
    emotional: new Map()      // "ansiedade", "medo"
  },

  // Linguagem emocional
  emotions: {
    worry: new Map(),         // "preocupada", "não sei o que fazer"
    urgency: new Map(),       // "urgente", "o mais rápido"
    frustration: new Map(),   // "cansada", "não aguento"
    resistance: new Map(),    // "caro", "não posso"
    comparison: new Map()     // "outra clínica", "mais barato"
  },

  // Padrões de resposta da Amanda
  amandaPatterns: {
    openings: new Map(),      // Como Amanda inicia conversa
    priceResponses: new Map(), // Como Amanda responde sobre preço
    closings: new Map(),      // Como Amanda fecha
    transitions: new Map()    // Como Amanda muda de assunto
  },

  // Edge cases (cenários de borda)
  edgeCases: [],

  // Estatísticas gerais
  stats: {
    totalMessages: 0,
    clientMessages: 0,
    amandaMessages: 0,
    conversations: 0,
    avgMessagesPerConversation: 0
  }
};

// ============================================================================
// PARSERS
// ============================================================================

/**
 * Parseia linha do WhatsApp export
 * Formato: [mensagem17:51] +55 62 9236-4847: mensagem17:51
 */
function parseLine(line) {
  // Remove duplicações (formato do export tem redundância)
  const match = line.match(/\[(.*?)\]\s*(Clínica Fono Inova|\+55\s*\d+\s*\d+-\d+):\s*(.*)$/);

  if (!match) return null;

  const [, timestamp, sender, message] = match;

  return {
    timestamp,
    isAmanda: sender.includes('Clínica Fono Inova'),
    sender,
    message: message.trim(),
    original: line
  };
}

/**
 * Agrupa mensagens em conversas
 */
function groupIntoConversations(messages) {
  const conversations = [];
  let current = [];
  let lastTimestamp = null;

  for (const msg of messages) {
    if (!msg) continue;

    // Nova conversa se passou mais de 2 horas
    const currentTime = parseTimestamp(msg.timestamp);
    if (lastTimestamp && (currentTime - lastTimestamp) > 2 * 60 * 60 * 1000) {
      if (current.length > 0) {
        conversations.push(current);
        current = [];
      }
    }

    current.push(msg);
    lastTimestamp = currentTime;
  }

  if (current.length > 0) {
    conversations.push(current);
  }

  return conversations;
}

function parseTimestamp(ts) {
  // Simplificado - assume formato HH:MM
  const match = ts.match(/(\d+):(\d+)/);
  if (!match) return 0;
  const [, hours, minutes] = match;
  return (parseInt(hours) * 60 + parseInt(minutes)) * 60 * 1000;
}

// ============================================================================
// DETECTORES DE INTENÇÃO (Baseline para comparar)
// ============================================================================

const INTENT_KEYWORDS = {
  price: [
    /\b(pre[çc]o|val(or|ores)|quanto.*custa|investimento|custo|or[çc]amento)\b/i,
    /\bR\$\s*\d+/i,
    /\b(mensalidade|pacote|tabela.*pre[çc]o)\b/i
  ],
  scheduling: [
    /\b(agendar|marcar|agendamento|remarcar|hor[áa]rio|vaga|consulta)\b/i,
    /\b(quando.*posso|tem.*disponibilidade|quero.*marcar)\b/i
  ],
  location: [
    /\b(onde.*fica|endere[çc]o|como.*chegar|localiza[çc][aã]o)\b/i,
    /\b(voc[eê]s.*(s[aã]o|ficam).*onde)\b/i
  ],
  insurance: [
    /\b(plano|conv[eê]nio|unimed|ipasgo|amil|hapvida|bradesco)\b/i,
    /\b(reembolso|guia)\b/i
  ],
  urgency: [
    /\b(urgente|urg[êe]ncia|logo|r[áa]pido|quanto.*antes)\b/i,
    /\b(preciso.*muito|caso.*urgente)\b/i
  ],
  cancellation: [
    /\b(cancelar|desmarcar|n[aã]o.*vou.*poder|imprevisto)\b/i,
    /\b(doente|mal|gripou)\b/i
  ],
  confirmation: [
    /\b(sim|ok|pode.*ser|confirmo|beleza|certo)\b/i
  ]
};

const SYMPTOM_KEYWORDS = {
  speech: [
    /\b(n[aã]o.*fala|atraso.*fala|troca.*letra|gagueira|fala.*errado)\b/i,
    /\b(demora.*falar|poucas.*palavras|s[oó].*algumas.*palavras)\b/i
  ],
  behavior: [
    /\b(birra|agressiv[oa]|comportamento|teima|desobediente)\b/i,
    /\b(opositor|desafiador|n[aã]o.*obedece)\b/i
  ],
  learning: [
    /\b(dificuldade.*(escola|aprender)|n[aã]o.*aprende|problema.*escolar)\b/i,
    /\b(nota.*ruim|repetiu.*ano)\b/i
  ],
  motor: [
    /\b(n[aã]o.*anda|coordena[çc][aã]o|equil[ií]brio|postura)\b/i,
    /\b(anda.*ponta.*p[eé]|cai.*muito)\b/i
  ],
  attention: [
    /\b(n[aã]o.*(concentra|presta.*aten[çc][aã]o)|distra[ií]do|hiperativ)\b/i,
    /\b(tdah|d[eé]ficit.*aten[çc][aã]o|inquieto)\b/i
  ],
  emotional: [
    /\b(ansiedade|medo|chora.*muito|emocional)\b/i,
    /\b(triste|depress|p[aâ]nico)\b/i
  ]
};

const EMOTION_KEYWORDS = {
  worry: [
    /\b(preocupad[oa]|n[aã]o.*sei.*que.*fazer|aflita)\b/i,
    /\b(t[oô].*preocupad|como.*ajudar)\b/i
  ],
  urgency: [
    /\b(urgente|urg[êe]ncia|r[áa]pido|logo)\b/i,
    /\b(o.*quanto.*antes|n[aã]o.*posso.*esperar)\b/i
  ],
  frustration: [
    /\b(cansad[oa]|n[aã]o.*aguento|farta)\b/i,
    /\b(desesperad[oa]|exaust[oa])\b/i
  ],
  resistance: [
    /\b(caro|puxado|n[aã]o.*tenho.*condi[çc][õo]es)\b/i,
    /\b(fora.*or[çc]amento|muito.*caro)\b/i
  ],
  comparison: [
    /\b(outra.*cl[ií]nica|mais.*barato|encontrei.*outro)\b/i,
    /\b(vou.*procurar.*outro|achei.*mais.*barato)\b/i
  ]
};

// ============================================================================
// ANÁLISE PRINCIPAL
// ============================================================================

function analyzeIntents(conversations) {
  console.log('\n🔍 Analisando intenções...\n');

  for (const conv of conversations) {
    for (let i = 0; i < conv.length; i++) {
      const msg = conv[i];

      // Só analisa mensagens de clientes
      if (msg.isAmanda) continue;

      const text = msg.message.toLowerCase();

      // Testa cada intenção
      for (const [intent, patterns] of Object.entries(INTENT_KEYWORDS)) {
        for (const pattern of patterns) {
          if (pattern.test(text)) {
            ANALYSIS.intents[intent].total++;

            // Extrai a frase exata que matchou
            const match = text.match(pattern);
            if (match) {
              const phrase = match[0];
              const count = ANALYSIS.intents[intent].patterns.get(phrase) || 0;
              ANALYSIS.intents[intent].patterns.set(phrase, count + 1);

              // Guarda contexto (mensagem anterior e próxima)
              const context = {
                before: i > 0 ? conv[i-1].message : null,
                current: msg.message,
                after: i < conv.length - 1 ? conv[i+1].message : null
              };
              ANALYSIS.intents[intent].contexts.push(context);
            }
          }
        }
      }
    }
  }

  // Ordena padrões por frequência
  for (const intent of Object.keys(ANALYSIS.intents)) {
    const sorted = Array.from(ANALYSIS.intents[intent].patterns.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 20); // Top 20

    ANALYSIS.intents[intent].topPatterns = sorted;
  }
}

function analyzeSymptoms(conversations) {
  console.log('🏥 Analisando sintomas...\n');

  for (const conv of conversations) {
    for (const msg of conv) {
      if (msg.isAmanda) continue;

      const text = msg.message.toLowerCase();

      for (const [category, patterns] of Object.entries(SYMPTOM_KEYWORDS)) {
        for (const pattern of patterns) {
          const match = text.match(pattern);
          if (match) {
            const phrase = match[0];
            const count = ANALYSIS.symptoms[category].get(phrase) || 0;
            ANALYSIS.symptoms[category].set(phrase, count + 1);
          }
        }
      }
    }
  }

  // Ordena por frequência
  for (const category of Object.keys(ANALYSIS.symptoms)) {
    const sorted = Array.from(ANALYSIS.symptoms[category].entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 15);

    ANALYSIS.symptoms[category] = new Map(sorted);
  }
}

function analyzeEmotions(conversations) {
  console.log('💭 Analisando linguagem emocional...\n');

  for (const conv of conversations) {
    for (const msg of conv) {
      if (msg.isAmanda) continue;

      const text = msg.message.toLowerCase();

      for (const [emotion, patterns] of Object.entries(EMOTION_KEYWORDS)) {
        for (const pattern of patterns) {
          const match = text.match(pattern);
          if (match) {
            const phrase = match[0];
            const count = ANALYSIS.emotions[emotion].get(phrase) || 0;
            ANALYSIS.emotions[emotion].set(phrase, count + 1);
          }
        }
      }
    }
  }

  // Ordena
  for (const emotion of Object.keys(ANALYSIS.emotions)) {
    const sorted = Array.from(ANALYSIS.emotions[emotion].entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10);

    ANALYSIS.emotions[emotion] = new Map(sorted);
  }
}

function analyzeAmandaPatterns(conversations) {
  console.log('🤖 Analisando padrões de resposta da Amanda...\n');

  for (const conv of conversations) {
    for (let i = 0; i < conv.length; i++) {
      const msg = conv[i];

      // Só analisa mensagens da Amanda
      if (!msg.isAmanda) continue;

      const text = msg.message;
      const prevMsg = i > 0 ? conv[i-1] : null;

      // Classifica tipo de mensagem

      // Abertura (primeira mensagem da Amanda)
      if (i === 0 || (prevMsg && !prevMsg.isAmanda)) {
        const count = ANALYSIS.amandaPatterns.openings.get(text) || 0;
        ANALYSIS.amandaPatterns.openings.set(text, count + 1);
      }

      // Resposta de preço
      if (/pre[çc]o|valor|R\$|investimento/i.test(text)) {
        const count = ANALYSIS.amandaPatterns.priceResponses.get(text) || 0;
        ANALYSIS.amandaPatterns.priceResponses.set(text, count + 1);
      }

      // Fechamento (última mensagem)
      if (i === conv.length - 1) {
        const count = ANALYSIS.amandaPatterns.closings.get(text) || 0;
        ANALYSIS.amandaPatterns.closings.set(text, count + 1);
      }
    }
  }

  // Ordena e limita
  const sortAndLimit = (map, limit = 10) => {
    return new Map(
      Array.from(map.entries())
        .sort((a, b) => b[1] - a[1])
        .slice(0, limit)
    );
  };

  ANALYSIS.amandaPatterns.openings = sortAndLimit(ANALYSIS.amandaPatterns.openings);
  ANALYSIS.amandaPatterns.priceResponses = sortAndLimit(ANALYSIS.amandaPatterns.priceResponses, 15);
  ANALYSIS.amandaPatterns.closings = sortAndLimit(ANALYSIS.amandaPatterns.closings);
}

// ============================================================================
// MAIN
// ============================================================================

async function main() {
  console.log('🔬 MINERADOR DE PADRÕES REAIS - Clínica Fono Inova\n');
  console.log('═'.repeat(60));

  // 1. Ler arquivo
  console.log(`\n📁 Lendo: ${CONFIG.inputFile}\n`);
  const content = fs.readFileSync(CONFIG.inputFile, 'utf-8');
  const lines = content.split('\n');

  console.log(`✅ ${lines.length.toLocaleString()} linhas carregadas\n`);

  // 2. Parsear mensagens
  console.log('📊 Parseando mensagens...\n');
  const messages = lines.map(parseLine).filter(Boolean);

  ANALYSIS.stats.totalMessages = messages.length;
  ANALYSIS.stats.clientMessages = messages.filter(m => !m.isAmanda).length;
  ANALYSIS.stats.amandaMessages = messages.filter(m => m.isAmanda).length;

  console.log(`✅ ${messages.length.toLocaleString()} mensagens parseadas`);
  console.log(`   📨 Cliente: ${ANALYSIS.stats.clientMessages.toLocaleString()}`);
  console.log(`   🤖 Amanda: ${ANALYSIS.stats.amandaMessages.toLocaleString()}\n`);

  // 3. Agrupar em conversas
  console.log('💬 Agrupando em conversas...\n');
  const conversations = groupIntoConversations(messages);

  ANALYSIS.stats.conversations = conversations.length;
  ANALYSIS.stats.avgMessagesPerConversation =
    (messages.length / conversations.length).toFixed(1);

  console.log(`✅ ${conversations.length} conversas identificadas`);
  console.log(`   📊 Média: ${ANALYSIS.stats.avgMessagesPerConversation} msgs/conversa\n`);

  console.log('═'.repeat(60));

  // 4. Análises
  analyzeIntents(conversations);
  analyzeSymptoms(conversations);
  analyzeEmotions(conversations);
  analyzeAmandaPatterns(conversations);

  console.log('═'.repeat(60));
  console.log('\n✅ ANÁLISE CONCLUÍDA\n');

  // 5. Gerar relatórios
  generateReports();

  // 6. Exportar datasets
  exportDatasets();
}

// ============================================================================
// RELATÓRIOS
// ============================================================================

function generateReports() {
  console.log('📊 RELATÓRIOS\n');
  console.log('═'.repeat(60));

  // Intenções
  console.log('\n🎯 INTENÇÕES MAIS COMUNS:\n');
  for (const [intent, data] of Object.entries(ANALYSIS.intents)) {
    if (data.total > 0) {
      console.log(`\n${intent.toUpperCase()} (${data.total}x):`);
      if (data.topPatterns) {
        data.topPatterns.slice(0, 5).forEach(([pattern, count]) => {
          console.log(`  ${count}x - "${pattern}"`);
        });
      }
    }
  }

  // Sintomas
  console.log('\n\n🏥 SINTOMAS MAIS MENCIONADOS:\n');
  for (const [category, patterns] of Object.entries(ANALYSIS.symptoms)) {
    if (patterns.size > 0) {
      console.log(`\n${category.toUpperCase()}:`);
      Array.from(patterns.entries()).slice(0, 5).forEach(([symptom, count]) => {
        console.log(`  ${count}x - "${symptom}"`);
      });
    }
  }

  // Emoções
  console.log('\n\n💭 LINGUAGEM EMOCIONAL:\n');
  for (const [emotion, patterns] of Object.entries(ANALYSIS.emotions)) {
    if (patterns.size > 0) {
      console.log(`\n${emotion.toUpperCase()}:`);
      Array.from(patterns.entries()).slice(0, 3).forEach(([phrase, count]) => {
        console.log(`  ${count}x - "${phrase}"`);
      });
    }
  }

  console.log('\n' + '═'.repeat(60) + '\n');
}

function exportDatasets() {
  console.log('💾 Exportando datasets...\n');

  // Criar diretório se não existir
  if (!fs.existsSync(CONFIG.outputDir)) {
    fs.mkdirSync(CONFIG.outputDir, { recursive: true });
  }

  // Converter Maps para objetos serializáveis
  const serialize = (obj) => {
    if (obj instanceof Map) {
      return Object.fromEntries(obj);
    }
    if (typeof obj === 'object' && obj !== null) {
      const result = {};
      for (const [key, value] of Object.entries(obj)) {
        result[key] = serialize(value);
      }
      return result;
    }
    return obj;
  };

  const serialized = serialize(ANALYSIS);

  // Salvar JSON completo
  const jsonPath = path.join(CONFIG.outputDir, 'analysis-complete.json');
  fs.writeFileSync(jsonPath, JSON.stringify(serialized, null, 2));
  console.log(`✅ ${jsonPath}`);

  // Salvar relatório em markdown
  const mdPath = path.join(CONFIG.outputDir, 'ANALYSIS_REPORT.md');
  const mdContent = generateMarkdownReport(serialized);
  fs.writeFileSync(mdPath, mdContent);
  console.log(`✅ ${mdPath}`);

  console.log('\n✨ Datasets exportados com sucesso!\n');
}

function generateMarkdownReport(data) {
  let md = `# 📊 ANÁLISE DE PADRÕES REAIS - WhatsApp Export 2026-02-13\n\n`;
  md += `**Gerado em:** ${new Date().toLocaleString('pt-BR')}\n\n`;
  md += `---\n\n`;

  md += `## 📈 Estatísticas Gerais\n\n`;
  md += `- **Total de mensagens:** ${data.stats.totalMessages.toLocaleString()}\n`;
  md += `- **Mensagens de clientes:** ${data.stats.clientMessages.toLocaleString()}\n`;
  md += `- **Mensagens da Amanda:** ${data.stats.amandaMessages.toLocaleString()}\n`;
  md += `- **Conversas:** ${data.stats.conversations}\n`;
  md += `- **Média de mensagens por conversa:** ${data.stats.avgMessagesPerConversation}\n\n`;

  md += `---\n\n`;

  md += `## 🎯 Intenções Detectadas\n\n`;
  for (const [intent, intentData] of Object.entries(data.intents)) {
    if (intentData.total > 0) {
      md += `### ${intent.toUpperCase()} (${intentData.total}x)\n\n`;
      if (intentData.topPatterns && intentData.topPatterns.length > 0) {
        md += `| Padrão | Ocorrências |\n`;
        md += `|--------|-------------|\n`;
        intentData.topPatterns.slice(0, 10).forEach(([pattern, count]) => {
          md += `| ${pattern} | ${count} |\n`;
        });
        md += `\n`;
      }
    }
  }

  md += `---\n\n`;

  md += `## 🏥 Sintomas por Categoria\n\n`;
  for (const [category, patterns] of Object.entries(data.symptoms)) {
    const entries = Object.entries(patterns);
    if (entries.length > 0) {
      md += `### ${category.toUpperCase()}\n\n`;
      md += `| Sintoma | Frequência |\n`;
      md += `|---------|------------|\n`;
      entries.slice(0, 10).forEach(([symptom, count]) => {
        md += `| ${symptom} | ${count} |\n`;
      });
      md += `\n`;
    }
  }

  return md;
}

// ============================================================================
// EXECUÇÃO
// ============================================================================

main().catch(console.error);
