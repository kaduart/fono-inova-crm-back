#!/usr/bin/env node
/**
 * 🔍 ANÁLISE DE PADRÕES DE LEADS - WhatsApp Export 2026
 *
 * Extrai APENAS conversas de leads (exclui mensagens internas da equipe)
 * e identifica padrões que ainda NÃO estão no clinicWisdom.js
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const FILE_PATH = path.join(__dirname, '../whatsapp_export_2026-02-13.txt');

// Números da equipe interna (para filtrar)
const INTERNAL_NUMBERS = [
  '+55 62 9236-4847', // Número da clínica
  'Clínica Fono Inova'
];

// Padrões que queremos identificar
const PATTERNS = {
  // 🎯 Primeiros contatos
  firstContact: {
    greetings: /^(oi|olá|ola|bom dia|boa tarde|boa noite)/i,
    priceFirst: /^(quanto|valor|pre[çc]o)/i,
    therapy: /fono|psic[oó]log|terapia|ocup/i
  },

  // 💰 Perguntas sobre preço
  price: {
    direct: /quanto (custa|é|fica|sai)/i,
    value: /(valor|pre[çc]o) (da|de)/i,
    objection: /(caro|alto|salgado|pesado|putz)/i,
    discount: /(desconto|promo[çc][aã]o|condi[çc][aã]o)/i
  },

  // 🏥 Convênio
  insurance: {
    accepts: /aceita.*(unimed|ipasgo|plano|conv[eê]nio)/i,
    hasInsurance: /(tenho|eu tenho).*(unimed|plano)/i,
    reimbursement: /reembolso/i
  },

  // 👶 Informações sobre filho/paciente
  child: {
    age: /(\d+)\s*(ano|mês|mes)/i,
    name: /(meu filho|minha filha|ele|ela)\s+([A-Z][a-zà-ú]+)/i,
    complaint: /(n[aã]o fala|fala errado|gagueja|demora|atraso)/i
  },

  // ⏰ Agendamento
  scheduling: {
    request: /(agendar|marcar|hor[aá]rio|vaga|dia)/i,
    period: /(manh[ãa]|tarde|noite)/i,
    urgency: /(urgente|logo|r[aá]pido|hoje)/i
  },

  // ✅ Confirmações
  confirmation: {
    yes: /^(sim|ok|pode|perfeito|isso|certo|beleza)$/i,
    no: /^(n[aã]o|nop|nem|nunca)$/i
  },

  // 🚫 Cancelamento
  cancellation: {
    cancel: /cancelar|desmarcar|desistir/i,
    reschedule: /remarcar|mudar.*hor[aá]rio/i,
    problem: /imprevisto|surgiu|n[aã]o.*poder/i
  }
};

// Estatísticas
const stats = {
  totalLines: 0,
  internalMessages: 0,
  leadMessages: 0,
  patterns: {}
};

// Conversas completas (para contexto)
const conversations = [];
let currentConversation = null;

function isInternalMessage(sender) {
  return INTERNAL_NUMBERS.some(num => sender.includes(num));
}

function extractMessage(line) {
  // Formato: [texto timestamp] +55 62 9999-9999: mensagem
  const match = line.match(/\[(.*?)\d{2}:\d{2}\]\s*(.*?):\s*(.*)/);
  if (!match) return null;

  const [, , sender, message] = match;
  return { sender: sender.trim(), message: message.trim() };
}

function analyzePatterns(message) {
  const detected = [];

  for (const [category, categoryPatterns] of Object.entries(PATTERNS)) {
    for (const [type, pattern] of Object.entries(categoryPatterns)) {
      if (pattern.test(message)) {
        detected.push(`${category}.${type}`);

        // Incrementa estatística
        const key = `${category}.${type}`;
        stats.patterns[key] = (stats.patterns[key] || 0) + 1;
      }
    }
  }

  return detected;
}

function processFile() {
  console.log('🔍 Analisando:', FILE_PATH);

  const content = fs.readFileSync(FILE_PATH, 'utf-8');
  const lines = content.split('\n');

  stats.totalLines = lines.length;

  for (const line of lines) {
    if (!line.trim()) continue;

    const parsed = extractMessage(line);
    if (!parsed) continue;

    const { sender, message } = parsed;
    const isInternal = isInternalMessage(sender);

    if (isInternal) {
      stats.internalMessages++;
      continue;
    }

    // É mensagem de LEAD!
    stats.leadMessages++;

    const patterns = analyzePatterns(message);

    // Agrupa por conversa (mesmo número)
    if (!currentConversation || currentConversation.sender !== sender) {
      if (currentConversation) {
        conversations.push(currentConversation);
      }
      currentConversation = {
        sender,
        messages: [],
        patterns: new Set()
      };
    }

    currentConversation.messages.push({
      text: message,
      patterns
    });

    patterns.forEach(p => currentConversation.patterns.add(p));
  }

  // Adiciona última conversa
  if (currentConversation) {
    conversations.push(currentConversation);
  }
}

function generateReport() {
  console.log('\n📊 ═══════════════════════════════════════════════════════');
  console.log('   RELATÓRIO DE ANÁLISE - WhatsApp Export 2026');
  console.log('═══════════════════════════════════════════════════════\n');

  console.log('📈 ESTATÍSTICAS GERAIS:');
  console.log(`   Total de linhas: ${stats.totalLines.toLocaleString()}`);
  console.log(`   Mensagens internas (equipe): ${stats.internalMessages.toLocaleString()}`);
  console.log(`   Mensagens de LEADS: ${stats.leadMessages.toLocaleString()}`);
  console.log(`   Conversas únicas: ${conversations.length}`);

  console.log('\n🎯 PADRÕES MAIS COMUNS (Top 15):');
  const sortedPatterns = Object.entries(stats.patterns)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 15);

  sortedPatterns.forEach(([pattern, count], i) => {
    console.log(`   ${i + 1}. ${pattern}: ${count}x`);
  });

  console.log('\n💎 EXEMPLOS DE CONVERSAS RELEVANTES:\n');

  // Primeiros contatos com preço
  const priceFirst = conversations.filter(c =>
    c.patterns.has('firstContact.priceFirst')
  ).slice(0, 3);

  if (priceFirst.length) {
    console.log('   📌 LEADS QUE PERGUNTAM PREÇO PRIMEIRO:');
    priceFirst.forEach((c, i) => {
      console.log(`   ${i + 1}. "${c.messages[0].text}"`);
    });
  }

  // Objeções de preço
  const objections = conversations.filter(c =>
    c.patterns.has('price.objection')
  ).slice(0, 3);

  if (objections.length) {
    console.log('\n   📌 OBJEÇÕES DE PREÇO:');
    objections.forEach((c, i) => {
      const objectionMsg = c.messages.find(m =>
        m.patterns.includes('price.objection')
      );
      if (objectionMsg) {
        console.log(`   ${i + 1}. "${objectionMsg.text}"`);
      }
    });
  }

  // Perguntas sobre convênio
  const insurance = conversations.filter(c =>
    c.patterns.has('insurance.accepts') || c.patterns.has('insurance.hasInsurance')
  ).slice(0, 3);

  if (insurance.length) {
    console.log('\n   📌 PERGUNTAS SOBRE CONVÊNIO:');
    insurance.forEach((c, i) => {
      const insuranceMsg = c.messages.find(m =>
        m.patterns.some(p => p.startsWith('insurance.'))
      );
      if (insuranceMsg) {
        console.log(`   ${i + 1}. "${insuranceMsg.text}"`);
      }
    });
  }

  // Cancelamentos
  const cancellations = conversations.filter(c =>
    c.patterns.has('cancellation.cancel')
  ).slice(0, 3);

  if (cancellations.length) {
    console.log('\n   📌 CANCELAMENTOS:');
    cancellations.forEach((c, i) => {
      const cancelMsg = c.messages.find(m =>
        m.patterns.includes('cancellation.cancel')
      );
      if (cancelMsg) {
        console.log(`   ${i + 1}. "${cancelMsg.text}"`);
      }
    });
  }

  // Salva JSON com dados completos
  const outputPath = path.join(__dirname, '../analysis-2026-leads.json');
  const output = {
    metadata: {
      analyzedAt: new Date().toISOString(),
      sourceFile: FILE_PATH,
      totalLines: stats.totalLines,
      leadMessages: stats.leadMessages
    },
    stats: stats.patterns,
    topPatterns: sortedPatterns.map(([pattern, count]) => ({ pattern, count })),
    examples: {
      priceFirst: priceFirst.map(c => c.messages[0].text),
      objections: objections.map(c =>
        c.messages.find(m => m.patterns.includes('price.objection'))?.text
      ).filter(Boolean),
      insurance: insurance.map(c =>
        c.messages.find(m => m.patterns.some(p => p.startsWith('insurance.')))?.text
      ).filter(Boolean),
      cancellations: cancellations.map(c =>
        c.messages.find(m => m.patterns.includes('cancellation.cancel'))?.text
      ).filter(Boolean)
    }
  };

  fs.writeFileSync(outputPath, JSON.stringify(output, null, 2));
  console.log(`\n✅ Análise completa salva em: ${outputPath}`);
}

// Executa
processFile();
generateReport();
