/**
 * Serviço de taxas históricas para projeções financeiras
 *
 * Calcula com base nos últimos N dias:
 *   - attendanceRate:  comparecimento (completed / completed + missed) — appointments avulsos
 *   - paymentRate:     pagamento (sessões pagas / sessões completadas) — avulsos com paymentId
 *   - conversionRate:  fixo 0.40 (sem histórico estruturado de transição de status)
 *
 * Cache em memória com TTL de 1h para evitar queries pesadas a cada request.
 */

// Cache simples em memória
const _cache = new Map();
const CACHE_TTL_MS = 60 * 60 * 1000; // 1 hora

const cacheGet = (key) => {
  const entry = _cache.get(key);
  if (!entry) return null;
  if (Date.now() - entry.timestamp > CACHE_TTL_MS) {
    _cache.delete(key);
    return null;
  }
  return entry.value;
};

const cacheSet = (key, value) => {
  _cache.set(key, { value, timestamp: Date.now() });
};

/**
 * Calcula taxas históricas de comparecimento e pagamento.
 *
 * @param {number} days - Período de análise em dias (default: 90)
 * @returns {Promise<Object>} Taxas + metadados de confiança
 */
export const getHistoricalRates = async (days = 90) => {
  const cacheKey = `historicalRates:${days}d`;
  const cached = cacheGet(cacheKey);
  if (cached) return cached;

  const Session = (await import('../models/Session.js')).default;
  const Appointment = (await import('../models/Appointment.js')).default;

  const cutoffDate = new Date();
  cutoffDate.setDate(cutoffDate.getDate() - days);
  const cutoffStr = cutoffDate.toISOString().split('T')[0]; // YYYY-MM-DD

  // ─── Taxa de comparecimento ───────────────────────────────────────────────
  // Appointments avulsos (sem pacote) com status clínico já resolvido
  const [appointmentsCompleted, appointmentsMissed] = await Promise.all([
    Appointment.countDocuments({
      date: { $gte: cutoffStr },
      clinicalStatus: 'completed',
      $or: [{ package: { $exists: false } }, { package: null }]
    }),
    Appointment.countDocuments({
      date: { $gte: cutoffStr },
      clinicalStatus: 'missed',
      $or: [{ package: { $exists: false } }, { package: null }]
    })
  ]);

  const totalResolved = appointmentsCompleted + appointmentsMissed;
  // Fallback 0.78 quando não há amostra suficiente
  const attendanceRate = totalResolved > 0
    ? Number((appointmentsCompleted / totalResolved).toFixed(4))
    : 0.78;

  // ─── Taxa de pagamento ────────────────────────────────────────────────────
  // Sessões avulsas completadas vs. aquelas com paymentId (confirma recebimento real)
  const [sessionsCompleted, sessionsPaid] = await Promise.all([
    Session.countDocuments({
      status: 'completed',
      date: { $gte: cutoffStr },
      $or: [{ package: { $exists: false } }, { package: null }]
    }),
    Session.countDocuments({
      status: 'completed',
      date: { $gte: cutoffStr },
      $or: [{ package: { $exists: false } }, { package: null }],
      paymentId: { $ne: null }
    })
  ]);

  // Fallback 0.92 quando não há amostra suficiente
  const paymentRate = sessionsCompleted > 0
    ? Number((sessionsPaid / sessionsCompleted).toFixed(4))
    : 0.92;

  // ─── Nível de confiança (por volume de amostra) ───────────────────────────
  const confidence = totalResolved < 50 ? 'low' : totalResolved < 150 ? 'medium' : 'high';

  const result = {
    attendanceRate,
    paymentRate,
    conversionRate: 0.40,                // Fixo: sem histórico estruturado de transição de status
    conversionRateSource: 'default',     // 'default' | 'historical' — indica a fonte da taxa
    basePeriodDays: days,
    sampleSize: {
      appointmentsConsidered: totalResolved,
      sessionsCompleted,
      sessionsPaid
    },
    confidence,
    calculatedAt: new Date().toISOString()
  };

  if (result.conversionRateSource === 'default') {
    console.warn('[HistoricalRates] conversionRate usando valor default (0.40) — sem histórico estruturado de transição de status');
  }

  cacheSet(cacheKey, result);
  return result;
};

/**
 * Invalida o cache de taxas históricas (útil após importações ou correções em massa).
 */
export const clearCache = () => {
  _cache.clear();
};

export default { getHistoricalRates, clearCache };
