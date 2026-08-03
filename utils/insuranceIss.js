/**
 * Cálculo de ISS/imposto retido na fonte para recebimentos de convênio.
 *
 * A alíquota (%) é lida de Convenio.issRate. Se o convênio não existir ou não
 * tiver alíquota configurada, assume 0% (sem retenção).
 *
 * IMPORTANTE: não altera nenhum documento — apenas calcula valores.
 */
import Convenio from '../models/Convenio.js';

const CACHE = new Map();
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutos

/**
 * Limpa o cache interno de alíquotas. Útil principalmente em testes unitários.
 */
export function clearConvenioIssRateCache() {
  CACHE.clear();
}

/**
 * Busca a alíquota de ISS configurada para um convênio.
 * @param {string} providerCode - slug do convênio (ex: 'unimed-anapolis')
 * @returns {Promise<number>} alíquota em % (0 se não encontrada)
 */
export async function getConvenioIssRate(providerCode) {
  if (!providerCode) return 0;
  const key = String(providerCode).toLowerCase().trim();
  if (!key || key === 'convenio' || key === 'nao_identificado') return 0;

  const cached = CACHE.get(key);
  if (cached && cached.ts > Date.now() - CACHE_TTL_MS) {
    return cached.rate;
  }

  try {
    const convenio = await Convenio.findOne({ code: key }).select('issRate').lean();
    const rate = convenio?.issRate || 0;
    CACHE.set(key, { rate, ts: Date.now() });
    return rate;
  } catch (err) {
    console.warn(`[insuranceIss] Erro ao buscar issRate para ${key}:`, err.message);
    return 0;
  }
}

/**
 * Calcula ISS e valor líquido a partir do valor bruto e da alíquota.
 *
 * @param {number} grossAmount - valor bruto recebido do convênio
 * @param {number} issRate - alíquota em % (ex: 2.01)
 * @returns {{ grossAmount: number, issRate: number, issAmount: number, netAmount: number }}
 */
export function calculateInsuranceIss(grossAmount, issRate) {
  const gross = Number(grossAmount) || 0;
  const rate = Number(issRate) || 0;
  const issAmount = rate > 0 && gross > 0
    ? Math.round(gross * rate) / 100
    : 0;
  const netAmount = gross - issAmount;

  return {
    grossAmount: gross,
    issRate: rate,
    issAmount,
    netAmount
  };
}

/**
 * Combina busca da alíquota + cálculo em um único helper.
 * @param {string} providerCode
 * @param {number} grossAmount
 * @returns {Promise<{ grossAmount: number, issRate: number, issAmount: number, netAmount: number }>}
 */
export async function resolveInsuranceIss(providerCode, grossAmount) {
  const rate = await getConvenioIssRate(providerCode);
  return calculateInsuranceIss(grossAmount, rate);
}

export default {
  getConvenioIssRate,
  calculateInsuranceIss,
  resolveInsuranceIss,
  clearConvenioIssRateCache
};
