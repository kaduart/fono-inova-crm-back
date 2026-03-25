/**
 * 🎬 ZEUS RUN — Executor Diário de Conteúdo
 * 
 * Usa o ZEUS para gerar roteiros baseados nos leads reais do dia
 * ZERO lógica nova, apenas orquestração do que já existe
 */

import mongoose from 'mongoose';
import Lead from './models/Leads.js';
import { gerarRoteiro, detectarIntencaoLead } from './agents/zeus-video.js';
import logger from './utils/logger.js';
import fs from 'fs';
import path from 'path';

/**
 * Busca mensagens dos leads recentes
 * Usa o modelo Lead que já existe
 */
async function buscarMensagensRecentes(dias = 1) {
  const dataCorte = new Date();
  dataCorte.setDate(dataCorte.getDate() - dias);
  
  const leads = await Lead.find({
    createdAt: { $gte: dataCorte },
    $or: [
      { lastMessage: { $exists: true, $ne: null } },
      { source: { $exists: true } }
    ]
  })
  .select('lastMessage source subTema tags createdAt')
  .limit(100)
  .sort({ createdAt: -1 })
  .lean();

  return leads.map(l => ({
    texto: l.lastMessage || '',
    subTema: l.subTema || 'atraso_fala',
    tags: l.tags || [],
    data: l.createdAt
  })).filter(m => mensagemTemValor(m.texto));
}

/**
 * Filtro simples: ignora mensagens fracas
 * Regra: mínimo 6 palavras OU conter verbo + contexto
 */
function mensagemTemValor(texto) {
  if (!texto || texto.length < 10) return false;
  
  const palavras = texto.trim().split(/\s+/);
  if (palavras.length < 6) return false;
  
  // Ignora mensagens genéricas de uma palavra
  const fracas = ['ok', 'valor', 'preço', 'horário', 'oi', 'olá', 'bom dia', 'boa tarde', 'boa noite'];
  if (fracas.some(f => texto.toLowerCase().trim() === f)) return false;
  
  // Precisa ter verbo indicativo de contexto
  const verbosContexto = ['não', 'tem', 'faz', 'fala', 'anda', 'come', 'dorme', 'chora', 'brinca', 'joga', 'estuda', 'responde', 'olha', 'sente', 'fica', 'vai', 'quer', 'precisa', 'acho', 'sei', 'vi', 'percebi'];
  const temVerbo = verbosContexto.some(v => texto.toLowerCase().includes(v));
  
  return temVerbo || palavras.length >= 8;
}

/**
 * Agrupa mensagens por subTema e detecta intenção
 * Usa detectarIntencaoLead que já existe no ZEUS
 */
function agruparPorTema(mensagens) {
  const grupos = {};
  
  mensagens.forEach(msg => {
    const tema = msg.subTema || 'atraso_fala';
    
    if (!grupos[tema]) {
      grupos[tema] = {
        tema,
        mensagens: [],
        intencoes: {},
        total: 0
      };
    }
    
    // Detecta intenção usando função existente
    const intencao = detectarIntencaoLead(msg.texto);
    
    grupos[tema].mensagens.push({
      texto: msg.texto,
      intencao: intencao.intencao,
      confianca: intencao.confianca
    });
    
    grupos[tema].total++;
    
    // Conta intenções
    if (!grupos[tema].intencoes[intencao.intencao]) {
      grupos[tema].intencoes[intencao.intencao] = 0;
    }
    grupos[tema].intencoes[intencao.intencao]++;
  });
  
  return grupos;
}

/**
 * Ordena por volume e pega TOP 3
 */
function getTop3(grupos) {
  return Object.values(grupos)
    .sort((a, b) => b.total - a.total)
    .slice(0, 3);
}

/**
 * Gera roteiro para cada tema usando gerarRoteiro que já existe
 */
async function gerarRoteiros(top3) {
  const roteiros = [];
  
  for (const item of top3) {
    // Pega a mensagem mais confiante para contexto
    const msgPrincipal = item.mensagens.sort((a, b) => b.confianca - a.confianca)[0];
    
    try {
      const resultado = await gerarRoteiro({
        subTema: item.tema,
        contextoLead: msgPrincipal?.texto || '',
        duracao: 30,
        platform: 'instagram',
        intensidade: 'viral'
      });
      
      roteiros.push({
        tema: item.tema,
        volume: item.total,
        intencao: msgPrincipal?.intencao || 'preocupacao',
        roteiro: resultado.roteiro
      });
    } catch (error) {
      logger.error(`[ZEUS-RUN] Erro ao gerar roteiro para ${item.tema}:`, error.message);
    }
  }
  
  return roteiros;
}

/**
 * Mostra output no console formatado
 */
function mostrarOutput(roteiros) {
  console.log('\n');
  console.log('─'.repeat(50));
  console.log('  TOP DORES HOJE:');
  console.log('─'.repeat(50));
  console.log('');
  
  roteiros.forEach((r, i) => {
    console.log(`  ${i + 1}. ${r.tema} (${r.volume} leads)`);
  });
  
  console.log('');
  console.log('─'.repeat(50));
  console.log('  ROTEIROS:');
  console.log('─'.repeat(50));
  console.log('');
  
  roteiros.forEach((r, i) => {
    const texto = r.roteiro.texto_completo;
    const frases = texto.split(/[.!?]+/).filter(f => f.trim().length > 0);
    const ideia = frases.slice(0, 2).join('. ') + '.';
    
    console.log(`  ${i + 1}. ${r.tema.toUpperCase()}`);
    console.log(`  HOOK: "${r.roteiro.hook_texto_overlay}"`);
    console.log(`  IDEIA: ${ideia}`);
    console.log(`  CTA: "${r.roteiro.cta_texto_overlay}"`);
    console.log(`  INTENÇÃO: ${r.intencao}`);
    console.log('');
  });
  
  console.log('─'.repeat(50));
  console.log(`  GERADO: ${new Date().toLocaleString('pt-BR')}`);
  console.log('─'.repeat(50));
  console.log('');
}

/**
 * Salva JSON no arquivo
 */
function salvarJson(roteiros) {
  const dir = './outputs';
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  
  const data = new Date().toISOString().split('T')[0];
  const filename = path.join(dir, `zeus-${data}.json`);
  
  const output = {
    data: new Date().toISOString(),
    totalLeads: roteiros.reduce((sum, r) => sum + r.volume, 0),
    roteiros
  };
  
  fs.writeFileSync(filename, JSON.stringify(output, null, 2));
  console.log(`  💾 Salvo em: ${filename}\n`);
  
  return filename;
}

/**
 * FUNÇÃO PRINCIPAL — Executa o fluxo completo
 * Usa apenas funções que já existem no sistema
 */
async function executarZeusCompleto() {
  console.log('\n  🎬 Iniciando ZEUS RUN...\n');
  
  try {
    // Conecta ao Mongo se não estiver conectado
    if (mongoose.connection.readyState === 0) {
      const mongoUri = process.env.MONGO_URI || process.env.MONGODB_URI;
      if (!mongoUri) {
        throw new Error('Variável MONGO_URI ou MONGODB_URI não definida no .env');
      }
      await mongoose.connect(mongoUri);
      console.log('  ✅ MongoDB conectado\n');
    }
    
    // 1. Busca mensagens (usa modelo Lead existente)
    console.log('  📥 Buscando mensagens recentes...');
    const mensagens = await buscarMensagensRecentes(1);
    console.log(`  ✅ ${mensagens.length} mensagens encontradas\n`);
    
    if (mensagens.length === 0) {
      console.log('  ⚠️  Sem mensagens recentes para analisar\n');
      return;
    }
    
    // 2. Agrupa por tema (usa detectarIntencaoLead existente)
    console.log('  🧠 Analisando intenções...');
    const grupos = agruparPorTema(mensagens);
    console.log(`  ✅ ${Object.keys(grupos).length} temas identificados\n`);
    
    // 3. Ordena e pega TOP 3
    const top3 = getTop3(grupos);
    
    // 4. Gera roteiros (usa gerarRoteiro existente)
    console.log('  📝 Gerando roteiros...\n');
    const roteiros = await gerarRoteiros(top3);
    
    // 5. Mostra no console
    mostrarOutput(roteiros);
    
    // 6. Salva JSON
    const arquivo = salvarJson(roteiros);
    
    console.log('  ✅ ZEUS RUN concluído!\n');
    
    return { roteiros, arquivo };
    
  } catch (error) {
    console.error('  ❌ Erro:', error.message);
    logger.error('[ZEUS-RUN] Erro:', error.message);
    throw error;
  } finally {
    // Fecha conexão se abrimos
    if (mongoose.connection.readyState !== 0) {
      await mongoose.disconnect();
    }
  }
}

// Executa se rodar diretamente
if (import.meta.url === `file://${process.argv[1]}`) {
  executarZeusCompleto()
    .then(() => process.exit(0))
    .catch(() => process.exit(1));
}

export { executarZeusCompleto };
export default { executarZeusCompleto };
