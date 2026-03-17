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

const router = express.Router();
const TIMEZONE = 'America/Sao_Paulo';

// Cache: TTL 5 minutos, verificação a cada 2 minutos
const dashboardCache = new NodeCache({ stdTTL: 300, checkperiod: 120 });

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

    // Importar models
    const { default: Session } = await import('../../models/Session.js');
    const { default: Payment } = await import('../../models/Payment.js');
    const { default: Package } = await import('../../models/Package.js');
    const { default: Appointment } = await import('../../models/Appointment.js');
    const { default: Planning } = await import('../../models/Planning.js');
    const { default: Doctor } = await import('../../models/Doctor.js');

    // ========================================
    // 1. PRODUÇÃO (Sessões completed)
    // ========================================
    const sessoesDoMes = await Session.find({
      status: 'completed',
      date: { $gte: inicioPeriodo, $lte: fimPeriodo }
    }).populate('package', 'insuranceGrossAmount type').populate('doctor', 'fullName specialty').lean();

    const valorSessao = (s) => s.sessionValue || s.package?.insuranceGrossAmount || 0;

    let producaoParticular = 0;
    let producaoPacotes = 0;
    let producaoConvenio = 0;

    sessoesDoMes.forEach(s => {
      const valor = valorSessao(s);
      if (s.paymentMethod === 'convenio') {
        producaoConvenio += valor;
      } else if (s.package) {
        producaoPacotes += valor;
      } else {
        producaoParticular += valor;
      }
    });

    const producaoTotal = producaoParticular + producaoPacotes + producaoConvenio;

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
    // 2. CAIXA (Pagamentos recebidos)
    // ========================================
    const pagamentosRecebidos = await Payment.find({
      paymentDate: { $gte: inicioPeriodo, $lte: fimPeriodo },
      status: 'paid'
    });

    const caixaTotal = pagamentosRecebidos.reduce((sum, p) => sum + (p.amount || 0), 0);

    // ========================================
    // 3. CRÉDITO PACOTES (Sessões pagas não utilizadas)
    // ========================================
    const pacotesCredito = await Package.find({
      type: { $ne: 'convenio' },
      financialStatus: { $in: ['paid', 'partially_paid'] },
      status: { $in: ['active', 'in-progress'] }
    }).populate('patient', 'fullName');

    let creditoPacotesValor = 0;
    const creditoPacotesDetalhes = [];

    for (const pkg of pacotesCredito) {
      const sessoesPkg = await Session.find({
        package: pkg._id,
        status: { $nin: ['canceled'] }
      });

      const sessoesValidas = sessoesPkg.filter(s => ['scheduled', 'confirmed', 'completed'].includes(s.status));
      const sessoesFeitas = sessoesValidas.filter(s => s.status === 'completed').length;
      const sessoesAgendadas = sessoesValidas.filter(s => ['scheduled', 'confirmed'].includes(s.status)).length;

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
    // 5. AGENDADOS E PENDENTES (Avulsos - sem pacote)
    // ========================================
    const agendadosAvulsos = await Appointment.find({
      date: { $gte: inicioPeriodo, $lte: fimPeriodo },
      operationalStatus: { $in: ['confirmed', 'scheduled'] },
      clinicalStatus: { $nin: ['completed', 'cancelled'] },
      package: { $exists: false }
    });

    const pendentesAvulsos = await Appointment.find({
      date: { $gte: inicioPeriodo, $lte: fimPeriodo },
      $or: [{ operationalStatus: 'pending' }, { operationalStatus: { $exists: false } }],
      clinicalStatus: { $ne: 'completed' },
      package: { $exists: false }
    });

    const agendadosValor = agendadosAvulsos.reduce((sum, a) => sum + (a.sessionValue || 0), 0);
    const pendentesValor = pendentesAvulsos.reduce((sum, a) => sum + (a.sessionValue || 0), 0);

    // ========================================
    // 6. CENÁRIOS DE PROJEÇÃO
    // ========================================
    const taxaConversao = 0.85;

    const cenarios = {
      pessimista: {
        valor: Math.round(producaoTotal + (agendadosValor * 0.7) + (pendentesValor * 0.2) + (creditoPacotesValor * 0.8) + (convenioAgendadoValor * 0.7)),
        probabilidade: ehPeriodoPassado ? 'Realizado' : 'Baixa'
      },
      realista: {
        valor: Math.round(producaoTotal + (agendadosValor * 0.85) + (pendentesValor * taxaConversao * 0.6) + (creditoPacotesValor * 0.90) + (convenioAgendadoValor * 0.85)),
        probabilidade: ehPeriodoPassado ? 'Realizado' : 'Alta'
      },
      otimista: {
        valor: Math.round(producaoTotal + (agendadosValor * 0.95) + (pendentesValor * 0.7) + (creditoPacotesValor * 0.95) + (convenioAgendadoValor * 0.95)),
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
    const percentualMeta = metaMensal > 0 ? (producaoTotal / metaMensal) * 100 : 0;

    // ========================================
    // 8. INSIGHTS
    // ========================================
    const insights = [];
    if (ehPeriodoAtual && metaMensal > 0) {
      const gap = metaMensal - producaoTotal - agendadosValor - creditoPacotesValor - convenioAgendadoValor;
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
        creditoPacotes: creditoPacotesValor,
        convenioAgendado: convenioAgendadoValor,
        agendadoConfirmado: agendadosValor,
        pendenteConfirmacao: pendentesValor,
        provisionamento: producaoTotal + creditoPacotesValor + convenioAgendadoValor + agendadosValor
      },
      // Para Inteligência Financeira
      cenarios,
      meta: {
        valor: metaMensal,
        percentualAtual: Math.round(percentualMeta * 100) / 100,
        gap: metaMensal > 0 ? Math.max(0, metaMensal - producaoTotal) : 0
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
          paciente: s.patientName || 'Paciente',
          tipo: s.paymentMethod === 'convenio' 
            ? (s.package ? 'Convênio Pacote' : 'Convênio Avulso')
            : (s.package ? 'Pacote Particular' : 'Particular'),
          valor: valorSessao(s)
        })),
        creditoPacotes: creditoPacotesDetalhes,
        convenioAgendado: convenioAgendadoDetalhes,
        agendados: agendadosAvulsos.map(a => ({
          _id: a._id,
          data: a.date,
          hora: a.time,
          paciente: a.patient?.fullName || 'N/A',
          valor: a.sessionValue || 0
        })),
        pendentes: pendentesAvulsos.map(p => ({
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

export default router;
