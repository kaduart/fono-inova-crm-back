#!/usr/bin/env node
/**
 * 🔄 Conversor de Conversas Reais → Cenários de Teste
 * 
 * Processa conversas reais de WhatsApp e gera cenários de teste automatizados.
 * Usa o mesmo formato dos scripts de mineração de padrões.
 * 
 * Uso:
 *   node scripts/converter-conversas-cenarios.js [arquivo.json]
 *   node scripts/converter-conversas-cenarios.js  (converte todas)
 */

import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CONVERSAS_DIR = path.join(__dirname, 'amanda');
const OUTPUT_DIR = path.join(__dirname, '..', 'back', 'tests', 'conversas-reais', 'gerados');

// ============================================
// 🔍 PATTERNS DE DETECÇÃO
// ============================================
const PADROES = {
  saudacao: /\b(oi|olá|ola|bom dia|boa tarde|boa noite|hey|ei|oi amanda|olá amanda)\b/i,
  idade: /\b(\d+)\s*(?:anos?|a)\b/i,
  nome: /\b(?:meu filho|minha filha|ele|ela|paciente|criança)\s+(?:se\s+)?chama\s+(\w+)|\b(?:sou|me chamo)\s+(\w+)\b/i,
  queixa: /\b(não fala|fala pouco|não anda|comportamento|birra|não obedece|dificuldade|atraso|autismo|tea|tdah)\b/i,
  area: /\b(fono|fisioterapia|psicologia|to|terapia ocupacional|neuro|neuropsicologia)\b/i,
  preco: /\b(caro|valor|preço|quanto custa|2000|mil|reais|r\$)\b/i,
  desistencia: /\b(vou pensar|depois|não posso|não vou|tá caro|muito caro|não tenho)\b/i,
  agendamento: /\b(agendar|marcar|quando|disponível|horário|consulta)\b/i
};

const INTENCOES = {
  'saudacao': ['Oi', 'Tudo bem', 'Como posso ajudar'],
  'idade': ['entendi', 'anos', 'vou anotar'],
  'nome': ['prazer', 'nome', 'anotado'],
  'queixa': ['entendo', 'preocupação', 'podemos ajudar', 'tratamento'],
  'area': ['vamos', 'área', 'agendar'],
  'preco': ['entendo', 'investimento', 'parcelamento', 'cartão'],
  'desistencia': ['sem problema', 'entendo', 'aqui', 'quando quiser'],
  'agendamento': ['disponível', 'datas', 'horários']
};

// ============================================
// 📦 CARREGADOR
// ============================================
async function carregarConversas() {
  const conversas = [];
  
  try {
    const arquivos = await fs.readdir(CONVERSAS_DIR);
    const jsonFiles = arquivos.filter(f => f.endsWith('.json'));
    
    console.log(`📂 Encontrados ${jsonFiles.length} arquivos`);
    
    for (const arquivo of jsonFiles.slice(0, 50)) { // Limita a 50 para começar
      try {
        const conteudo = await fs.readFile(path.join(CONVERSAS_DIR, arquivo), 'utf-8');
        const dados = JSON.parse(conteudo);
        dados._arquivo = arquivo;
        conversas.push(dados);
      } catch (e) {
        console.log(`⚠️ Erro em ${arquivo}: ${e.message}`);
      }
    }
  } catch (e) {
    console.log(`❌ Erro ao ler diretório: ${e.message}`);
  }
  
  return conversas;
}

// ============================================
// 🧠 ANALISADOR DE CONVERSA
// ============================================
function analisarConversa(conversa) {
  const mensagens = [];
  let intencaoPrincipal = null;
  let temPreco = false;
  let temDesistencia = false;
  let nomePaciente = null;
  let idadePaciente = null;
  let areaDefinida = null;
  
  for (const msg of conversa.messages || []) {
    const texto = msg.text?.toLowerCase() || '';
    const isUser = msg.isUser;
    
    const msgAnalise = {
      ordem: mensagens.length + 1,
      tipo: isUser ? 'usuario' : 'amanda',
      texto: msg.text,
      intencoes: [],
      entidades: {}
    };
    
    // Detecta intenções
    for (const [tipo, regex] of Object.entries(PADROES)) {
      if (regex.test(texto)) {
        msgAnalise.intencoes.push(tipo);
        
        if (tipo === 'preco') temPreco = true;
        if (tipo === 'desistencia') temDesistencia = true;
        if (tipo === 'area' && isUser) areaDefinida = true;
      }
    }
    
    // Extrai entidades
    const idadeMatch = texto.match(PADROES.idade);
    if (idadeMatch && isUser) {
      msgAnalise.entidades.idade = parseInt(idadeMatch[1]);
      idadePaciente = parseInt(idadeMatch[1]);
    }
    
    const nomeMatch = texto.match(/(?:meu filho|minha filha|ele|ela|paciente)\s+(?:se\s+)?chama\s+(\w+)/i);
    if (nomeMatch && isUser) {
      msgAnalise.entidades.nome = nomeMatch[1];
      nomePaciente = nomeMatch[1];
    }
    
    mensagens.push(msgAnalise);
  }
  
  // Classifica tipo de conversa
  let tipo = 'fluxo-normal';
  if (temPreco && temDesistencia) tipo = 'objecao-preco';
  else if (temDesistencia) tipo = 'desistencia';
  else if (!areaDefinida && mensagens.length > 4) tipo = 'nao-qualificou';
  
  return {
    arquivo: conversa._arquivo,
    tipo,
    mensagens,
    nomePaciente,
    idadePaciente,
    resumo: conversa.analysis?.resumo || 'Sem resumo'
  };
}

// ============================================
// 🎬 GERADOR DE CENÁRIO
// ============================================
function gerarCenario(analise) {
  const msgsUsuario = analise.mensagens.filter(m => m.tipo === 'usuario');
  const msgsAmanda = analise.mensagens.filter(m => m.tipo === 'amanda');
  
  // Cria cenário apenas se tiver pelo menos 2 mensagens do usuário
  if (msgsUsuario.length < 2) return null;
  
  // Lead inicial
  const leadInicial = {
    patientInfo: {}
  };
  if (analise.nomePaciente) leadInicial.patientInfo.fullName = analise.nomePaciente;
  if (analise.idadePaciente) leadInicial.patientInfo.age = analise.idadePaciente;
  
  // Constrói mensagens esperadas
  const mensagensTeste = [];
  
  msgsUsuario.forEach((msg, idx) => {
    const esperado = {
      scoreMinimo: 6
    };
    
    // Define expectativas baseadas na intenção
    if (msg.intencoes.includes('saudacao')) {
      esperado.respostaContem = ['Oi', 'tudo', 'ajudar'];
      esperado.empatia = true;
    }
    if (msg.intencoes.includes('preco')) {
      esperado.respostaContem = ['entendo', 'investimento', 'parcelamento'];
      esperado.naoDeveConter = ['barato', 'só hoje'];
      esperado.empatia = true;
      esperado.scoreMinimo = 8;
    }
    if (msg.intencoes.includes('desistencia')) {
      esperado.respostaContem = ['sem problema', 'entendo'];
      esperado.naoDeveConter = ['corre', 'última chance', 'promoção'];
      esperado.empatia = true;
      esperado.scoreMinimo = 9;
    }
    
    mensagensTeste.push({
      ordem: idx + 1,
      tipo: 'usuario',
      texto: msg.texto,
      intencao: msg.intencoes[0] || 'desconhecida',
      esperado
    });
  });
  
  return {
    nome: `Conversa Real: ${analise.tipo} - ${analise.arquivo.replace('.json', '')}`,
    descricao: `Gerado automaticamente de conversa real. ${analise.resumo.substring(0, 100)}`,
    tags: [analise.tipo, 'gerado-automaticamente'],
    fonte: analise.arquivo,
    leadInicial,
    mensagens: mensagensTeste,
    _gerado: new Date().toISOString()
  };
}

// ============================================
// 💾 SALVADOR
// ============================================
async function salvarCenarios(cenarios) {
  await fs.mkdir(OUTPUT_DIR, { recursive: true });
  
  const grupos = {};
  
  for (const cenario of cenarios) {
    if (!cenario) continue;
    
    const tipo = cenario.tags[0] || 'outros';
    if (!grupos[tipo]) grupos[tipo] = [];
    grupos[tipo].push(cenario);
  }
  
  // Salva em arquivos separados por tipo
  for (const [tipo, lista] of Object.entries(grupos)) {
    const arquivo = path.join(OUTPUT_DIR, `${tipo}-${Date.now()}.json`);
    await fs.writeFile(arquivo, JSON.stringify(lista, null, 2));
    console.log(`  💾 ${tipo}: ${lista.length} cenários → ${path.basename(arquivo)}`);
  }
}

// ============================================
// 🚀 MAIN
// ============================================
async function main() {
  console.log('🔄 Conversor de Conversas → Cenários de Teste\n');
  
  // Verifica se diretório existe
  try {
    await fs.access(CONVERSAS_DIR);
  } catch {
    console.log(`❌ Diretório não encontrado: ${CONVERSAS_DIR}`);
    return;
  }
  
  // Carrega conversas
  console.log('📂 Carregando conversas...');
  const conversas = await carregarConversas();
  console.log(`✅ ${conversas.length} conversas carregadas\n`);
  
  // Analisa e gera cenários
  console.log('🧠 Analisando conversas...');
  const cenariGerados = [];
  
  for (const conversa of conversas) {
    const analise = analisarConversa(conversa);
    const cenario = gerarCenario(analise);
    if (cenario) cenariGerados.push(cenario);
  }
  
  console.log(`✅ ${cenariGerados.length} cenários gerados\n`);
  
  // Salva
  console.log('💾 Salvando cenários...');
  await salvarCenarios(cenariGerados);
  
  console.log('\n🎉 Pronto!');
  console.log(`\n📁 Para rodar os testes:`);
  console.log(`   node back/tests/conversas-reais/executar-testes.js --all`);
}

main().catch(console.error);
