/**
 * ZEUS RUN v3.0 — Executor Diário de Conteúdo
 *
 * Usa o ZEUS v3.0 para gerar roteiros orientados a conversão
 * baseados nos leads reais do dia.
 *
 * Mudanças v3.0:
 * - Passa estagio_jornada derivado da intenção do lead (não hardcoded como 'viral')
 * - Passa objecao_principal por subTema
 * - Gera os 4 tipos de roteiro (descoberta, consideracao, decisao, retargeting)
 *   em vez de sempre gerar o mesmo tipo
 */

import mongoose from 'mongoose';
import Lead from './models/Leads.js';
import { gerarRoteiro, detectarIntencaoLead } from './agents/zeus-video.js';
import logger from './utils/logger.js';
import fs from 'fs';
import path from 'path';

// Objeção mais provável por subTema (usada quando não há contexto suficiente do lead)
const OBJECAO_DEFAULT_SUBTEMA = {
  atraso_fala:                'e_fase',
  autismo:                    'talvez_exagero',
  comportamento:              'e_fase',
  teste_linguinha:            'talvez_exagero',
  avaliacao_neuropsicologica: 'e_preguica',
  coordenacao_motora:         'talvez_exagero',
  fisioterapia_infantil:      'talvez_exagero',
  psicomotricidade:           'talvez_exagero',
  geral:                      'e_fase',
};

// Mapeia intenção do lead → estágio de jornada
const INTENCAO_PARA_ESTAGIO = {
  acao:             'decisao',
  preocupacao:      'consideracao',
  comparacao:       'consideracao',
  duvida:           'descoberta',
  leve_curiosidade: 'descoberta',
  desconhecida:     'descoberta',
};

/**
 * Busca mensagens dos leads recentes (usa modelo Lead existente)
 */
async function buscarMensagensRecentes(dias = 1) {
  const dataCorte = new Date();
  dataCorte.setDate(dataCorte.getDate() - dias);

  const leads = await Lead.find({
    createdAt: { $gte: dataCorte },
    $or: [
      { lastMessage: { $exists: true, $ne: null } },
      { source: { $exists: true } },
    ],
  })
    .select('lastMessage source subTema tags createdAt')
    .limit(100)
    .sort({ createdAt: -1 })
    .lean();

  return leads
    .map(l => ({
      texto:   l.lastMessage || '',
      subTema: l.subTema || 'atraso_fala',
      tags:    l.tags || [],
      data:    l.createdAt,
    }))
    .filter(m => mensagemTemValor(m.texto));
}

function mensagemTemValor(texto) {
  if (!texto || texto.length < 10) return false;
  const palavras = texto.trim().split(/\s+/);
  if (palavras.length < 6) return false;
  const fracas = ['ok', 'valor', 'preço', 'horário', 'oi', 'olá', 'bom dia', 'boa tarde', 'boa noite'];
  if (fracas.some(f => texto.toLowerCase().trim() === f)) return false;
  const verbosContexto = ['não', 'tem', 'faz', 'fala', 'anda', 'come', 'dorme', 'chora', 'brinca',
    'joga', 'estuda', 'responde', 'olha', 'sente', 'fica', 'vai', 'quer', 'precisa',
    'acho', 'sei', 'vi', 'percebi', 'preocup', 'medo', 'angust'];
  return verbosContexto.some(v => texto.toLowerCase().includes(v)) || palavras.length >= 8;
}

/**
 * Agrupa mensagens por subTema e detecta intenção de cada uma
 */
function agruparPorTema(mensagens) {
  const grupos = {};

  mensagens.forEach(msg => {
    const tema = msg.subTema || 'atraso_fala';

    if (!grupos[tema]) {
      grupos[tema] = { tema, mensagens: [], total: 0, intencoes: {} };
    }

    const intencao = detectarIntencaoLead(msg.texto);

    grupos[tema].mensagens.push({
      texto:           msg.texto,
      intencao:        intencao.intencao,
      confianca:       intencao.confianca,
      estagio_sugerido: intencao.estagio_sugerido,
    });

    grupos[tema].total++;
    grupos[tema].intencoes[intencao.intencao] = (grupos[tema].intencoes[intencao.intencao] || 0) + 1;
  });

  return grupos;
}

/**
 * Determina o estágio de jornada dominante para um grupo de mensagens
 * (baseado na intenção mais frequente)
 */
function determinarEstagio(grupo) {
  const intencoes  = grupo.intencoes;
  const dominante  = Object.entries(intencoes).sort((a, b) => b[1] - a[1])[0]?.[0] || 'desconhecida';
  return INTENCAO_PARA_ESTAGIO[dominante] || 'descoberta';
}

/**
 * Seleciona a mensagem com maior confiança para usar como contextoLead
 */
function mensagemPrincipal(grupo) {
  return grupo.mensagens.sort((a, b) => b.confianca - a.confianca)[0];
}

function getTop3(grupos) {
  return Object.values(grupos)
    .sort((a, b) => b.total - a.total)
    .slice(0, 3);
}

/**
 * Gera roteiro para cada tema usando o ZEUS v3.0 com campos de conversão
 */
async function gerarRoteiros(top3) {
  const roteiros = [];

  for (const item of top3) {
    const msgPrincipal = mensagemPrincipal(item);
    const estagio      = determinarEstagio(item);
    const objecao      = OBJECAO_DEFAULT_SUBTEMA[item.tema] || 'e_fase';

    try {
      const resultado = await gerarRoteiro({
        subTema:           item.tema,
        estagio_jornada:   estagio,
        objecao_principal: objecao,
        contextoLead:      msgPrincipal?.texto || '',
        duracao:           estagio === 'decisao' ? 35 : 30,
        platform:          'instagram',
        tipo_conteudo:     estagio === 'decisao' ? 'conversao_direta' : 'aquisicao_organica',
      });

      roteiros.push({
        tema:     item.tema,
        volume:   item.total,
        estagio,
        objecao,
        intencao: msgPrincipal?.intencao || 'desconhecida',
        roteiro:  resultado.roteiro,
      });
    } catch (error) {
      logger.error(`[ZEUS-RUN] Erro ao gerar roteiro para ${item.tema}:`, error.message);
    }
  }

  return roteiros;
}

function mostrarOutput(roteiros) {
  console.log('\n');
  console.log('─'.repeat(55));
  console.log('  TOP DORES HOJE:');
  console.log('─'.repeat(55));
  console.log('');

  roteiros.forEach((r, i) => {
    console.log(`  ${i + 1}. ${r.tema} (${r.volume} leads) — estágio: ${r.estagio}`);
  });

  console.log('');
  console.log('─'.repeat(55));
  console.log('  ROTEIROS:');
  console.log('─'.repeat(55));
  console.log('');

  roteiros.forEach((r, i) => {
    const texto  = r.roteiro.texto_completo;
    const frases = texto.split(/[.!?]+/).filter(f => f.trim().length > 0);
    const ideia  = frases.slice(0, 2).join('. ') + '.';

    console.log(`  ${i + 1}. ${r.tema.toUpperCase()} [${r.estagio.toUpperCase()}]`);
    console.log(`  HOOK: "${r.roteiro.hook_texto_overlay}"`);
    console.log(`  IDEIA: ${ideia}`);
    console.log(`  CTA: "${r.roteiro.cta_texto_overlay}"`);
    console.log(`  OBJEÇÃO TRATADA: ${r.objecao}`);
    console.log(`  SCORE CONVERSÃO: ${r.roteiro._meta?.score_conversao ?? '—'}/100`);
    console.log('');
  });

  console.log('─'.repeat(55));
  console.log(`  GERADO: ${new Date().toLocaleString('pt-BR')}`);
  console.log('─'.repeat(55));
  console.log('');
}

function salvarJson(roteiros) {
  const dir = './outputs';
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  const data     = new Date().toISOString().split('T')[0];
  const filename = path.join(dir, `zeus-${data}.json`);

  const output = {
    data:       new Date().toISOString(),
    versao:     '3.0',
    totalLeads: roteiros.reduce((sum, r) => sum + r.volume, 0),
    roteiros,
  };

  fs.writeFileSync(filename, JSON.stringify(output, null, 2));
  console.log(`  Salvo em: ${filename}\n`);

  return filename;
}

async function executarZeusCompleto() {
  console.log('\n  ZEUS RUN v3.0 — iniciando...\n');

  try {
    if (mongoose.connection.readyState === 0) {
      const mongoUri = process.env.MONGO_URI || process.env.MONGODB_URI;
      if (!mongoUri) throw new Error('Variável MONGO_URI ou MONGODB_URI não definida no .env');
      await mongoose.connect(mongoUri);
      console.log('  MongoDB conectado\n');
    }

    console.log('  Buscando mensagens recentes...');
    const mensagens = await buscarMensagensRecentes(1);
    console.log(`  ${mensagens.length} mensagens encontradas\n`);

    if (mensagens.length === 0) {
      console.log('  Sem mensagens recentes para analisar\n');
      return;
    }

    console.log('  Analisando intenções e estágios de jornada...');
    const grupos = agruparPorTema(mensagens);
    console.log(`  ${Object.keys(grupos).length} temas identificados\n`);

    const top3    = getTop3(grupos);
    console.log('  Gerando roteiros orientados a conversão...\n');
    const roteiros = await gerarRoteiros(top3);

    mostrarOutput(roteiros);
    const arquivo = salvarJson(roteiros);

    console.log('  ZEUS RUN v3.0 concluído!\n');
    return { roteiros, arquivo };

  } catch (error) {
    console.error('  Erro:', error.message);
    logger.error('[ZEUS-RUN] Erro:', error.message);
    throw error;
  } finally {
    if (mongoose.connection.readyState !== 0) {
      await mongoose.disconnect();
    }
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  executarZeusCompleto()
    .then(() => process.exit(0))
    .catch(() => process.exit(1));
}

export { executarZeusCompleto };
export default { executarZeusCompleto };
