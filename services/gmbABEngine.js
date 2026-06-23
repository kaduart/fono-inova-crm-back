import GmbABTest from '../models/GmbABTest.js';

/**
 * 🧪 A/B Engine para Calendário Temático GMB
 * 
 * Regras:
 * - 2 variações por tema: A (educativo/autoridade) e B (emocional/conversão)
 * - Seleção inicial: round-robin por tema
 * - Depois de dados suficientes: favorece variante com mais WhatsApp clicks
 * - Mantém 20% de exploração mesmo após convergência
 */

const EXPLORATION_RATE = 0.20;
const MIN_SAMPLES_FOR_EXPLOITATION = 4; // 2 de A + 2 de B

/**
 * 📝 Gera as duas variações de copy para um tema
 */
export function generateVariants(item) {
  const temaBase = item.tema;

  return {
    A: {
      variant: 'A',
      label: 'educativo',
      customTheme: `EDUCATIVO: "${temaBase}" — explique de forma clara e técnica, como um especialista orientando pais. Foque em informação valiosa, sem alarmismo.`,
      angulo: item.angulo || 'educacao'
    },
    B: {
      variant: 'B',
      label: 'emocional-conversao',
      customTheme: `EMOCIONAL: "${temaBase}" — fale diretamente com a dor do pai/mãe. Use empatia, urgência leve e CTA claro para WhatsApp.`,
      angulo: 'conversao'
    }
  };
}

/**
 * 🔑 Gera chave única do tema (slug simples)
 */
export function getThemeKey(item) {
  return item.tema
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '')
    .substring(0, 80);
}

/**
 * 📊 Busca histórico de performance de uma variante para um tema
 */
async function getVariantStats(themeKey, variant) {
  const tests = await GmbABTest.find({ themeKey, variant }).lean();

  const totals = tests.reduce((acc, t) => {
    acc.views += t.metrics?.views || 0;
    acc.whatsappClicks += t.metrics?.whatsappClicks || 0;
    acc.leads += t.metrics?.leads || 0;
    acc.count += 1;
    return acc;
  }, { views: 0, whatsappClicks: 0, leads: 0, count: 0 });

  return {
    ...totals,
    ctr: totals.views > 0 ? totals.whatsappClicks / totals.views : 0
  };
}

/**
 * 🎯 Seleciona qual variante usar (A ou B)
 * 
 * Lógica:
 * 1. Se não tiver dados suficientes → round-robin
 * 2. Se tiver dados → favorece vencedora, mas mantém 20% exploração
 */
export async function selectVariant(item) {
  const themeKey = getThemeKey(item);
  const variants = generateVariants(item);

  const statsA = await getVariantStats(themeKey, 'A');
  const statsB = await getVariantStats(themeKey, 'B');

  const totalSamples = statsA.count + statsB.count;

  // Fase 1: exploração (round-robin)
  if (totalSamples < MIN_SAMPLES_FOR_EXPLOITATION) {
    const chosen = totalSamples % 2 === 0 ? 'A' : 'B';
    console.log(`🧪 [A/B] Exploração inicial para ${themeKey}: ${chosen} (A=${statsA.count}, B=${statsB.count})`);
    return variants[chosen];
  }

  // Fase 2: exploração guiada / explotação
  const winner = statsA.whatsappClicks >= statsB.whatsappClicks ? 'A' : 'B';

  // Mantém 20% de exploração
  if (Math.random() < EXPLORATION_RATE) {
    const explore = winner === 'A' ? 'B' : 'A';
    console.log(`🧪 [A/B] Exploração forçada para ${themeKey}: ${explore} (vencedora: ${winner})`);
    return variants[explore];
  }

  console.log(`🧪 [A/B] Variante vencedora para ${themeKey}: ${winner} (A clicks=${statsA.whatsappClicks}, B clicks=${statsB.whatsappClicks})`);
  return variants[winner];
}

/**
 * 💾 Registra um teste A/B no banco
 */
export async function recordABTest({ item, variant, postId, date }) {
  const themeKey = getThemeKey(item);

  const test = new GmbABTest({
    themeKey,
    calendarDay: item.dia,
    variant: variant.variant,
    postId,
    copyTheme: item.tema,
    date,
    metrics: { views: 0, whatsappClicks: 0, leads: 0 }
  });

  await test.save();
  return test;
}

/**
 * 📈 Incrementa métrica de um teste A/B
 */
export async function recordMetric(postId, metricName, increment = 1) {
  const allowed = ['views', 'whatsappClicks', 'leads'];
  if (!allowed.includes(metricName)) {
    throw new Error(`Métrica inválida: ${metricName}`);
  }

  const update = { $inc: { [`metrics.${metricName}`]: increment } };
  const result = await GmbABTest.findOneAndUpdate(
    { postId },
    update,
    { new: true }
  );

  return result;
}

/**
 * 📊 Performance por tema
 */
export async function getPerformanceByTheme() {
  const results = await GmbABTest.aggregate([
    {
      $group: {
        _id: { themeKey: '$themeKey', variant: '$variant' },
        totalViews: { $sum: '$metrics.views' },
        totalClicks: { $sum: '$metrics.whatsappClicks' },
        totalLeads: { $sum: '$metrics.leads' },
        count: { $sum: 1 }
      }
    },
    {
      $group: {
        _id: '$_id.themeKey',
        variants: {
          $push: {
            variant: '$_id.variant',
            views: '$totalViews',
            whatsappClicks: '$totalClicks',
            leads: '$totalLeads',
            count: '$count'
          }
        }
      }
    },
    { $sort: { _id: 1 } }
  ]);

  return results.map(r => ({
    themeKey: r._id,
    variants: r.variants,
    winner: r.variants.length > 1
      ? r.variants.reduce((best, v) =>
          (v.whatsappClicks / Math.max(v.views, 1)) > (best.whatsappClicks / Math.max(best.views, 1)) ? v : best
        )
      : null
  }));
}

/**
 * 📋 Lista todos os testes A/B
 */
export async function listABTests(limit = 100) {
  return await GmbABTest.find()
    .sort({ createdAt: -1 })
    .limit(limit)
    .populate('postId', 'title status scheduledAt')
    .lean();
}

export default {
  generateVariants,
  getThemeKey,
  selectVariant,
  recordABTest,
  recordMetric,
  getPerformanceByTheme,
  listABTests
};
