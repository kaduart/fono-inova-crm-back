/**
 * 📅 Calendário Temático GMB — 30 Dias
 * 
 * Objetivo: gerar notoriedade e ranqueamento local publicando posts diários
 * alinhados aos clusters de conteúdo do site (Fono, Neuro, Psico, Neuropsico)
 * e ao hub multidisciplinar.
 * 
 * Cada post do dia tem:
 * - tema específico (dor/decisão/autoridade)
 * - especialidade vinculada
 * - URL de destino existente no site
 * - ângulo emocional
 * - funil (top/middle/bottom)
 */

import * as gmbService from './gmbService.js';
import * as gmbABEngine from './gmbABEngine.js';
import GmbPost from '../models/GmbPost.js';
import GmbCalendarRun from '../models/GmbCalendarRun.js';

/**
 * 🗓️ Calendário de 30 dias — pode ser repetido mensalmente
 * Índice 0 = Dia 1, índice 29 = Dia 30
 */
export const CALENDARIO_GMB_30_DIAS = [
  // ═══════════════════════════════════════════════════════════════
  // SEMANA 1 — Consciência + decisão inicial
  // ═══════════════════════════════════════════════════════════════
  {
    dia: 1,
    tema: 'Criança de 2 anos não fala: quando procurar ajuda?',
    especialidadeId: 'fonoaudiologia',
    url: 'https://www.clinicafonoinova.com.br/artigos/crianca-nao-fala-idade-esperada',
    intencao: 'criança não fala idade esperada',
    angulo: 'duvida',
    funil: 'middle',
    tipo: 'dor'
  },
  {
    dia: 2,
    tema: 'Quando levar seu filho no neuropediatra?',
    especialidadeId: 'neuropediatria',
    url: 'https://www.clinicafonoinova.com.br/artigos/quando-procurar-neuropediatra',
    intencao: 'quando procurar neuropediatra',
    angulo: 'duvida',
    funil: 'middle',
    tipo: 'decisao'
  },
  {
    dia: 3,
    tema: 'Criança muito nervosa: pode ser sinal de ansiedade infantil?',
    especialidadeId: 'psicologia_infantil_anapolis',
    url: 'https://www.clinicafonoinova.com.br/artigos/crianca-muito-nervosa-precisa-psicologo',
    intencao: 'criança muito nervosa precisa psicologo',
    angulo: 'medo',
    funil: 'top',
    tipo: 'dor'
  },
  {
    dia: 4,
    tema: 'Seu filho esquece o que acabou de aprender?',
    especialidadeId: 'neuropsicologia',
    url: 'https://www.clinicafonoinova.com.br/artigos/quando-fazer-avaliacao-neuropsicologica',
    intencao: 'quando fazer avaliação neuropsicológica',
    angulo: 'duvida',
    funil: 'middle',
    tipo: 'decisao'
  },
  {
    dia: 5,
    tema: 'Como funciona a avaliação multidisciplinar infantil?',
    especialidadeId: 'avaliacao_neuropsicologica_anapolis',
    url: 'https://www.clinicafonoinova.com.br/artigos/avaliacao-multidisciplinar-infantil',
    intencao: 'avaliação multidisciplinar infantil',
    angulo: 'educacao',
    funil: 'middle',
    tipo: 'autoridade'
  },
  {
    dia: 6,
    tema: 'Troca de letras na criança: quando preocupar?',
    especialidadeId: 'fonoaudiologia',
    url: 'https://www.clinicafonoinova.com.br/artigos/troca-de-letras-quando-preocupar',
    intencao: 'troca de letras quando preocupar',
    angulo: 'duvida',
    funil: 'middle',
    tipo: 'decisao'
  },
  {
    dia: 7,
    tema: 'Sinais de TDAH que os pais confundem com mau comportamento',
    especialidadeId: 'tdah',
    url: 'https://www.clinicafonoinova.com.br/artigos/sinais-tdah-crianca',
    intencao: 'sinais de tdah criança',
    angulo: 'medo',
    funil: 'top',
    tipo: 'dor'
  },

  // ═══════════════════════════════════════════════════════════════
  // SEMANA 2 — Aprofundamento por cluster
  // ═══════════════════════════════════════════════════════════════
  {
    dia: 8,
    tema: 'Dificuldades emocionais na escola: o que fazer?',
    especialidadeId: 'psicologia_infantil_anapolis',
    url: 'https://www.clinicafonoinova.com.br/artigos/dificuldades-emocionais-na-escola',
    intencao: 'dificuldades emocionais na escola',
    angulo: 'identificacao',
    funil: 'middle',
    tipo: 'dor'
  },
  {
    dia: 9,
    tema: 'Teste de atenção infantil: como funciona?',
    especialidadeId: 'neuropsicologia',
    url: 'https://www.clinicafonoinova.com.br/artigos/teste-de-atencao-infantil',
    intencao: 'teste de atenção infantil',
    angulo: 'educacao',
    funil: 'middle',
    tipo: 'autoridade'
  },
  {
    dia: 10,
    tema: 'Neuropediatra diagnostica autismo?',
    especialidadeId: 'neuropediatria',
    url: 'https://www.clinicafonoinova.com.br/artigos/neuropediatra-diagnostica-autismo',
    intencao: 'neuropediatra diagnostica autismo',
    angulo: 'duvida',
    funil: 'middle',
    tipo: 'decisao'
  },
  {
    dia: 11,
    tema: 'Fonoaudiologia ajuda no autismo?',
    especialidadeId: 'fonoaudiologia',
    url: 'https://www.clinicafonoinova.com.br/artigos/fonoaudiologia-para-autismo',
    intencao: 'fonoaudiologia para autismo',
    angulo: 'esperanca',
    funil: 'middle',
    tipo: 'autoridade'
  },
  {
    dia: 12,
    tema: 'Avaliação neuropsicológica para dificuldade escolar',
    especialidadeId: 'neuropsicologia',
    url: 'https://www.clinicafonoinova.com.br/artigos/avaliacao-neuropsicologica-dificuldade-escolar',
    intencao: 'avaliação neuropsicológica dificuldade escolar',
    angulo: 'duvida',
    funil: 'middle',
    tipo: 'decisao'
  },
  {
    dia: 13,
    tema: 'Sinais de ansiedade infantil que passam despercebidos',
    especialidadeId: 'psicologia_infantil_anapolis',
    url: 'https://www.clinicafonoinova.com.br/artigos/sinais-ansiedade-infantil',
    intencao: 'sinais de ansiedade infantil',
    angulo: 'medo',
    funil: 'top',
    tipo: 'dor'
  },
  {
    dia: 14,
    tema: 'Avaliação multidisciplinar: a melhor forma de entender seu filho',
    especialidadeId: 'avaliacao_neuropsicologica_anapolis',
    url: 'https://www.clinicafonoinova.com.br/artigos/avaliacao-multidisciplinar-infantil',
    intencao: 'avaliação multidisciplinar infantil',
    angulo: 'educacao',
    funil: 'middle',
    tipo: 'autoridade'
  },

  // ═══════════════════════════════════════════════════════════════
  // SEMANA 3 — Conversão local + especificidades
  // ═══════════════════════════════════════════════════════════════
  {
    dia: 15,
    tema: 'Fonoaudiologia infantil em Anápolis: onde encontrar ajuda?',
    especialidadeId: 'fonoaudiologia_anapolis',
    url: 'https://www.clinicafonoinova.com.br/fonoaudiologia-anapolis',
    intencao: 'fonoaudiologia infantil anapolis',
    angulo: 'local',
    funil: 'bottom',
    tipo: 'decisao'
  },
  {
    dia: 16,
    tema: 'Psicólogo infantil em Anápolis: quando procurar?',
    especialidadeId: 'psicologia_infantil_anapolis',
    url: 'https://www.clinicafonoinova.com.br/psicologia-infantil-anapolis',
    intencao: 'psicólogo infantil anapolis',
    angulo: 'local',
    funil: 'bottom',
    tipo: 'decisao'
  },
  {
    dia: 17,
    tema: 'Avaliação neuropsicológica infantil em Anápolis',
    especialidadeId: 'avaliacao_neuropsicologica_anapolis',
    url: 'https://www.clinicafonoinova.com.br/avaliacao-neuropsicologica-anapolis',
    intencao: 'avaliação neuropsicológica infantil anapolis',
    angulo: 'local',
    funil: 'bottom',
    tipo: 'decisao'
  },
  {
    dia: 18,
    tema: 'Neuropediatra em Anápolis: consulta especializada',
    especialidadeId: 'neuropediatria_anapolis',
    url: 'https://www.clinicafonoinova.com.br/neuropediatra-anapolis',
    intencao: 'neuropediatra anapolis',
    angulo: 'local',
    funil: 'bottom',
    tipo: 'decisao'
  },
  {
    dia: 19,
    tema: 'Teste de memória infantil: como avalia a memória da criança?',
    especialidadeId: 'neuropsicologia',
    url: 'https://www.clinicafonoinova.com.br/artigos/teste-de-memoria-infantil',
    intencao: 'teste de memória infantil',
    angulo: 'educacao',
    funil: 'middle',
    tipo: 'autoridade'
  },
  {
    dia: 20,
    tema: 'Avaliação das funções executivas na infância',
    especialidadeId: 'neuropsicologia',
    url: 'https://www.clinicafonoinova.com.br/artigos/avaliacao-das-funcoes-executivas',
    intencao: 'avaliação funções executivas criança',
    angulo: 'educacao',
    funil: 'middle',
    tipo: 'autoridade'
  },
  {
    dia: 21,
    tema: 'Atraso no desenvolvimento infantil: o que fazer?',
    especialidadeId: 'neuropediatria',
    url: 'https://www.clinicafonoinova.com.br/artigos/atraso-desenvolvimento-infantil',
    intencao: 'atraso desenvolvimento infantil',
    angulo: 'medo',
    funil: 'middle',
    tipo: 'dor'
  },

  // ═══════════════════════════════════════════════════════════════
  // SEMANA 4 — Reforço de autoridade + recorrência
  // ═══════════════════════════════════════════════════════════════
  {
    dia: 22,
    tema: 'Como entender o laudo neuropsicológico infantil?',
    especialidadeId: 'neuropsicologia',
    url: 'https://www.clinicafonoinova.com.br/artigos/como-entender-laudo-neuropsicologico',
    intencao: 'como entender laudo neuropsicológico',
    angulo: 'educacao',
    funil: 'middle',
    tipo: 'autoridade'
  },
  {
    dia: 23,
    tema: 'Fonoaudiologia para dificuldade escolar',
    especialidadeId: 'fonoaudiologia',
    url: 'https://www.clinicafonoinova.com.br/artigos/fonoaudiologia-para-dificuldade-escolar',
    intencao: 'fonoaudiologia dificuldade escolar',
    angulo: 'duvida',
    funil: 'middle',
    tipo: 'decisao'
  },
  {
    dia: 24,
    tema: 'Diferença entre avaliação neuropsicológica e psicopedagógica',
    especialidadeId: 'neuropsicologia',
    url: 'https://www.clinicafonoinova.com.br/artigos/avaliacao-neuropsicologica-e-psicopedagogica',
    intencao: 'avaliação neuropsicológica vs psicopedagógica',
    angulo: 'comparacao',
    funil: 'middle',
    tipo: 'autoridade'
  },
  {
    dia: 25,
    tema: 'Quanto tempo dura a avaliação neuropsicológica infantil?',
    especialidadeId: 'neuropsicologia',
    url: 'https://www.clinicafonoinova.com.br/artigos/quanto-tempo-dura-avaliacao-neuropsicologica',
    intencao: 'quanto tempo dura avaliação neuropsicológica',
    angulo: 'duvida',
    funil: 'middle',
    tipo: 'decisao'
  },
  {
    dia: 26,
    tema: 'Como funciona a avaliação neuropsicológica infantil?',
    especialidadeId: 'neuropsicologia',
    url: 'https://www.clinicafonoinova.com.br/artigos/como-funciona-avaliacao-neuropsicologica',
    intencao: 'como funciona avaliação neuropsicológica',
    angulo: 'educacao',
    funil: 'top',
    tipo: 'autoridade'
  },
  {
    dia: 27,
    tema: 'Sinais de autismo na infância: o que observar?',
    especialidadeId: 'autismo',
    url: 'https://www.clinicafonoinova.com.br/artigos/sinais-autismo-crianca',
    intencao: 'sinais de autismo na infância',
    angulo: 'medo',
    funil: 'top',
    tipo: 'dor'
  },
  {
    dia: 28,
    tema: 'TDAH infantil: como a avaliação neuropsicológica ajuda?',
    especialidadeId: 'tdah',
    url: 'https://www.clinicafonoinova.com.br/artigos/avaliacao-neuropsicologica-para-tdah',
    intencao: 'avaliação neuropsicológica TDAH',
    angulo: 'duvida',
    funil: 'middle',
    tipo: 'decisao'
  },
  {
    dia: 29,
    tema: 'Avaliação neuropsicológica para autismo: como ajuda?',
    especialidadeId: 'autismo',
    url: 'https://www.clinicafonoinova.com.br/artigos/avaliacao-neuropsicologica-para-autismo',
    intencao: 'avaliação neuropsicológica autismo',
    angulo: 'esperanca',
    funil: 'middle',
    tipo: 'autoridade'
  },
  {
    dia: 30,
    tema: 'Clínica multidisciplinar infantil em Anápolis',
    especialidadeId: 'avaliacao_neuropsicologica_anapolis',
    url: 'https://www.clinicafonoinova.com.br/abordagem-multidisciplinar',
    intencao: 'clínica multidisciplinar infantil anapolis',
    angulo: 'local',
    funil: 'bottom',
    tipo: 'decisao'
  }
];

/**
 * 📌 Retorna o post do dia baseado no dia do mês (1-30)
 * Se o dia for 31, retorna o post do dia 30.
 */
export function getPostDoDia(dia = null) {
  const hoje = new Date();
  const diaDoMes = dia || hoje.getDate();
  const indice = Math.min(Math.max(diaDoMes, 1), 30) - 1;
  return CALENDARIO_GMB_30_DIAS[indice];
}

/**
 * 🔍 Encontra especialidade no array exportado pelo gmbService
 */
function findEspecialidade(especialidadeId) {
  // Importação dinâmica para evitar problemas de ordem de importação
  const { ESPECIALIDADES } = gmbService;
  return ESPECIALIDADES.find(e => e.id === especialidadeId) || ESPECIALIDADES[0];
}

/**
 * 📅 Formata data como YYYY-MM-DD
 */
function formatDateKey(date) {
  return date.toISOString().split('T')[0];
}

/**
 * ✅ Idempotência: verifica se já existe execução do calendário para a data
 * Usa chave única `date` no modelo GmbCalendarRun
 */
async function jaExisteExecucaoCalendario(dateKey) {
  const run = await GmbCalendarRun.findOne({ date: dateKey }).lean();
  if (!run) return false;

  // Só considera duplicado se a execução foi bem-sucedida ou está rodando
  return ['success', 'running'].includes(run.status);
}

/**
 * ✅ Verifica se já existe um post do calendário para o dia
 * Segunda camada de proteção além da execução
 */
async function jaExistePostCalendarioHoje() {
  const hoje = new Date();
  hoje.setHours(0, 0, 0, 0);
  const amanha = new Date(hoje);
  amanha.setDate(amanha.getDate() + 1);

  const count = await GmbPost.countDocuments({
    createdAt: { $gte: hoje, $lt: amanha },
    status: { $in: ['ready', 'scheduled', 'published', 'processing'] },
    tags: 'calendario-tematico'
  });

  return count > 0;
}

/**
 * 🚀 Cria o post do calendário para hoje
 * 
 * Lifecycle:
 * 1. Registra execução como 'running'
 * 2. Cria post no status 'scheduled'
 * 3. Enriquece metadados do calendário
 * 4. Atualiza execução para 'success' ou 'failed'
 */
export async function createTodaysCalendarPost(options = {}) {
  const startTime = Date.now();
  const execDate = options.scheduledAt ? new Date(options.scheduledAt) : new Date();
  const dateKey = formatDateKey(execDate);
  const item = getPostDoDia(options.dia || execDate.getDate());

  if (!item) {
    throw new Error('Item do calendário não encontrado');
  }

  // 🛡️ IDEMPOTÊNCIA: evita duplicar execução do mesmo dia
  if (!options.skipDuplicateCheck && await jaExisteExecucaoCalendario(dateKey)) {
    console.log(`ℹ️ [GMB Calendário] Execução de ${dateKey} já realizada, pulando`);
    return null;
  }

  // 🛡️ SEGUNDA CAMADA: evita duplicar post no banco
  if (!options.skipDuplicateCheck && await jaExistePostCalendarioHoje()) {
    console.log('ℹ️ [GMB Calendário] Post do dia já existe no banco, pulando');
    return null;
  }

  // 🧪 Seleciona variante A/B para o tema (antes de criar o run)
  const selectedVariant = await gmbABEngine.selectVariant(item);
  console.log(`🧪 [A/B] Variante selecionada para "${item.tema}": ${selectedVariant.variant} (${selectedVariant.label})`);

  // 📝 Registra execução como 'running'
  const run = await GmbCalendarRun.create({
    date: dateKey,
    calendarDay: item.dia,
    status: 'running',
    triggeredBy: options.triggeredBy || 'cron',
    payload: {
      tema: item.tema,
      especialidadeId: item.especialidadeId,
      url: item.url,
      funil: item.funil,
      angulo: item.angulo,
      tipo: item.tipo,
      abVariant: selectedVariant.variant,
      abLabel: selectedVariant.label
    }
  });

  try {
    const especialidade = findEspecialidade(item.especialidadeId);
    const scheduledAt = options.scheduledAt || new Date();

    // Garante que scheduledAt não seja no passado
    if (scheduledAt < new Date()) {
      scheduledAt.setHours(9, 0, 0, 0);
      if (scheduledAt < new Date()) {
        scheduledAt.setDate(scheduledAt.getDate() + 1);
      }
    }

    const result = await gmbService.createDailyPost({
      especialidade,
      customTheme: selectedVariant.customTheme,
      funnelStage: item.funil,
      generateImage: true,
      scheduledAt,
      publishedBy: 'cron',
      ...options
    });

    if (result?.post) {
      // 🏷️ Enriquece metadados do calendário
      result.post.tags = [
        ...(result.post.tags || []),
        'calendario-tematico',
        item.tipo,
        item.angulo,
        `variant-${selectedVariant.variant}`
      ];
      result.post.campaign = 'calendario-tematico-30-dias';
      result.post.landingPageUrl = item.url;
      result.post.landingPageRef = item.url.replace('https://www.clinicafonoinova.com.br/', '');
      result.post.metadata = {
        ...(result.post.metadata || {}),
        calendarioDia: item.dia,
        calendarioIntencao: item.intencao,
        calendarioAngulo: item.angulo,
        calendarioTipo: item.tipo,
        calendarRunId: run._id,
        abVariant: selectedVariant.variant,
        abLabel: selectedVariant.label,
        abThemeKey: gmbABEngine.getThemeKey(item)
      };
      await result.post.save();

      // 🧪 Registra o teste A/B
      const abTest = await gmbABEngine.recordABTest({
        item,
        variant: selectedVariant,
        postId: result.post._id,
        date: dateKey
      });

      // Linka o teste no post
      result.post.metadata.abTestId = abTest._id;
      await result.post.save();

      // ✅ Atualiza execução para sucesso
      run.status = 'success';
      run.postsCreated = [{
        postId: result.post._id,
        tema: item.tema,
        especialidadeId: item.especialidadeId,
        url: item.url,
        funnelStage: item.funil
      }];
      run.postsCount = 1;
      run.durationMs = Date.now() - startTime;
      await run.save();

      console.log(`✅ [GMB Calendário] Post criado em ${run.durationMs}ms: ${item.tema}`);
      return result;
    }

    // ⚠️ Não gerou post, mas também não deu erro
    run.status = 'skipped';
    run.durationMs = Date.now() - startTime;
    await run.save();
    return null;

  } catch (error) {
    // ❌ Registra falha na execução
    run.status = 'failed';
    run.error = {
      message: error.message,
      stack: error.stack
    };
    run.durationMs = Date.now() - startTime;
    await run.save();

    console.error(`❌ [GMB Calendário] Erro ao criar post de ${dateKey}:`, error.message);
    throw error;
  }
}

/**
 * 🔄 Cria posts do calendário para vários dias à frente
 */
export async function createCalendarPostsForUpcomingDays(dias = 7) {
  const resultados = [];
  const hoje = new Date();

  for (let i = 0; i < dias; i++) {
    const data = new Date(hoje);
    data.setDate(data.getDate() + i);
    const diaDoMes = data.getDate();
    const scheduledAt = new Date(data);
    scheduledAt.setHours(9, 0, 0, 0);

    try {
      const result = await createTodaysCalendarPost({
        dia: diaDoMes,
        scheduledAt,
        skipDuplicateCheck: i > 0, // Só verifica duplicidade para hoje
        triggeredBy: 'manual'
      });
      resultados.push({
        dia: diaDoMes,
        date: formatDateKey(scheduledAt),
        success: !!result,
        tema: result?.post?.title || null
      });
    } catch (error) {
      resultados.push({
        dia: diaDoMes,
        date: formatDateKey(scheduledAt),
        success: false,
        error: error.message
      });
    }
  }

  return resultados;
}

/**
 * 📊 Retorna histórico de execuções do calendário
 */
export async function getCalendarRuns(limit = 30) {
  return await GmbCalendarRun.find()
    .sort({ createdAt: -1 })
    .limit(limit)
    .lean();
}

export default {
  CALENDARIO_GMB_30_DIAS,
  getPostDoDia,
  createTodaysCalendarPost,
  createCalendarPostsForUpcomingDays,
  getCalendarRuns
};
