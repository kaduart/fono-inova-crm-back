/**
 * 📊 Dashboard Financeiro Unificado
 * 
 * API única que consolida dados para:
 * - Metas & Provisão
 * - Inteligência Financeira
 * - Business Intelligence
 * 
 * Features:
 * - Cache em memória (5 minutos)
 * - Filtros de período: month, week, custom
 * - Timezone America/Sao_Paulo
 */

import express from 'express';
import moment from 'moment-timezone';
import NodeCache from 'node-cache';
import { auth, authorize } from '../../middleware/auth.js';
import financialMetricsService from '../../services/financialMetrics.service.js';
import historicalRatesService from '../../services/historicalRates.service.js';
import FinancialDailySnapshot from '../../models/FinancialDailySnapshot.js';
import  reduceFullStats  from '../../services/financialSnapshot.service.js';

// 🆕 V2: feature flag para usar snapshot no dashboard
const USE_SNAPSHOT_DASHBOARD = process.env.FF_DASHBOARD_SNAPSHOT !== 'false';

const router = express.Router();
const TIMEZONE = 'America/Sao_Paulo';

// Cache: TTL 5 minutos, verificação a cada 2 minutos
const dashboardCache = new NodeCache({ stdTTL: 300, checkperiod: 120 });

/**
 * 🆕 V2: Busca overview a partir de FinancialDailySnapshot
 * Retorna os mesmos campos críticos do dashboard em milissegundos
 */
async function getSnapshotOverview(periodo, clinicId = 'default') {
  const snapshots = await FinancialDailySnapshot.find({
    date: { $gte: periodo.inicio, $lte: periodo.fim },
    ...(clinicId && { clinicId })
  }).lean();

  const reduced = reduceFullStats(snapshots);

  return {
    production: {
      total: reduced.productionTotal,
      byPaymentMethod: {
        particular: { total: snapshots.reduce((s, d) => s + (d.production?.byPaymentMethod?.particular?.total || 0), 0), count: snapshots.reduce((s, d) => s + (d.production?.byPaymentMethod?.particular?.count || 0), 0) },
        convenio:   { total: snapshots.reduce((s, d) => s + (d.production?.byPaymentMethod?.convenio?.total || 0), 0),   count: snapshots.reduce((s, d) => s + (d.production?.byPaymentMethod?.convenio?.count || 0), 0) },
        pix:        { total: snapshots.reduce((s, d) => s + (d.production?.byPaymentMethod?.pix?.total || 0), 0),        count: snapshots.reduce((s, d) => s + (d.production?.byPaymentMethod?.pix?.count || 0), 0) },
        credit_card:{ total: snapshots.reduce((s, d) => s + (d.production?.byPaymentMethod?.credit_card?.total || 0), 0), count: snapshots.reduce((s, d) => s + (d.production?.byPaymentMethod?.credit_card?.count || 0), 0) },
      }
    },
    cash: {
      total: reduced.cashTotal,
      bySource: {
        payments: {
          total: reduced.cashTotal,
          byType: {
            particular: snapshots.reduce((s, d) => s + (d.cash?.particular || 0), 0),
            convenio: snapshots.reduce((s, d) => s + (d.cash?.convenioAvulso || 0) + (d.cash?.convenioPacote || 0), 0),
          }
        }
      }
    },
    receivable: {
      total: 0, // snapshot V2 ainda não popula receivable detalhado
      convenio: { total: 0 },
      particular: { doMes: { total: 0 } }
    },
    convenioDetail: {
      atendido: { total: reduced.convenioAtendido, count: 0 },
      faturado: { total: reduced.convenioFaturado, count: 0 },
      recebido: { total: reduced.convenioRecebido, count: 0 },
      aReceber: { total: 0, count: 0 },
      status: {
        faturadoVsAtendido: reduced.convenioFaturado - reduced.convenioAtendido,
        recebidoVsFaturado: reduced.convenioRecebido - reduced.convenioFaturado,
        glosaPotencial: null
      }
    }
  };
}

/**
 * Calcula o período baseado no tipo de visualização
 * @param {string} view - 'month' | 'week' | 'day' | 'custom'
 * @param {number} month - Mês (1-12)
 * @param {number} year - Ano
 * @param {string} startDate - Data início (para custom)
 * @param {string} endDate - Data fim (para custom)
 * @param {number} weekOffset - Offset de semana (0 = atual, -1 = anterior, etc)
 */
const calcularPeriodo = (view, month, year, startDate, endDate, weekOffset = 0) => {
  const hoje = moment().tz(TIMEZONE);
  
  switch (view) {
    case 'week': {
      // Semana atual ou com offset
      const inicioSemana = moment(hoje).add(weekOffset, 'weeks').startOf('week');
      const fimSemana = moment(inicioSemana).endOf('week');
      return {
        inicio: inicioSemana.format('YYYY-MM-DD'),
        fim: fimSemana.format('YYYY-MM-DD'),
        label: `Semana ${inicioSemana.format('DD/MM')} - ${fimSemana.format('DD/MM')}`,
        diasRestantes: fimSemana.diff(hoje, 'days')
      };
    }
    
    case 'day': {
      // Dia específico ou hoje
      const dia = startDate ? moment(startDate).tz(TIMEZONE) : hoje;
      return {
        inicio: dia.format('YYYY-MM-DD'),
        fim: dia.format('YYYY-MM-DD'),
        label: dia.format('DD/MM/YYYY'),
        diasRestantes: 0
      };
    }
    
    case 'custom': {
      // Período customizado
      if (startDate && endDate) {
        return {
          inicio: moment(startDate).tz(TIMEZONE).format('YYYY-MM-DD'),
          fim: moment(endDate).tz(TIMEZONE).format('YYYY-MM-DD'),
          label: `${moment(startDate).format('DD/MM')} - ${moment(endDate).format('DD/MM')}`,
          diasRestantes: moment(endDate).diff(hoje, 'days')
        };
      }
      // Fallback para mês
    }
    
    case 'month':
    default: {
      // Mês específico
      const inicioMes = moment.tz({ year, month: month - 1, day: 1 }, TIMEZONE);
      const fimMes = moment(inicioMes).endOf('month');
      return {
        inicio: inicioMes.format('YYYY-MM-DD'),
        fim: fimMes.format('YYYY-MM-DD'),
        label: inicioMes.format('MMMM/YYYY'),
        diasRestantes: fimMes.diff(hoje, 'days')
      };
    }
  }
};

/**
 * @route   GET /api/financial/dashboard
 * @desc    Dashboard completo com provisionamento, projeção e análises
 * @query   {number} month - Mês (1-12)
 * @query   {number} year - Ano
 * @query   {string} view - Tipo de visualização: 'month' | 'week' | 'day' | 'custom'
 * @query   {string} startDate - Data início (para view=custom)
 * @query   {string} endDate - Data fim (para view=custom)
 * @query   {number} weekOffset - Offset de semana (para view=week)
 */
router.get('/', auth, authorize(['admin', 'secretary']), async (req, res) => {
  try {
    const { month, year, view = 'month', startDate, endDate, weekOffset = 0, forceRefresh } = req.query;
    const mes = parseInt(month) || moment().tz(TIMEZONE).month() + 1;
    const ano = parseInt(year) || moment().tz(TIMEZONE).year();
    const viewType = view;

    // Chave de cache baseada nos parâmetros
    const cacheKey = `dashboard_${viewType}_${mes}_${ano}_${startDate || ''}_${endDate || ''}_${weekOffset}`;
    
    // Verifica cache (a menos que forceRefresh seja true)
    if (!forceRefresh) {
      const cached = dashboardCache.get(cacheKey);
      if (cached) {
        console.log(`[Dashboard] Cache hit: ${cacheKey}`);
        return res.json({ ...cached, fromCache: true });
      }
    }

    // Calcula o período baseado na view
    const periodo = calcularPeriodo(viewType, mes, ano, startDate, endDate, parseInt(weekOffset));
    const { inicio: inicioPeriodo, fim: fimPeriodo } = periodo;
    
    const hoje = moment().tz(TIMEZONE).format('YYYY-MM-DD');

    const ehPeriodoPassado = fimPeriodo < hoje;
    const ehPeriodoAtual = (inicioPeriodo <= hoje && fimPeriodo >= hoje);

    // Importar models (apenas os que não são cobertos pelo serviço)
    const { default: Session } = await import('../../models/Session.js');
    const { default: Appointment } = await import('../../models/Appointment.js');
    const { default: Planning } = await import('../../models/Planning.js');
    const { default: Package } = await import('../../models/Package.js');
    const { default: Payment } = await import('../../models/Payment.js');

    // ========================================
    // 1+2. PRODUÇÃO, CAIXA e A RECEBER — via snapshot V2 (com fallback)
    // ========================================
    const period = { startDate: new Date(inicioPeriodo), endDate: new Date(fimPeriodo) };

    let overview;
    if (USE_SNAPSHOT_DASHBOARD) {
      try {
        overview = await getSnapshotOverview(periodo, 'default');
        // 🛡️ Validação: se snapshot retornou zeros mas é período histórico, fallback para V1
        const hasSnapshotData = overview.production.total > 0 || overview.cash.total > 0;
        if (!hasSnapshotData && ehPeriodoPassado) {
          console.warn('[Dashboard] Snapshot vazio para período passado — fallback V1', { periodo });
          overview = await financialMetricsService.getOverview(period);
        } else {
          console.log('[Dashboard] Usando snapshot V2', { production: overview.production.total, cash: overview.cash.total });
        }
      } catch (snapshotErr) {
        console.error('[Dashboard] Erro no snapshot — fallback V1', snapshotErr.message);
        overview = await financialMetricsService.getOverview(period);
      }
    } else {
      overview = await financialMetricsService.getOverview(period);
    }

    const producaoTotal = overview.production.total;
    const producaoConvenio = overview.production.byPaymentMethod?.convenio?.total || 0;
    const producaoParticular = overview.production.byPaymentMethod?.particular?.total || 0;
    const producaoPacotes = producaoTotal - producaoConvenio - producaoParticular;

    // ========================================
    // 2. CAIXA (Pagamentos recebidos) — Cálculo manual correto
    // ========================================
    // Parte 1: Particular (Payment model)
    // Particular: status paid + billingType particular + paymentDate no período
    // paymentDate é string 'YYYY-MM-DD'
    const particularPayments = await Payment.aggregate([
      {
        $match: {
          billingType: 'particular',
          status: 'paid',
          paymentDate: { $gte: inicioPeriodo, $lte: fimPeriodo }
        }
      },
      {
        $group: {
          _id: null,
          total: { $sum: '$amount' },
          count: { $sum: 1 }
        }
      }
    ]);
    const particularTotal = particularPayments[0]?.total || 0;

    // Parte 2: Convênio (Payment model)
    // Convênio: insurance.receivedAt no período (data que o dinheiro chegou)
    // Converte inicioPeriodo/fimPeriodo para Date
    const inicioDate = new Date(inicioPeriodo);
    const fimDate = new Date(fimPeriodo);
    // Ajusta fimDate para o final do dia
    fimDate.setHours(23, 59, 59, 999);

    const convenioPayments = await Payment.aggregate([
      {
        $match: {
          billingType: 'convenio',
          'insurance.status': { $in: ['received', 'partial'] },
          'insurance.receivedAt': { $gte: inicioDate, $lte: fimDate }
        }
      },
      {
        $group: {
          _id: null,
          total: { $sum: '$insurance.receivedAmount' },
          count: { $sum: 1 }
        }
      }
    ]);
    const convenioTotal = convenioPayments[0]?.total || 0;

    // Parte 3: Sessões de pacote convênio (Session model)
    // Sessões pagas sem Payment associado (FASE 1 híbrido)
    // Proteção anti-duplicação: lookup em payments verificando se existe Payment vinculado
    const sessoesResult = await Session.aggregate([
      {
        $match: {
          isPaid: true,
          paidAt: { $gte: inicioDate, $lte: fimDate },
          paymentMethod: 'convenio',
          $or: [
            { paymentId: { $exists: false } },
            { paymentId: null }
          ]
        }
      },
      {
        // 🛡️ PROTEÇÃO: Lookup em Payment para garantir não existe
        $lookup: {
          from: 'payments',
          let: { sessionId: '$_id' },
          pipeline: [
            {
              $match: {
                $expr: {
                  $or: [
                    { $eq: ['$session', '$$sessionId'] },
                    { $in: ['$$sessionId', { $ifNull: ['$sessions', []] }] }
                  ]
                }
              }
            },
            { $limit: 1 }
          ],
          as: 'linkedPayment'
        }
      },
      {
        // Só inclui se NÃO existe Payment vinculado
        $match: {
          linkedPayment: { $size: 0 }
        }
      },
      {
        $lookup: {
          from: 'packages',
          localField: 'package',
          foreignField: '_id',
          as: 'pkg'
        }
      },
      {
        $unwind: {
          path: '$pkg',
          preserveNullAndEmptyArrays: true
        }
      },
      {
        // Usa sessionValue (histórico imutável) ou fallback para package.sessionValue / insuranceGrossAmount
        $group: {
          _id: null,
          total: {
            $sum: {
              $cond: [
                { $gt: ['$sessionValue', 0] },
                '$sessionValue',
                { $ifNull: ['$pkg.sessionValue', { $ifNull: ['$pkg.insuranceGrossAmount', 0] }] }
              ]
            }
          },
          count: { $sum: 1 }
        }
      }
    ]);
    const sessoesTotal = sessoesResult[0]?.total || 0;

    // Resultado final: caixaTotal
    const caixaTotal = particularTotal + convenioTotal + sessoesTotal;

    const aReceberTotal = overview.receivable.total;
    const aReceberConvenio = overview.receivable.convenio?.total || 0;
    const aReceberParticular = overview.receivable.particular?.doMes?.total || 0;

    // Sessões do mês — apenas para analytics/detalhes (V2: dados em Appointment)
    const sessoesDoMes = await Appointment.find({
      operationalStatus: { $in: ['completed', 'confirmed'] },
      paymentStatus: { $in: ['paid', 'package_paid'] },
      date: { $gte: inicioPeriodo, $lte: fimPeriodo }
    })
    .select('date time sessionValue package doctor patient patientName sessionType paymentMethod operationalStatus paymentStatus')
    .populate('package', 'insuranceGrossAmount type sessionValue')
    .populate('doctor', 'fullName specialty')
    .populate('patient', 'fullName')
    .lean();

    const valorSessao = (s) => s.sessionValue || s.package?.sessionValue || s.package?.insuranceGrossAmount || 0;

    // ─── Realizadas mas NÃO pagas (pending_balance, unpaid, pending, partial…) ─
    // Sessões completed que o dashboard ignorava antes (ex: Isis Caldas)
    const realizadasNaoPagasRaw = await Appointment.aggregate([
      {
        $match: {
          operationalStatus: 'completed',
          paymentStatus: { $nin: ['paid', 'package_paid', 'canceled'] },
          date: { $gte: inicioPeriodo, $lte: fimPeriodo }
        }
      },
      {
        $lookup: {
          from: 'packages',
          localField: 'package',
          foreignField: '_id',
          pipeline: [{ $project: { sessionValue: 1, insuranceGrossAmount: 1 } }],
          as: 'pkg'
        }
      },
      { $unwind: { path: '$pkg', preserveNullAndEmptyArrays: true } },
      {
        $lookup: {
          from: 'patients',
          localField: 'patient',
          foreignField: '_id',
          pipeline: [{ $project: { fullName: 1 } }],
          as: 'pat'
        }
      },
      { $unwind: { path: '$pat', preserveNullAndEmptyArrays: true } },
      {
        $project: {
          _id: 1,
          date: 1,
          time: 1,
          paymentStatus: 1,
          paciente: { $ifNull: ['$pat.fullName', '$patientName'] },
          valor: {
            $cond: [
              { $gt: ['$sessionValue', 0] },
              '$sessionValue',
              { $ifNull: ['$pkg.sessionValue', { $ifNull: ['$pkg.insuranceGrossAmount', 0] }] }
            ]
          }
        }
      }
    ]);
    const realizadasNaoPagasTotal = realizadasNaoPagasRaw.reduce((s, a) => s + (a.valor || 0), 0);

    // Detalhes por especialidade
    const porEspecialidade = {};
    sessoesDoMes.forEach(s => {
      const esp = s.sessionType || 'nao_informada';
      if (!porEspecialidade[esp]) {
        porEspecialidade[esp] = { producao: 0, count: 0, pacientesUnicos: new Set() };
      }
      porEspecialidade[esp].producao += valorSessao(s);
      porEspecialidade[esp].count += 1;
      if (s.patient) porEspecialidade[esp].pacientesUnicos.add(s.patient.toString());
    });

    // ========================================
    // 3. CRÉDITO PACOTES (Sessões pagas não utilizadas)
    // ========================================
    const pacotesCredito = await Package.find({
      type: { $ne: 'convenio' },
      financialStatus: { $in: ['paid', 'partially_paid'] },
      status: { $in: ['active', 'in-progress'] }
    }).populate('patient', 'fullName').select('_id patient totalPaid paidSessions sessionValue');

    // Otimização: aggregate único para evitar N+1
    const pacoteIds = pacotesCredito.map(p => p._id);
    const sessoesPorPacote = pacoteIds.length > 0
      ? await Session.aggregate([
          { $match: { package: { $in: pacoteIds }, status: { $nin: ['canceled'] } } },
          {
            $group: {
              _id: '$package',
              total: { $sum: 1 },
              feitas: { $sum: { $cond: [{ $eq: ['$status', 'completed'] }, 1, 0] } },
              agendadas: { $sum: { $cond: [{ $in: ['$status', ['scheduled', 'confirmed']] }, 1, 0] } }
            }
          }
        ])
      : [];
    const sessoesMap = new Map(sessoesPorPacote.map(s => [s._id.toString(), s]));

    let creditoPacotesValor = 0;
    const creditoPacotesDetalhes = [];

    for (const pkg of pacotesCredito) {
      const stats = sessoesMap.get(pkg._id.toString());
      const sessoesFeitas = stats?.feitas || 0;
      const sessoesAgendadas = stats?.agendadas || 0;

      const sessoesPagas = pkg.paidSessions || Math.floor((pkg.totalPaid || 0) / (pkg.sessionValue || 1));
      const creditoCalculado = Math.max(0, sessoesPagas - sessoesFeitas);
      const sessoesRemanescentes = Math.min(creditoCalculado, sessoesAgendadas);
      const valor = sessoesRemanescentes * (pkg.sessionValue || 0);

      if (valor > 0) {
        creditoPacotesValor += valor;
        creditoPacotesDetalhes.push({
          pacoteId: pkg._id,
          paciente: pkg.patient?.fullName || 'N/A',
          sessoesRemanescentes,
          valorPorSessao: pkg.sessionValue,
          valorTotal: valor
        });
      }
    }

    // ========================================
    // 4. CONVÊNIO AGENDADO
    // ========================================
    const sessoesConvenioAgendadas = await Session.find({
      date: { $gte: inicioPeriodo, $lte: fimPeriodo },
      status: { $in: ['scheduled', 'confirmed'] },
      paymentMethod: 'convenio'
    }).populate('package', 'insuranceGrossAmount insuranceProvider').populate('patient', 'fullName');

    const convenioAgendadoValor = sessoesConvenioAgendadas.reduce((sum, s) => {
      return sum + (s.sessionValue || s.package?.insuranceGrossAmount || 0);
    }, 0);

    const convenioAgendadoDetalhes = sessoesConvenioAgendadas.map(s => ({
      sessaoId: s._id,
      data: s.date,
      hora: s.time,
      paciente: s.patient?.fullName || 'Paciente',
      convenio: s.package?.insuranceProvider || 'N/A',
      valor: s.sessionValue || s.package?.insuranceGrossAmount || 0
    }));

    // ========================================
    // 5. AGENDADOS E PENDENTES (todos os tipos: avulso, pacote, avaliação, etc.)
    // ========================================
    const agendadosTodos = await Appointment.find({
      date: { $gte: inicioPeriodo, $lte: fimPeriodo },
      operationalStatus: { $in: ['confirmed', 'scheduled'] },
      clinicalStatus: { $nin: ['completed', 'cancelled'] }
    }).select('date time sessionValue package patient operationalStatus clinicalStatus')
      .populate('patient', 'fullName')
      .populate('package', 'sessionValue insuranceGrossAmount type')
      .lean();

    const pendentesTodos = await Appointment.find({
      date: { $gte: inicioPeriodo, $lte: fimPeriodo },
      $or: [{ operationalStatus: 'pending' }, { operationalStatus: { $exists: false } }],
      clinicalStatus: { $ne: 'completed' }
    }).select('date time sessionValue package patient operationalStatus clinicalStatus')
      .populate('patient', 'fullName')
      .populate('package', 'sessionValue insuranceGrossAmount type')
      .lean();

    const valorAppt = (a) => a.sessionValue || a.package?.sessionValue || a.package?.insuranceGrossAmount || 0;

    // Total (todos os tipos) — usado no Provisionamento
    const agendadosValor = agendadosTodos.reduce((sum, a) => sum + valorAppt(a), 0);
    const pendentesValor = pendentesTodos.reduce((sum, a) => sum + valorAppt(a), 0);

    // Avulso (sem pacote) — usado nos Cenários: sessões de pacote não geram novo caixa
    const agendadosAvulsoValor = agendadosTodos
      .filter(a => !a.package)
      .reduce((sum, a) => sum + valorAppt(a), 0);
    const pendentesAvulsoValor = pendentesTodos
      .filter(a => !a.package)
      .reduce((sum, a) => sum + valorAppt(a), 0);

    // ========================================
    // 6. CENÁRIOS DE PROJEÇÃO (taxas históricas reais)
    // ========================================

    // Busca taxas históricas dos últimos 90 dias (cache 1h)
    const rates = await historicalRatesService.getHistoricalRates(90);
    const { attendanceRate, paymentRate, conversionRate } = rates;

    // Variações por cenário (cap em 1.0 para evitar > 100%)
    const cap = (v) => Math.min(v, 1);

    // Base garantida = caixa já recebido + a receber do mês (trabalho feito, dinheiro pendente)
    // Cenários só adicionam probabilidade sobre o futuro (avulso + convênio agendado + pendentes)
    // Sessões de pacote não entram nos cenários: cash já foi recebido no pacote
    const baseGarantida = caixaTotal + aReceberTotal;

    const cenarios = {
      pessimista: {
        // Taxas reduzidas: -15% comparecimento, -10% pagamento, -20% conversão
        valor: Math.round(
          baseGarantida
          + (agendadosAvulsoValor  * cap(attendanceRate * 0.85) * cap(paymentRate * 0.90))
          + (pendentesAvulsoValor  * cap(conversionRate * 0.80) * cap(attendanceRate * 0.85) * cap(paymentRate * 0.90))
          + (convenioAgendadoValor * cap(attendanceRate * 0.85))
        ),
        probabilidade: ehPeriodoPassado ? 'Realizado' : 'Baixa'
      },
      realista: {
        // Taxas históricas reais sem ajuste
        valor: Math.round(
          baseGarantida
          + (agendadosAvulsoValor  * attendanceRate * paymentRate)
          + (pendentesAvulsoValor  * conversionRate * attendanceRate * paymentRate)
          + (convenioAgendadoValor * attendanceRate)
        ),
        probabilidade: ehPeriodoPassado ? 'Realizado' : 'Alta'
      },
      otimista: {
        // Taxas aumentadas: +5% comparecimento, +2% pagamento, +10% conversão
        valor: Math.round(
          baseGarantida
          + (agendadosAvulsoValor  * cap(attendanceRate * 1.05) * cap(paymentRate * 1.02))
          + (pendentesAvulsoValor  * cap(conversionRate * 1.10) * cap(attendanceRate * 1.05) * cap(paymentRate * 1.02))
          + (convenioAgendadoValor * cap(attendanceRate * 1.05))
        ),
        probabilidade: ehPeriodoPassado ? 'Potencial' : 'Média'
      }
    };

    // ========================================
    // 7. META DO PLANNING
    // ========================================
    const planningDoMes = await Planning.findOne({
      type: 'monthly',
      'period.start': { $lte: fimPeriodo },
      'period.end': { $gte: inicioPeriodo }
    });

    const metaMensal = planningDoMes?.targets?.expectedRevenue || 0;
    const percentualMeta = metaMensal > 0 ? (caixaTotal / metaMensal) * 100 : 0;

    // ========================================
    // 8. INSIGHTS
    // ========================================
    const insights = [];
    if (ehPeriodoAtual && metaMensal > 0) {
      const gap = metaMensal - producaoTotal - agendadosValor - convenioAgendadoValor;
      if (gap > 0) {
        insights.push({
          tipo: 'warning',
          titulo: 'Meta em risco',
          mensagem: `Faltam ${gap.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })} em agendamentos para bater a meta`,
          acao: 'Agendar mais pacientes'
        });
      }
    }

    if (creditoPacotesValor > 5000) {
      insights.push({
        tipo: 'info',
        titulo: 'Alto crédito em pacotes',
        mensagem: `${creditoPacotesValor.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })} em sessões pagas aguardando agendamento.`,
        acao: 'Contatar pacientes'
      });
    }

    if (pendentesValor > agendadosValor * 0.5) {
      insights.push({
        tipo: 'warning',
        titulo: 'Muitos agendamentos pendentes',
        mensagem: `${pendentesValor.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })} aguardando confirmação.`,
        acao: 'Revisar pendentes'
      });
    }

    // ========================================
    // 9. RANKING POR PROFISSIONAL (com nomes)
    // ========================================
    const porProfissional = {};
    sessoesDoMes.forEach(s => {
      const docId = s.doctor?._id?.toString() || s.doctor?.toString();
      if (!docId) return;
      
      if (!porProfissional[docId]) {
        porProfissional[docId] = { 
          producao: 0, 
          count: 0, 
          nome: s.doctor?.fullName || 'Profissional',
          especialidade: s.doctor?.specialty || 'N/A',
          pacientesUnicos: new Set()
        };
      }
      porProfissional[docId].producao += valorSessao(s);
      porProfissional[docId].count += 1;
      if (s.patient) porProfissional[docId].pacientesUnicos.add(s.patient.toString());
    });

    // ========================================
    // RESPOSTA UNIFICADA
    // ========================================
    const response = {
      success: true,
      periodo: {
        mes,
        ano,
        tipo: viewType,
        inicio: inicioPeriodo,
        fim: fimPeriodo,
        hoje,
        diasRestantes: periodo.diasRestantes,
        label: periodo.label,
        status: ehPeriodoPassado ? 'PASSADO' : ehPeriodoAtual ? 'ATUAL' : 'FUTURO'
      },
      // Para Metas & Provisão
      resumo: {
        producao: producaoTotal,
        producaoDetalhe: {
          particular: producaoParticular,
          pacotes: producaoPacotes,
          convenio: producaoConvenio
        },
        caixa: caixaTotal,
        caixaDetalhe: {
          particular: particularTotal,
          convenio: convenioTotal + sessoesTotal, // Convenio avulso + sessões
          detalhes: {
            particularPayments: particularPayments[0]?.count || 0,
            convenioPayments: convenioPayments[0]?.count || 0,
            sessoesConvenio: sessoesResult[0]?.count || 0
          }
        },
        aReceber: {
          total: aReceberTotal,
          mesAtual: aReceberTotal,
          historico: 0, // Será calculado se necessário
          convenio: aReceberConvenio,
          particular: aReceberParticular
        },
        realizadasNaoPagas: realizadasNaoPagasTotal, // completed mas sem pagamento (ex: pending_balance)
        creditoPacotes: creditoPacotesValor,
        convenioAgendado: convenioAgendadoValor,
        agendadoConfirmado: agendadosValor,        // todos os tipos (para provisionamento)
        pendenteConfirmacao: pendentesValor,
        // Provisionamento = caixa + a receber + todos os agendamentos futuros do mês (qqr tipo)
        provisionamento: caixaTotal + aReceberTotal + agendadosValor + convenioAgendadoValor
      },
      // Para Inteligência Financeira
      cenarios,
      taxasProjecao: {
        attendanceRate: rates.attendanceRate,
        paymentRate: rates.paymentRate,
        conversionRate: rates.conversionRate,
        conversionRateSource: rates.conversionRateSource,
        confidence: rates.confidence,
        basePeriodDays: rates.basePeriodDays
      },
      // 🏥 Pipeline de Convênios (dados já calculados no overview)
      convenioDetail: overview.convenioDetail,
      meta: {
        valor: metaMensal,
        percentualAtual: Math.round(percentualMeta * 100) / 100,
        gap: metaMensal > 0 ? Math.max(0, metaMensal - caixaTotal) : 0
      },
      // Para Business Intelligence
      analitico: {
        porEspecialidade: Object.entries(porEspecialidade).map(([especialidade, dados]) => ({
          especialidade,
          producao: dados.producao,
          sessoes: dados.count,
          ticketMedio: dados.count > 0 ? dados.producao / dados.count : 0,
          pacientesUnicos: dados.pacientesUnicos.size
        })),
        porProfissional: Object.entries(porProfissional).map(([id, dados]) => ({
          id,
          nome: dados.nome,
          especialidade: dados.especialidade,
          producao: dados.producao,
          sessoes: dados.count,
          ticketMedio: dados.count > 0 ? dados.producao / dados.count : 0,
          pacientesUnicos: dados.pacientesUnicos.size
        })).sort((a, b) => b.producao - a.producao) // Ordena por produção
      },
      // Detalhes
      detalhes: {
        realizados: sessoesDoMes.map(s => ({
          _id: s._id,
          data: s.date,
          hora: s.time,
          paciente: s.patient?.fullName || s.patientName || 'Paciente',
          tipo: s.paymentMethod === 'convenio' 
            ? (s.package ? 'Convênio Pacote' : 'Convênio Avulso')
            : (s.package ? 'Pacote Particular' : 'Particular'),
          valor: valorSessao(s)
        })),
        realizadasNaoPagas: realizadasNaoPagasRaw,
        realizadasNaoPagasTotal,
        creditoPacotes: creditoPacotesDetalhes,
        convenioAgendado: convenioAgendadoDetalhes,
        agendados: agendadosTodos.filter(a => !a.package).map(a => ({
          _id: a._id,
          data: a.date,
          hora: a.time,
          paciente: a.patient?.fullName || 'N/A',
          valor: a.sessionValue || 0
        })),
        pendentes: pendentesTodos.filter(p => !p.package).map(p => ({
          _id: p._id,
          data: p.date,
          hora: p.time,
          paciente: p.patient?.fullName || 'N/A',
          valor: p.sessionValue || 0,
          diasParaAtendimento: moment(p.date).diff(moment(), 'days')
        }))
      },
      insights,
      cache: {
        ttl: 300,
        timestamp: new Date().toISOString()
      }
    };

    // Salva no cache
    dashboardCache.set(cacheKey, response);
    console.log(`[Dashboard] Cache set: ${cacheKey}`);

    res.json(response);

  } catch (error) {
    console.error('[Dashboard] Erro:', error);
    res.status(500).json({ 
      success: false, 
      message: 'Erro ao carregar dashboard', 
      error: error.message 
    });
  }
});

/**
 * @route   GET /api/financial/dashboard/projection-daily
 * @desc    Projeção acumulada dia a dia: real passado + meta ideal + estimativa futura
 * @query   month, year, projecaoFinal (opcional — valor do cenário esperado já calculado)
 */
router.get('/projection-daily', auth, authorize(['admin', 'secretary']), async (req, res) => {
  try {
    const { month, year, projecaoFinal: projecaoParam } = req.query;
    const mes = parseInt(month) || moment().tz(TIMEZONE).month() + 1;
    const ano = parseInt(year)  || moment().tz(TIMEZONE).year();

    const diasNoMes = new Date(ano, mes, 0).getDate();
    const startStr  = `${ano}-${String(mes).padStart(2, '0')}-01`;
    const endStr    = `${ano}-${String(mes).padStart(2, '0')}-${diasNoMes}`;
    const hoje      = moment().tz(TIMEZONE).format('YYYY-MM-DD');

    const { default: Planning } = await import('../../models/Planning.js');

    // 1. Busca caixa real diário a partir do FinancialDailySnapshot (fonte única de verdade)
    const snapshots = await FinancialDailySnapshot.find({
      date: { $gte: startStr, $lte: endStr },
      clinicId: 'default'
    }).select('date cash.total').lean();

    const dailyMap = {};
    snapshots.forEach(s => { dailyMap[s.date] = s.cash?.total || 0; });

    // 2. Meta mensal do Planning
    const planning = await Planning.findOne({
      type: 'monthly',
      'period.start': { $lte: endStr },
      'period.end':   { $gte: startStr }
    }).lean();
    const meta = planning?.targets?.expectedRevenue || 0;

    // 3. Montar array dia a dia com acumulado real
    let cumReal = 0;
    let diasDecorridos = 0;
    const days = [];

    for (let d = 1; d <= diasNoMes; d++) {
      const dateStr  = `${ano}-${String(mes).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
      const isToday  = dateStr === hoje;
      const isFuture = dateStr > hoje;

      if (!isFuture) {
        cumReal += dailyMap[dateStr] || 0;
        diasDecorridos = d;
      }

      days.push({
        date:             dateStr,
        dayOfMonth:       d,
        metaIdeal:        meta > 0 ? Math.round(meta * d / diasNoMes) : null,
        realAcumulado:    isFuture ? null : Math.round(cumReal),
        projecaoAcumulada: null, // preenchido abaixo
        isToday
      });
    }

    // 4. projecaoFinal: usa param do frontend (cenário esperado) ou extrapola pelo ritmo atual
    const realHoje = cumReal;
    let projecaoFinal;
    if (projecaoParam && !isNaN(parseFloat(projecaoParam))) {
      projecaoFinal = parseFloat(projecaoParam);
    } else if (diasDecorridos >= 7) {
      projecaoFinal = Math.round((realHoje / diasDecorridos) * diasNoMes);
    } else {
      projecaoFinal = meta || Math.round((realHoje / Math.max(diasDecorridos, 1)) * diasNoMes);
    }

    // 5. Distribuir o restante linearmente pelos dias futuros
    const diasRestantes      = diasNoMes - diasDecorridos;
    const remainingProjected = Math.max(0, projecaoFinal - realHoje);
    const perDay             = diasRestantes > 0 ? remainingProjected / diasRestantes : 0;

    let diasFuturosContados = 0;
    days.forEach(d => {
      if (d.realAcumulado !== null) {
        d.projecaoAcumulada = d.realAcumulado;
      } else {
        diasFuturosContados++;
        d.projecaoAcumulada = Math.round(realHoje + perDay * diasFuturosContados);
      }
    });

    const metaIdealHoje = meta > 0 ? Math.round(meta * diasDecorridos / diasNoMes) : 0;

    res.json({
      success: true,
      data: days,
      meta: {
        metaMensal: meta,
        realHoje,
        projecaoFinal,
        diasDecorridos,
        diasRestantes,
        metaIdealHoje,
        isBehind: meta > 0 && realHoje < metaIdealHoje,
        gapPercent: metaIdealHoje > 0 ? Number(((realHoje / metaIdealHoje) - 1).toFixed(4)) : 0
      }
    });

  } catch (error) {
    console.error('[Dashboard] Erro projection-daily:', error);
    res.status(500).json({ success: false, message: error.message });
  }
});

/**
 * @route   POST /api/financial/dashboard/cache/clear
 * @desc    Limpa o cache do dashboard (útil após atualizações)
 */
router.post('/cache/clear', auth, authorize(['admin']), (req, res) => {
  dashboardCache.flushAll();
  console.log('[Dashboard] Cache limpo');
  res.json({ success: true, message: 'Cache limpo com sucesso' });
});

/**
 * @route   GET /api/financial/dashboard/cache/stats
 * @desc    Retorna estatísticas do cache
 */
router.get('/cache/stats', auth, authorize(['admin']), (req, res) => {
  const stats = dashboardCache.getStats();
  const keys = dashboardCache.keys();
  res.json({
    success: true,
    stats,
    keysCount: keys.length,
    keys: keys.slice(0, 20) // Limita a 20 keys para não sobrecarregar
  });
});

/**
 * @route   GET /api/financial/dashboard/debitos
 * @desc    Todos os pagamentos pendentes — fonte de verdade: Payment
 *          💰 V2 RULE: nunca mais usar Appointment/Session para valor financeiro
 *          Usado para o card "Débito Total" no dashboard executivo
 */
router.get('/debitos', auth, authorize(['admin', 'secretary']), async (req, res) => {
  try {
    const { default: Payment } = await import('../../models/Payment.js');
    const { month, year } = req.query;

    const query = { status: 'pending' };
    if (month && year) {
      const start = new Date(`${year}-${String(month).padStart(2, '0')}-01T00:00:00.000Z`);
      const end = new Date(start.getFullYear(), start.getMonth() + 1, 0, 23, 59, 59, 999);
      query.paymentDate = { $gte: start, $lte: end };
    }

    const payments = await Payment.find(query)
      .populate('patient', 'fullName')
      .populate('appointment', 'date time')
      .sort({ paymentDate: -1 })
      .lean();

    const debitos = payments.map(p => ({
      _id: p._id,
      date: p.appointment?.date || (p.serviceDate ? p.serviceDate.toISOString().split('T')[0] : (p.paymentDate ? p.paymentDate.toISOString().split('T')[0] : null)),
      time: p.appointment?.time || null,
      paymentStatus: p.status,
      paciente: p.patient?.fullName || 'Paciente',
      valor: p.amount,
      tipo: p.paymentMethod || p.billingType || 'N/A'
    }));

    const total = debitos.reduce((s, d) => s + (d.valor || 0), 0);

    res.json({ success: true, data: debitos, total });
  } catch (error) {
    console.error('[Dashboard] Erro /debitos:', error);
    res.status(500).json({ success: false, message: error.message });
  }
});

/**
 * @route   GET /api/financial/dashboard/reconciliation
 * @desc    Reconciliação Payment vs Ledger para todos os pacientes com saldo
 */
router.get('/reconciliation', auth, authorize(['admin']), async (req, res) => {
  try {
    const { reconcileAllLedgers } = await import('../../services/reconciliationService.js');
    const result = await reconcileAllLedgers();
    res.json({
      success: true,
      timestamp: new Date().toISOString(),
      ...result
    });
  } catch (error) {
    console.error('[Dashboard] Erro /reconciliation:', error);
    res.status(500).json({ success: false, message: error.message });
  }
});

// Exporta cache para invalidação externa (ex: quando processar retorno de convênio)
export { dashboardCache };

export default router;
