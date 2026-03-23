#!/usr/bin/env node
/**
 * 🔥 REPLAY DE CONVERSAS REAIS — Amanda FSM V8
 * 
 * Pega mensagens reais de leads (40k no banco) e manda pra Amanda local
 * ver como ela responde HOJE. Gera relatório Q&A massivo.
 * 
 * Baseado na análise real: 4.497 mensagens de leads classificadas
 * 
 * Uso:
 *   node scripts/amanda/replay-conversas-reais.js --limit=100
 *   node scripts/amanda/replay-conversas-reais.js --category=scheduling
 *   node scripts/amanda/replay-conversas-reais.js --random=200
 */

import mongoose from 'mongoose';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import 'dotenv/config';

// 🛡️ PROTEÇÃO: Modo replay - evita efeitos colaterais
process.env.AMANDA_REPLAY_MODE = 'true';
process.env.DISABLE_WEBHOOKS = 'true';
process.env.DISABLE_FOLLOWUP = 'true';

// Importa a Amanda (MESMA função que produção usa)
import { getOptimizedAmandaResponse } from '../../orchestrators/AmandaOrchestrator.js';
import Message from '../../models/Message.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MONGO_URI = process.env.MONGO_URI;

// ═══════════════════════════════════════════════════════════
// CATEGORIAS BASEADAS NA ANÁLISE REAL DOS 40K
// ═══════════════════════════════════════════════════════════

const CATEGORIES = {
  scheduling: {
    name: 'Agendamento (fundodo funil)',
    keywords: ['agendar', 'marcar', 'consulta', 'horario', 'disponivel', 'vaga', 'quando tem'],
    description: '~23% das mensagens - onde o dinheiro está',
    priority: 'ALTA'
  },
  firstContact: {
    name: 'Primeiro Contato / Saudação',
    keywords: ['oi', 'ola', 'bom dia', 'boa tarde', 'boa noite', 'gostaria', 'quero', 'preciso'],
    description: '~17% das mensagens - entrada do funil',
    priority: 'ALTA'
  },
  therapy: {
    name: 'Dúvida sobre Terapia',
    keywords: ['terapia', 'fono', 'fonoaudiologia', 'to', 'terapia ocupacional', 'psico', 'psicologia', 'fisio'],
    description: '~8% das mensagens - meio do funil',
    priority: 'MEDIA'
  },
  price: {
    name: 'Preço / Valor',
    keywords: ['preco', 'preço', 'valor', 'custa', 'quanto', 'r$', 'reais', 'pacote', 'desconto'],
    description: '~1.6% das mensagens - objeção',
    priority: 'MEDIA'
  },
  insurance: {
    name: 'Plano de Saúde',
    keywords: ['plano', 'unimed', 'saude', 'saúde', 'reembolso', 'cobertura', 'convenio', 'convênio'],
    description: '~0.4% das mensagens - objeção',
    priority: 'MEDIA'
  },
  childInfo: {
    name: 'Info da Criança',
    keywords: ['filho', 'filha', 'anos', 'idade', 'nome', 'queixa', 'problema', 'dificuldade'],
    description: 'Dados da criança - qualificação',
    priority: 'ALTA'
  },
  urgency: {
    name: 'Urgência',
    keywords: ['urgente', 'preciso logo', 'hoje', 'amanha', 'amanhã', 'quanto antes', 'desesperado'],
    description: 'Sinais de urgência - prioridade máxima',
    priority: 'CRITICA'
  }
};

// ═══════════════════════════════════════════════════════════
// CONFIGURAÇÃO VIA ARGUMENTOS
// ═══════════════════════════════════════════════════════════

function parseArgs() {
  const args = {
    limit: 50,
    random: false,
    category: null,
    filter: null,
    minLength: 8
  };

  process.argv.forEach(arg => {
    if (arg.startsWith('--limit=')) args.limit = parseInt(arg.split('=')[1]);
    if (arg.startsWith('--category=')) args.category = arg.split('=')[1];
    if (arg.startsWith('--filter=')) args.filter = arg.split('=')[1];
    if (arg === '--random') args.random = true;
  });

  return args;
}

const args = parseArgs();

console.log(`
╔════════════════════════════════════════════════════════════════╗
║  🔥 REPLAY DE CONVERSAS REAIS — Amanda FSM V8                  ║
╠════════════════════════════════════════════════════════════════╣
║  Baseado em: 4.497 mensagens de leads analisadas               ║
║  Modo: ${args.random ? 'ALEATÓRIO' : 'MAIS RECENTES'}${' '.repeat(26)}║
║  Limite: ${args.limit} mensagens${' '.repeat(33)}║
║  Categoria: ${args.category || 'TODAS'}${' '.repeat(30)}║
╚════════════════════════════════════════════════════════════════╝
`);

// ═══════════════════════════════════════════════════════════
// FUNÇÕES AUXILIARES
// ═══════════════════════════════════════════════════════════

function isValidQuestion(text) {
  if (!text || typeof text !== 'string') return false;
  if (text.length < args.minLength) return false;
  
  const t = text.toLowerCase().trim();
  
  // Ignora mensagens curtas/comuns
  const ignorar = [
    'ok', 'obrigado', 'obrigada', 'valeu', 'blz', 'beleza',
    'bom dia', 'boa tarde', 'boa noite', 'oi', 'olá', 'ola',
    'sim', 'não', 'nao', '👍', '🙏', 'ok?', 'ta', 'tá', 'ok'
  ];
  
  if (ignorar.includes(t)) return false;
  if (t.split(' ').length < 2) return false;
  
  return true;
}

function detectCategory(text) {
  const t = text.toLowerCase();
  
  for (const [key, cat] of Object.entries(CATEGORIES)) {
    if (cat.keywords.some(k => t.includes(k))) {
      return key;
    }
  }
  
  return 'geral';
}

function makeFreshLead(phone) {
  return {
    _id: new mongoose.Types.ObjectId(),
    stage: 'novo',
    messageCount: 0,
    contact: {
      _id: new mongoose.Types.ObjectId(),
      phone: phone || '5562999990000',
      name: 'Lead Replay',
    },
    tags: [],
  };
}

function getCategoryPriority(category) {
  return CATEGORIES[category]?.priority || 'BAIXA';
}

// ═══════════════════════════════════════════════════════════
// FUNÇÃO PRINCIPAL
// ═══════════════════════════════════════════════════════════

async function run() {
  console.log('📡 Conectando ao MongoDB...');
  await mongoose.connect(MONGO_URI);
  console.log('✅ Conectado!\n');

  console.log('🔍 Buscando mensagens de leads...');
  
  // Monta a query
  let query = { 
    direction: 'inbound',
    type: 'text'
  };
  
  // Se tiver categoria, usa os keywords dela
  if (args.category && CATEGORIES[args.category]) {
    const keywords = CATEGORIES[args.category].keywords;
    query.$or = keywords.map(k => ({ content: { $regex: k, $options: 'i' } }));
    console.log(`📂 Categoria: ${CATEGORIES[args.category].name}`);
    console.log(`   Keywords: ${keywords.join(', ')}\n`);
  } else if (args.filter) {
    query.content = { $regex: args.filter, $options: 'i' };
  }
  
  // Busca as mensagens
  let messagesQuery = Message.find(query);
  
  if (args.random) {
    messagesQuery = messagesQuery.skip(Math.floor(Math.random() * 1000));
  } else {
    messagesQuery = messagesQuery.sort({ timestamp: -1 });
  }
  
  const messages = await messagesQuery.limit(args.limit * 3).lean();
  
  console.log(`📥 Encontradas ${messages.length} mensagens brutas`);
  
  // Filtra só mensagens válidas
  const validMessages = messages.filter(m => isValidQuestion(m.content));
  
  console.log(`✅ ${validMessages.length} mensagens válidas após filtro`);
  console.log(`🚀 Iniciando replay com Amanda...\n`);
  
  const results = [];
  const startTime = Date.now();
  const limit = Math.min(validMessages.length, args.limit);
  
  for (let i = 0; i < limit; i++) {
    const msg = validMessages[i];
    const pergunta = msg.content.trim();
    const categoria = detectCategory(pergunta);
    const prioridade = getCategoryPriority(categoria);
    
    console.log(`  [${i + 1}/${limit}] [${prioridade}] "${pergunta.substring(0, 55)}${pergunta.length > 55 ? '...' : ''}"`);
    
    try {
      const resposta = await getOptimizedAmandaResponse({
        content: pergunta,
        userText: pergunta,
        lead: makeFreshLead(msg.from),
        context: { 
          source: 'whatsapp-inbound',
          stage: 'novo',
          isReplay: true  // Flag importante!
        },
        messageId: `replay-${Date.now()}-${i}`,
      });
      
      const textoResposta = resposta?.text || resposta || '[SEM RESPOSTA]';
      
      results.push({
        id: i + 1,
        perguntaOriginal: pergunta,
        respostaAmanda: textoResposta,
        categoria: categoria,
        prioridade: prioridade,
        telefoneOriginal: msg.from,
        dataOriginal: msg.timestamp,
        tempoRespostaMs: Date.now() - startTime,
      });
      
      process.stdout.write(`     ✅ ${textoResposta.length} chars\n`);
      
    } catch (err) {
      console.log(`     ❌ ERRO: ${err.message.substring(0, 50)}`);
      results.push({
        id: i + 1,
        perguntaOriginal: pergunta,
        respostaAmanda: `[ERRO: ${err.message}]`,
        categoria: categoria,
        prioridade: prioridade,
        telefoneOriginal: msg.from,
        dataOriginal: msg.timestamp,
        erro: true,
      });
    }
    
    await new Promise(r => setTimeout(r, 150)); // Delay entre chamadas
  }
  
  // ═══════════════════════════════════════════════════════════
  // GERA RELATÓRIO
  // ═══════════════════════════════════════════════════════════
  
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const filename = `RELATORIO-REPLAY-${args.category || 'geral'}-${timestamp}.md`;
  const filepath = path.join(process.cwd(), 'tests-amanda-ouro', filename);
  
  if (!fs.existsSync(path.join(process.cwd(), 'tests-amanda-ouro'))) {
    fs.mkdirSync(path.join(process.cwd(), 'tests-amanda-ouro'));
  }
  
  // Estatísticas
  const stats = {
    total: results.length,
    porCategoria: {},
    porPrioridade: { CRITICA: 0, ALTA: 0, MEDIA: 0, BAIXA: 0 },
    erros: results.filter(r => r.erro).length
  };
  
  results.forEach(r => {
    stats.porCategoria[r.categoria] = (stats.porCategoria[r.categoria] || 0) + 1;
    stats.porPrioridade[r.prioridade]++;
  });
  
  let markdown = `# 🔥 RELATÓRIO REPLAY — Conversas Reais vs Amanda FSM V8

**Gerado em:** ${new Date().toLocaleString('pt-BR')}  
**Total de perguntas:** ${results.length}  
**Categoria:** ${args.category || 'Todas'}  
**Modo:** ${args.random ? 'Aleatório' : 'Mais recentes'}

---

## 📊 RESUMO POR CATEGORIA

`;
  
  Object.entries(stats.porCategoria)
    .sort((a, b) => b[1] - a[1])
    .forEach(([cat, count]) => {
      const catInfo = CATEGORIES[cat];
      const nome = catInfo ? catInfo.name : cat;
      markdown += `- **${nome}:** ${count} (${((count/results.length)*100).toFixed(1)}%)\n`;
    });
  
  markdown += `\n### Por Prioridade\n\n`;
  markdown += `- 🔴 Crítica: ${stats.porPrioridade.CRITICA}\n`;
  markdown += `- 🟠 Alta: ${stats.porPrioridade.ALTA}\n`;
  markdown += `- 🟡 Média: ${stats.porPrioridade.MEDIA}\n`;
  markdown += `- ⚪ Baixa: ${stats.porPrioridade.BAIXA}\n`;
  markdown += `- ❌ Erros: ${stats.erros}\n`;
  
  markdown += `\n---\n\n`;
  
  // Lista todas as conversas
  results.forEach((r, idx) => {
    const emojiPrioridade = {
      'CRITICA': '🔴',
      'ALTA': '🟠',
      'MEDIA': '🟡',
      'BAIXA': '⚪'
    }[r.prioridade] || '⚪';
    
    const catNome = CATEGORIES[r.categoria]?.name || r.categoria;
    
    markdown += `## ${idx + 1}. ${emojiPrioridade} [${r.categoria.toUpperCase()}]\n\n`;
    markdown += `**Categoria:** ${catNome}  \n`;
    markdown += `**Prioridade:** ${r.prioridade}\n\n`;
    markdown += `**👤 PERGUNTA REAL DO LEAD:**\n`;
    markdown += `\`\`\`\n${r.perguntaOriginal}\n\`\`\`\n\n`;
    markdown += `**🤖 RESPOSTA DA AMANDA:**\n`;
    markdown += `\`\`\`\n${r.respostaAmanda}\n\`\`\`\n\n`;
    
    if (r.erro) {
      markdown += `> ⚠️ **ERRO** na geração da resposta\n\n`;
    }
    
    markdown += `**📋 AVALIAÇÃO:**\n\n`;
    markdown += `- [ ] Excelente (enviaria assim)\n`;
    markdown += `- [ ] Boa (pequenos ajustes)\n`;
    markdown += `- [ ] Regular (precisa melhorar)\n`;
    markdown += `- [ ] Ruim (refazer totalmente)\n\n`;
    markdown += `**📝 Observações:**\n`;
    markdown += `\`\`\`\n[Anotar aqui o que precisa ajustar...]\n\`\`\`\n\n`;
    markdown += `**✏️ Sugestão de melhoria:**\n`;
    markdown += `\`\`\`\n[Como deveria responder idealmente...]\n\`\`\`\n\n`;
    markdown += `---\n\n`;
  });
  
  fs.writeFileSync(filepath, markdown);
  
  console.log(`\n${'═'.repeat(64)}`);
  console.log(`✅ REPLAY CONCLUÍDO!`);
  console.log(`${'═'.repeat(64)}`);
  console.log(`\n📄 Relatório salvo em:`);
  console.log(`   ${filepath}`);
  console.log(`\n📊 Resumo:`);
  console.log(`   • ${results.length} perguntas processadas`);
  console.log(`   • ${Object.keys(stats.porCategoria).length} categorias`);
  console.log(`   • ${stats.erros} erros`);
  console.log(`\n📈 Distribuição:`);
  Object.entries(stats.porCategoria)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .forEach(([cat, count]) => {
      const nome = CATEGORIES[cat]?.name || cat;
      console.log(`   • ${nome}: ${count}`);
    });
  
  console.log(`\n💡 Próximos passos:`);
  console.log(`   1. Abra o arquivo .md no VS Code`);
  console.log(`   2. Analise cada Q&A (pergunta vs resposta)`);
  console.log(`   3. Marque as checkboxes de avaliação`);
  console.log(`   4. Anote ajustes necessários`);
  console.log(`   5. Me mande o arquivo pra eu analisar!\n`);
  
  await mongoose.disconnect();
  process.exit(0);
}

run().catch(err => {
  console.error('\n💥 ERRO FATAL:', err);
  process.exit(1);
});
