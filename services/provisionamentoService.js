import moment from 'moment-timezone';
import Appointment from '../models/Appointment.js';
import Payment from '../models/Payment.js';
import Package from '../models/Package.js';
import Expense from '../models/Expense.js';
import Lead from '../models/Leads.js';

const TIMEZONE = 'America/Sao_Paulo';

/**
 * Calcula provisionamento mensal completo
 * Camadas: Garantido + Agendado(Confirmed) + Agendado(Pending) + Pipeline
 */
export const calcularProvisionamento = async (mes, ano) => {
  const startDate = `${ano}-${String(mes).padStart(2, '0')}-01`;
  const endDate = moment(`${ano}-${mes}-01`).endOf('month').format('YYYY-MM-DD');
  
  const periodo = { inicio: startDate, fim: endDate };
  
  // Executar em paralelo
  const [
    garantido,
    agendadoConfirmado,
    agendadoPendente,
    pipeline,
    custosFixos,
    metricasHistoricas
  ] = await Promise.all([
    calcularGarantido(periodo),
    calcularAgendadoConfirmado(periodo),
    calcularAgendadoPendente(periodo),
    calcularPipeline(periodo),
    calcularCustosFixos(periodo),
    calcularMetricasHistoricas()
  ]);

  // Aplicar taxas de risco
  const agendadoAltoRisco = agendadoConfirmado.total * 0.85; // 85% comparecem
  const agendadoMedioRisco = agendadoPendente.total * 0.40;  // 40% confirma e vai
  
  const totalProvisionado = garantido + agendadoAltoRisco + agendadoMedioRisco + pipeline;
  const indiceCerteza = totalProvisionado > 0 ? garantido / totalProvisionado : 0;
  
  // Break-even (20% de margem mínima)
  const breakEven = custosFixos * 1.2;
  
  return {
    periodo: { mes: parseInt(mes), ano: parseInt(ano), inicio: startDate, fim: endDate },
    
    camadas: {
      garantido: {
        valor: Math.round(garantido),
        percentual: totalProvisionado > 0 ? Math.round((garantido / totalProvisionado) * 100) : 0,
        certeza: 0.95,
        cor: 'success'
      },
      agendadoConfirmado: {
        valor: Math.round(agendadoAltoRisco),
        valorBruto: Math.round(agendadoConfirmado.total),
        percentual: totalProvisionado > 0 ? Math.round((agendadoAltoRisco / totalProvisionado) * 100) : 0,
        quantidade: agendadoConfirmado.quantidade,
        certeza: 0.80,
        cor: 'warning'
      },
      agendadoPendente: {
        valor: Math.round(agendadoMedioRisco),
        valorBruto: Math.round(agendadoPendente.total),
        percentual: totalProvisionado > 0 ? Math.round((agendadoMedioRisco / totalProvisionado) * 100) : 0,
        quantidade: agendadoPendente.quantidade,
        certeza: 0.40,
        cor: 'error',
        detalhes: agendadoPendente.detalhes
      },
      pipeline: {
        valor: Math.round(pipeline),
        percentual: totalProvisionado > 0 ? Math.round((pipeline / totalProvisionado) * 100) : 0,
        certeza: 0.20,
        cor: 'info'
      }
    },
    
    total: Math.round(totalProvisionado),
    indiceCerteza: parseFloat(indiceCerteza.toFixed(2)),
    
    status: indiceCerteza >= 0.70 ? 'SEGURO' : 
            indiceCerteza >= 0.40 ? 'ATENCAO' : 'PERIGO',
    
    custos: {
      fixos: custosFixos,
      breakEven: breakEven,
      margemSeguranca: Math.round(totalProvisionado - breakEven),
      diasParaBreakEven: calcularDiasParaBreakEven(garantido, custosFixos, moment().tz(TIMEZONE))
    },
    
    porEspecialidade: agruparPorEspecialidade({
      agendadoConfirmado: agendadoConfirmado.porEspecialidade,
      agendadoPendente: agendadoPendente.porEspecialidade
    }),
    
    metricas: {
      taxaConfirmacao24h: metricasHistoricas.taxaConfirmacao,
      taxaPresenca: metricasHistoricas.taxaPresenca
    },
    
    alertas: gerarAlertas({
      indiceCerteza,
      agendadoPendente,
      custosFixos,
      totalProvisionado
    })
  };
};

// ==================== CÁLCULOS POR CAMADA ====================

/**
 * Camada 1: GARANTIDO (dinheiro já recebido)
 * - Payments 'paid' do período
 * - Crédito remanescente de pacotes ativos (sessões pagas não consumidas)
 */
const calcularGarantido = async (periodo) => {
  // Pagamentos recebidos no mês
  const payments = await Payment.find({
    status: 'paid',
    paymentDate: { $gte: periodo.inicio, $lte: periodo.fim }
  });
  
  const totalPayments = payments.reduce((sum, p) => sum + (p.amount || 0), 0);
  
  // Crédito remanescente de pacotes (sessões pagas não consumidas)
  const pacotes = await Package.find({
    financialStatus: { $in: ['paid', 'partially_paid'] },
    status: { $in: ['active', 'in-progress'] }
  });
  
  const creditoPacotes = pacotes.reduce((sum, pkg) => {
    const sessoesPagas = pkg.paidSessions || 0;
    const sessoesFeitas = pkg.sessionsDone || 0;
    const sessoesRemanescentes = Math.max(0, sessoesPagas - sessoesFeitas);
    return sum + (sessoesRemanescentes * (pkg.sessionValue || 0));
  }, 0);
  
  return totalPayments + creditoPacotes;
};

/**
 * Camada 2: AGENDADO CONFIRMADO (operationalStatus: confirmed/scheduled)
 */
const calcularAgendadoConfirmado = async (periodo) => {
  const agendamentos = await Appointment.find({
    date: { $gte: periodo.inicio, $lte: periodo.fim },
    operationalStatus: { $in: ['confirmed', 'scheduled'] },
    paymentStatus: { $nin: ['paid', 'package_paid'] } // Não contar já pagos
  }).select('sessionValue specialty serviceType');
  
  const porEspecialidade = {};
  agendamentos.forEach(apt => {
    const key = `${apt.specialty}_${apt.serviceType}`;
    porEspecialidade[key] = (porEspecialidade[key] || 0) + (apt.sessionValue || 0);
  });
  
  return {
    total: agendamentos.reduce((sum, a) => sum + (a.sessionValue || 0), 0),
    quantidade: agendamentos.length,
    porEspecialidade
  };
};

/**
 * Camada 3: AGENDADO PENDENTE (agenda temporária - operationalStatus: pending)
 */
const calcularAgendadoPendente = async (periodo) => {
  const pendentes = await Appointment.find({
    date: { $gte: periodo.inicio, $lte: periodo.fim },
    operationalStatus: 'pending'
  }).select('sessionValue specialty serviceType patient date time').populate('patient', 'fullName');
  
  const agora = moment().tz(TIMEZONE);
  const porEspecialidade = {};
  
  const detalhes = pendentes.map(apt => {
    const dataApt = moment(apt.date);
    const horasRestantes = dataApt.diff(agora, 'hours');
    const risco = horasRestantes <= 24 ? 'urgente' : 
                  horasRestantes <= 72 ? 'medio' : 'baixo';
    
    const key = `${apt.specialty}_${apt.serviceType}`;
    porEspecialidade[key] = (porEspecialidade[key] || 0) + (apt.sessionValue || 0);
    
    return {
      id: apt._id,
      paciente: apt.patient?.fullName,
      data: apt.date,
      hora: apt.time,
      valor: apt.sessionValue,
      especialidade: apt.specialty,
      horasRestantes,
      risco,
      acaoSugerida: risco === 'urgente' ? 'ligar_agora' : 
                    risco === 'medio' ? 'enviar_lembrete' : 'aguardar'
    };
  });
  
  return {
    total: pendentes.reduce((sum, a) => sum + (a.sessionValue || 0), 0),
    quantidade: pendentes.length,
    porEspecialidade,
    detalhes
  };
};

/**
 * Camada 4: PIPELINE (leads quentes em estágio avançado)
 */
const calcularPipeline = async (periodo) => {
  // Leads em estágio avançado de conversão
  const leads = await Lead.find({
    status: { $in: ['interessado_agendamento', 'triagem_agendamento', 'agendado'] },
    createdAt: { $gte: new Date(periodo.inicio) }
  });
  
  // Valor estimado baseado na especialidade (ticket médio estimado)
  const ticketMedio = 180; // R$ 180 média
  return leads.length * ticketMedio * 0.30; // 30% de conversão estimada
};

/**
 * CUSTOS FIXOS (para break-even)
 */
const calcularCustosFixos = async (periodo) => {
  // Despesas fixas do mês
  const despesas = await Expense.find({
    date: { $gte: periodo.inicio, $lte: periodo.fim },
    status: 'paid',
    $or: [
      { isRecurring: true },
      { category: { $in: ['payroll', 'operational'] } }
    ]
  });
  
  return despesas.reduce((sum, d) => sum + (d.amount || 0), 0);
};

/**
 * MÉTRICAS HISTÓRICAS (últimos 90 dias)
 */
const calcularMetricasHistoricas = async () => {
  const dataCorte = moment().subtract(90, 'days').toDate();
  
  // Taxa de confirmação (pending → confirmed/scheduled)
  const pendingTotal = await Appointment.countDocuments({
    operationalStatus: 'pending',
    createdAt: { $gte: dataCorte }
  });
  
  const confirmedTotal = await Appointment.countDocuments({
    operationalStatus: { $in: ['confirmed', 'scheduled'] },
    createdAt: { $gte: dataCorte }
  });
  
  const taxaConfirmacao = (pendingTotal + confirmedTotal) > 0 
    ? confirmedTotal / (pendingTotal + confirmedTotal) 
    : 0.50;
  
  // Taxa de presença (confirmed/scheduled → completed)
  const agendadosTotal = await Appointment.countDocuments({
    operationalStatus: { $in: ['confirmed', 'scheduled'] },
    date: { $gte: moment().subtract(30, 'days').format('YYYY-MM-DD') }
  });
  
  const completedTotal = await Appointment.countDocuments({
    clinicalStatus: 'completed',
    date: { $gte: moment().subtract(30, 'days').format('YYYY-MM-DD') }
  });
  
  const taxaPresenca = agendadosTotal > 0 ? completedTotal / agendadosTotal : 0.85;
  
  return {
    taxaConfirmacao: parseFloat(taxaConfirmacao.toFixed(2)),
    taxaPresenca: parseFloat(taxaPresenca.toFixed(2))
  };
};

// ==================== HELPERS ====================

const agruparPorEspecialidade = (dados) => {
  const resultado = {};
  
  // Consolidar dados de diferentes camadas
  Object.keys(dados).forEach(camada => {
    const porEspec = dados[camada];
    Object.keys(porEspec || {}).forEach(key => {
      if (!resultado[key]) {
        resultado[key] = { especialidade: key, confirmado: 0, pendente: 0, total: 0 };
      }
      if (camada === 'agendadoConfirmado') {
        resultado[key].confirmado += porEspec[key];
      } else if (camada === 'agendadoPendente') {
        resultado[key].pendente += porEspec[key];
      }
      resultado[key].total = resultado[key].confirmado + resultado[key].pendente;
    });
  });
  
  return Object.values(resultado);
};

const calcularDiasParaBreakEven = (garantido, custosFixos, dataAtual) => {
  if (garantido >= custosFixos) return 0;
  if (custosFixos <= 0) return 0;
  
  const diaAtual = dataAtual.date();
  if (diaAtual <= 0) return 30;
  
  const mediaDiaria = garantido / diaAtual;
  if (mediaDiaria <= 0) return 30;
  
  const diasNecessarios = (custosFixos - garantido) / mediaDiaria;
  return Math.max(0, Math.ceil(diasNecessarios));
};

const gerarAlertas = ({ indiceCerteza, agendadoPendente, custosFixos, totalProvisionado }) => {
  const alertas = [];
  
  if (indiceCerteza < 0.40) {
    alertas.push({
      tipo: 'error',
      mensagem: 'Índice de certeza crítico (< 40%). Acionar protocolo de emergência!',
      acao: 'revisar_pendencias'
    });
  } else if (indiceCerteza < 0.70) {
    alertas.push({
      tipo: 'warning',
      mensagem: 'Índice de certeza baixo. Focar em confirmar agendamentos pendentes.',
      acao: 'confirmar_agendamentos'
    });
  }
  
  const urgentes = agendadoPendente.detalhes?.filter(d => d.risco === 'urgente') || [];
  if (urgentes.length > 0) {
    alertas.push({
      tipo: 'error',
      mensagem: `${urgentes.length} agendamentos precisam de confirmação nas próximas 24h`,
      acao: 'ligar_urgente',
      itens: urgentes
    });
  }
  
  if (totalProvisionado < custosFixos) {
    alertas.push({
      tipo: 'warning',
      mensagem: `Provisionamento (${Math.round(totalProvisionado)}) abaixo dos custos fixos (${Math.round(custosFixos)})`,
      acao: 'aumentar_captacao'
    });
  }
  
  return alertas;
};

// ==================== API PÚBLICA ====================

export const confirmarAgendamentosMassa = async (ids) => {
  const resultado = await Appointment.updateMany(
    { _id: { $in: ids } },
    { 
      $set: { 
        operationalStatus: 'confirmed',
        confirmedAt: new Date()
      },
      $push: {
        history: {
          action: 'confirmado_de_pending',
          newStatus: 'confirmed',
          timestamp: new Date(),
          context: 'provisionamento_massa'
        }
      }
    }
  );
  return { sucesso: true, quantidade: resultado.modifiedCount };
};

export const liberarVagasMassa = async (ids, motivo = 'Não confirmou') => {
  const resultado = await Appointment.updateMany(
    { _id: { $in: ids } },
    { 
      $set: { 
        operationalStatus: 'canceled',
        clinicalStatus: 'missed',
        canceledAt: new Date(),
        cancelReason: motivo
      },
      $push: {
        history: {
          action: 'cancelado_pendente',
          newStatus: 'canceled',
          timestamp: new Date(),
          context: motivo
        }
      }
    }
  );
  return { sucesso: true, quantidade: resultado.modifiedCount };
};
