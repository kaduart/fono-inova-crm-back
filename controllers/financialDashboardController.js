/**
 * 📊 Financial Dashboard Controller - API Unificada
 * 
 * Combina dados de provisionamento, projeção, BI e analytics
 * em uma única resposta para o Dashboard Financeiro.
 */

import { calcularProvisionamento } from '../services/provisionamentoService.js';
import Package from '../models/Package.js';
import Session from '../models/Session.js';
import moment from 'moment-timezone';

const TIMEZONE = 'America/Sao_Paulo';

/**
 * Get dashboard unificado
 * GET /api/financial/dashboard?month=3&year=2026
 */
export const getDashboard = async (req, res) => {
  try {
    const { month, year, view = 'month' } = req.query;
    
    const mes = parseInt(month) || moment().tz(TIMEZONE).month() + 1;
    const ano = parseInt(year) || moment().tz(TIMEZONE).year();
    
    console.log(`[DASHBOARD] Gerando dashboard para ${mes}/${ano}`);
    
    // Executa provisionamento
    const provisionamento = await calcularProvisionamento(mes, ano);
    
    // Extrai dados das camadas
    const camadas = provisionamento.camadas;
    
    // Calcula status do período
    const hoje = moment().tz(TIMEZONE);
    const inicioMes = moment.tz({ year: ano, month: mes - 1, day: 1 }, TIMEZONE);
    const fimMes = moment(inicioMes).endOf('month');
    
    let status = 'ATUAL';
    if (fimMes.isBefore(hoje, 'day')) status = 'PASSADO';
    if (inicioMes.isAfter(hoje, 'day')) status = 'FUTURO';
    
    // Produção = garantido (caixa) + sessões realizadas mas não pagas
    // Vamos buscar a produção real das sessões completed
    const Session = (await import('../models/Session.js')).default;
    const sessoesRealizadas = await Session.find({
      status: 'completed',
      date: { $gte: inicioMes.format('YYYY-MM-DD'), $lte: fimMes.format('YYYY-MM-DD') }
    }).populate('package', 'insuranceGrossAmount type').lean();

    let producaoParticular = 0;
    let producaoPacotes = 0;
    let producaoConvenio = 0;

    sessoesRealizadas.forEach(s => {
      const valor = s.sessionValue || s.package?.insuranceGrossAmount || 0;
      if (s.paymentMethod === 'convenio') {
        producaoConvenio += valor;
      } else if (s.package) {
        producaoPacotes += valor;
      } else {
        producaoParticular += valor;
      }
    });

    const producaoTotal = producaoParticular + producaoPacotes + producaoConvenio;
    const caixaTotal = camadas.garantido?.valor || 0;
    
    // Constrói resumo unificado
    const resumo = {
      producao: producaoTotal,
      producaoDetalhe: {
        particular: producaoParticular,
        pacotes: producaoPacotes,
        convenio: producaoConvenio
      },
      caixa: caixaTotal,
      creditoPacotes: camadas.creditoPacotes?.valor || 0,
      convenioAgendado: camadas.convenioAgendado?.valor || 0,
      agendadoConfirmado: camadas.agendadoConfirmado?.valorBruto || 0,
      pendenteConfirmacao: camadas.agendadoPendente?.valorBruto || 0,
      provisionamento: provisionamento.total || 0
    };
    
    // Cenários de projeção calculados localmente
    const agendadoConfirmado = camadas.agendadoConfirmado?.valorBruto || 0;
    const agendadoPendente = camadas.agendadoPendente?.valorBruto || 0;
    const creditoPacotes = camadas.creditoPacotes?.valor || 0;
    const convenioAgendado = camadas.convenioAgendado?.valor || 0;

    const cenarios = {
      pessimista: {
        valor: Math.round(producaoTotal + (agendadoConfirmado * 0.7) + (agendadoPendente * 0.2) + (creditoPacotes * 0.8) + (convenioAgendado * 0.7)),
        probabilidade: 'Baixa'
      },
      realista: {
        valor: Math.round(producaoTotal + (agendadoConfirmado * 0.85) + (agendadoPendente * 0.40) + (creditoPacotes * 0.90) + (convenioAgendado * 0.85)),
        probabilidade: 'Alta'
      },
      otimista: {
        valor: Math.round(producaoTotal + (agendadoConfirmado * 0.95) + (agendadoPendente * 0.70) + (creditoPacotes * 0.95) + (convenioAgendado * 0.95)),
        probabilidade: 'Média'
      }
    };
    
    // Meta simulada (pode vir de um planning futuramente)
    // Por enquanto, calculamos uma meta baseada no histórico ou usamos um valor fixo
    const metaMensal = 0; // Será preenchido pelo frontend ou buscado do Planning
    const percentualMeta = metaMensal > 0 ? (producaoTotal / metaMensal) * 100 : 0;
    
    // Gera insights automáticos
    const insights = gerarInsights(resumo, camadas, cenarios);
    
    // Analítico por especialidade e profissional
    const analitico = await calcularAnalitico(inicioMes.format('YYYY-MM-DD'), fimMes.format('YYYY-MM-DD'));
    
    // Detalhes de agendamentos
    const detalhes = await buscarDetalhes(inicioMes.format('YYYY-MM-DD'), fimMes.format('YYYY-MM-DD'));
    
    // Resposta unificada
    const response = {
      success: true,
      periodo: {
        mes,
        ano,
        tipo: view,
        inicio: inicioMes.format('YYYY-MM-DD'),
        fim: fimMes.format('YYYY-MM-DD'),
        status
      },
      resumo,
      cenarios,
      meta: {
        valor: metaMensal,
        percentualAtual: Math.round(percentualMeta * 100) / 100,
        gap: metaMensal > 0 ? Math.max(0, metaMensal - producaoTotal) : 0
      },
      analitico,
      detalhes,
      insights,
      camadas // Mantém para backward compatibility
    };
    
    res.json(response);
    
  } catch (error) {
    console.error('[DASHBOARD] Erro:', error);
    res.status(500).json({
      success: false,
      message: 'Erro ao gerar dashboard',
      error: error.message
    });
  }
};

/**
 * Calcula dados analíticos por especialidade e profissional
 */
async function calcularAnalitico(inicio, fim) {
  const Session = (await import('../models/Session.js')).default;
  
  const sessoes = await Session.find({
    status: 'completed',
    date: { $gte: inicio, $lte: fim }
  }).populate('doctor', 'fullName specialty').lean();

  // Por especialidade
  const porEspecialidade = {};
  // Por profissional
  const porProfissional = {};

  sessoes.forEach(s => {
    const valor = s.sessionValue || s.package?.insuranceGrossAmount || 0;
    const esp = s.sessionType || 'nao_informada';
    const docId = s.doctor?._id?.toString();
    const docNome = s.doctor?.fullName || 'Profissional';
    const docEsp = s.doctor?.specialty || 'N/A';

    // Especialidade
    if (!porEspecialidade[esp]) {
      porEspecialidade[esp] = { producao: 0, sessoes: 0, pacientesUnicos: new Set() };
    }
    porEspecialidade[esp].producao += valor;
    porEspecialidade[esp].sessoes += 1;
    if (s.patient) porEspecialidade[esp].pacientesUnicos.add(s.patient.toString());

    // Profissional
    if (docId) {
      if (!porProfissional[docId]) {
        porProfissional[docId] = { 
          id: docId, 
          nome: docNome, 
          especialidade: docEsp,
          producao: 0, 
          sessoes: 0, 
          pacientesUnicos: new Set() 
        };
      }
      porProfissional[docId].producao += valor;
      porProfissional[docId].sessoes += 1;
      if (s.patient) porProfissional[docId].pacientesUnicos.add(s.patient.toString());
    }
  });

  return {
    porEspecialidade: Object.entries(porEspecialidade).map(([especialidade, dados]) => ({
      especialidade,
      producao: dados.producao,
      sessoes: dados.sessoes,
      ticketMedio: dados.sessoes > 0 ? dados.producao / dados.sessoes : 0,
      pacientesUnicos: dados.pacientesUnicos.size
    })),
    porProfissional: Object.values(porProfissional).map((dados) => ({
      id: dados.id,
      nome: dados.nome,
      especialidade: dados.especialidade,
      producao: dados.producao,
      sessoes: dados.sessoes,
      ticketMedio: dados.sessoes > 0 ? dados.producao / dados.sessoes : 0,
      pacientesUnicos: dados.pacientesUnicos.size
    })).sort((a, b) => b.producao - a.producao)
  };
}

/**
 * Busca detalhes de realizados, agendados e pendentes
 */
async function buscarDetalhes(inicio, fim) {
  const Session = (await import('../models/Session.js')).default;
  const Appointment = (await import('../models/Appointment.js')).default;

  // Sessões realizadas
  const realizados = await Session.find({
    status: 'completed',
    date: { $gte: inicio, $lte: fim }
  }).populate('patient', 'fullName').lean();

  // Agendados confirmados (avulsos, sem pacote)
  const agendados = await Appointment.find({
    date: { $gte: inicio, $lte: fim },
    operationalStatus: { $in: ['confirmed', 'scheduled'] },
    clinicalStatus: { $nin: ['completed', 'cancelled'] },
    package: { $exists: false }
  }).populate('patient', 'fullName').lean();

  // Pendentes
  const pendentes = await Appointment.find({
    date: { $gte: inicio, $lte: fim },
    $or: [{ operationalStatus: 'pending' }, { operationalStatus: { $exists: false } }],
    clinicalStatus: { $ne: 'completed' },
    package: { $exists: false }
  }).populate('patient', 'fullName').lean();

  return {
    realizados: realizados.map(s => ({
      _id: s._id,
      data: s.date,
      hora: s.time,
      paciente: s.patient?.fullName || s.patientName || 'Paciente',
      tipo: s.paymentMethod === 'convenio' 
        ? (s.package ? 'Convênio Pacote' : 'Convênio Avulso')
        : (s.package ? 'Pacote Particular' : 'Particular'),
      valor: s.sessionValue || s.package?.insuranceGrossAmount || 0
    })),
    agendados: agendados.map(a => ({
      _id: a._id,
      data: a.date,
      hora: a.time,
      paciente: a.patient?.fullName || 'N/A',
      valor: a.sessionValue || 0
    })),
    pendentes: pendentes.map(p => ({
      _id: p._id,
      data: p.date,
      hora: p.time,
      paciente: p.patient?.fullName || 'N/A',
      valor: p.sessionValue || 0,
      diasParaAtendimento: moment(p.date).diff(moment(), 'days')
    }))
  };
}

/**
 * Gera insights automáticos baseados nos dados
 */
function gerarInsights(resumo, camadas, cenarios) {
  const insights = [];
  
  // Insight: Baixa conversão de pendentes
  if (resumo.pendenteConfirmacao > resumo.agendadoConfirmado * 0.5) {
    insights.push({
      tipo: 'warning',
      titulo: 'Muitos agendamentos pendentes',
      mensagem: `Você tem R$ ${resumo.pendenteConfirmacao.toLocaleString('pt-BR')} em agendamentos aguardando confirmação.`,
      acao: 'Revisar lista de pendentes'
    });
  }
  
  // Insight: Crédito alto em pacotes
  if (resumo.creditoPacotes > 5000) {
    insights.push({
      tipo: 'info',
      titulo: 'Alto crédito em pacotes',
      mensagem: `R$ ${resumo.creditoPacotes.toLocaleString('pt-BR')} em sessões pagas aguardando agendamento.`,
      acao: 'Contatar pacientes para agendar'
    });
  }
  
  // Insight: Projeção vs Meta
  const projecaoRealista = cenarios.realista?.valor || 0;
  if (projecaoRealista > 0) {
    insights.push({
      tipo: 'info',
      titulo: 'Projeção de fechamento',
      mensagem: `Projeção realista para o período: R$ ${projecaoRealista.toLocaleString('pt-BR')}.`,
      acao: 'Verificar cenários'
    });
  }
  
  // Insight: Convênios a receber
  if (resumo.convenioAgendado > 0) {
    insights.push({
      tipo: 'info',
      titulo: 'Convênios agendados',
      mensagem: `R$ ${resumo.convenioAgendado.toLocaleString('pt-BR')} em convênios agendados para o período.`,
      acao: 'Verificar confirmações'
    });
  }
  
  return insights;
}

/**
 * Get comparativo mensal
 * GET /api/financial/dashboard/comparativo?meses=3
 */
export const getComparativo = async (req, res) => {
  try {
    const { meses = 3 } = req.query;
    const numMeses = parseInt(meses);
    
    const hoje = moment().tz(TIMEZONE);
    const resultados = [];
    
    for (let i = numMeses - 1; i >= 0; i--) {
      const data = moment(hoje).subtract(i, 'months');
      const mes = data.month() + 1;
      const ano = data.year();
      
      const provisionamento = await calcularProvisionamento(mes, ano);
      
      resultados.push({
        mes,
        ano,
        label: data.format('MMM/YYYY'),
        producao: 0, // Calculado separadamente se necessário
        caixa: provisionamento.camadas?.garantido?.valor || 0,
        provisionamento: provisionamento.total || 0
      });
    }
    
    res.json({
      success: true,
      data: resultados
    });
    
  } catch (error) {
    console.error('[DASHBOARD] Erro comparativo:', error);
    res.status(500).json({
      success: false,
      message: 'Erro ao gerar comparativo',
      error: error.message
    });
  }
};

export default { getDashboard, getComparativo };
