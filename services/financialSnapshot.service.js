/**
 * 💰 Financial Snapshot Service
 *
 * Agrega FinancialDailySnapshot para ranges mensais.
 * Projeção determinística — ZERO regra de negócio, apenas leitura.
 */

import moment from 'moment-timezone';
import FinancialDailySnapshot from '../models/FinancialDailySnapshot.js';

const TIMEZONE = 'America/Sao_Paulo';

class FinancialSnapshotService {
  /**
   * Retorna agregação mensal no formato esperado pelo Dashboard V3
   */
  async getMonthlyAggregate(year, month, clinicId = 'default') {
    const start = moment.tz([year, month - 1], TIMEZONE).startOf('month');
    const end = moment.tz([year, month - 1], TIMEZONE).endOf('month');
    const today = moment.tz(TIMEZONE);
    const todayStr = today.format('YYYY-MM-DD');
    const startStr = start.format('YYYY-MM-DD');
    const endStr = end.format('YYYY-MM-DD');

    const snapshots = await FinancialDailySnapshot.find({
      clinicId,
      date: { $gte: startStr, $lte: endStr }
    }).lean();

    // Inicializa acumuladores no formato do Dashboard V3
    const result = {
      caixa: 0,
      caixaHoje: 0,
      caixaDetalhe: { particular: 0, pacote: 0, convenio: 0, liminar: 0 },
      caixaByMethod: { pix: 0, dinheiro: 0, cartao: 0, outros: 0 },
      producao: 0,
      producaoDetalhe: { particular: 0, pacote: 0, convenio: 0, liminar: 0, recebido: 0, pendente: 0 },
      saldo: 0,
      profissionais: new Map(),
      snapshotCount: snapshots.length,
      hasData: snapshots.length > 0,
    };

    for (const snap of snapshots) {
      // Caixa
      result.caixa += snap.cash?.total || 0;
      result.caixaDetalhe.particular += snap.cash?.particular || 0;
      result.caixaDetalhe.pacote += snap.cash?.convenioPacote || 0;
      result.caixaDetalhe.convenio += snap.cash?.convenioAvulso || 0;
      result.caixaDetalhe.liminar += snap.cash?.liminar || 0;

      result.caixaByMethod.pix += snap.cash?.byMethod?.pix || 0;
      result.caixaByMethod.dinheiro += snap.cash?.byMethod?.dinheiro || 0;
      result.caixaByMethod.cartao += snap.cash?.byMethod?.cartao || 0;
      result.caixaByMethod.outros += snap.cash?.byMethod?.outros || 0;

      if (snap.date === todayStr) {
        result.caixaHoje += snap.cash?.total || 0;
      }

      // Produção
      result.producao += snap.production?.total || 0;
      result.producaoDetalhe.particular += snap.production?.byBusinessType?.particular?.total || 0;
      result.producaoDetalhe.pacote += snap.production?.byBusinessType?.pacote?.total || 0;
      result.producaoDetalhe.convenio += snap.production?.byBusinessType?.convenio?.total || 0;
      result.producaoDetalhe.liminar += snap.production?.byBusinessType?.liminar?.total || 0;

      // Recebido / Pendente da produção (aproximação via snapshot)
      // recebido = caixa do dia (dinheiro que entrou)
      // pendente = diferença entre produção e caixa (simplificação)
      result.producaoDetalhe.recebido += snap.cash?.total || 0;

      // Profissionais (agrega por ID)
      for (const prof of (snap.professionals || [])) {
        const existing = result.profissionais.get(prof.professionalId);
        if (existing) {
          existing.producao += prof.production || 0;
          existing.realizado += prof.cash || 0;
          existing.quantidade += prof.count || 0;
          existing.particular += prof.particular || 0;
          existing.convenio += prof.convenio || 0;
          existing.pacote += prof.pacote || 0;
          existing.liminar += prof.liminar || 0;
        } else {
          result.profissionais.set(prof.professionalId, {
            id: prof.professionalId,
            nome: null, // será preenchido depois
            especialidade: 'Outra',
            producao: prof.production || 0,
            realizado: prof.cash || 0,
            quantidade: prof.count || 0,
            particular: prof.particular || 0,
            convenio: prof.convenio || 0,
            pacote: prof.pacote || 0,
            liminar: prof.liminar || 0,
          });
        }
      }
    }

    result.producaoDetalhe.pendente = Math.max(0, result.producao - result.producaoDetalhe.recebido);
    result.saldo = result.caixa;

    return result;
  }

  /**
   * Verifica se o snapshot mensal está completo o suficiente para ser usado.
   * Critério: deve haver snapshots para pelo menos 80% dos dias até hoje.
   */
  async isMonthlySnapshotReady(year, month, clinicId = 'default') {
    const start = moment.tz([year, month - 1], TIMEZONE).startOf('month');
    const end = moment.tz([year, month - 1], TIMEZONE).endOf('month');
    const today = moment.tz(TIMEZONE);
    const lastDay = today.isAfter(end, 'day') ? end : today;
    const expectedDays = lastDay.diff(start, 'days') + 1;

    const startStr = start.format('YYYY-MM-DD');
    const endStr = lastDay.format('YYYY-MM-DD');

    const count = await FinancialDailySnapshot.countDocuments({
      clinicId,
      date: { $gte: startStr, $lte: endStr }
    });

    return count / expectedDays >= 0.8;
  }
}

export default new FinancialSnapshotService();

export async function getSnapshotsForRange(startDate, endDate, clinicId) {
  const filter = { date: { $gte: startDate, $lte: endDate } };
  if (clinicId) filter.clinicId = clinicId;
  return FinancialDailySnapshot.find(filter).lean();
}

export async function getSnapshotsForMonth(year, month, clinicId) {
  const start = moment.tz([year, month - 1], TIMEZONE).startOf('month').format('YYYY-MM-DD');
  const end   = moment.tz([year, month - 1], TIMEZONE).endOf('month').format('YYYY-MM-DD');
  return getSnapshotsForRange(start, end, clinicId);
}

export function reducePaymentStats(snapshots) {
  return snapshots.reduce((acc, snap) => {
    const p = snap.payments || {};
    acc.produced     += p.produced      || 0;
    acc.received     += p.received      || 0;
    acc.count        += p.count         || 0;
    acc.countPaid    += p.countPaid     || 0;
    acc.countPartial += p.countPartial  || 0;
    acc.countPending += p.countPending  || 0;
    return acc;
  }, { produced: 0, received: 0, count: 0, countPaid: 0, countPartial: 0, countPending: 0 });
}
