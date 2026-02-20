import moment from 'moment-timezone';
import Appointment from '../models/Appointment.js';
import Expense from '../models/Expense.js';
import Lead from '../models/Leads.js';
import Package from '../models/Package.js';
import Payment from '../models/Payment.js';
import Patient from '../models/Patient.js';
import Doctor from '../models/Doctor.js';

const TIMEZONE = 'America/Sao_Paulo';

/**
 * Calcula provisionamento mensal completo
 * Camadas: Garantido + Agendado(Confirmed) + Agendado(Pending) + Pipeline
 */
export const calcularProvisionamento = async (mes, ano) => {
  const startDate = `${ano}-${String(mes).padStart(2, '0')}-01`;

  const endDate = moment(`${ano}-${String(mes).padStart(2, '0')}-01`).endOf('month').format('YYYY-MM-DD');

  const periodo = { inicio: startDate, fim: endDate };

  // Executar em paralelo
  const [
    garantido,
    creditoPacotes,
    agendadoConfirmado,
    agendadoPendente,
    pipeline,
    custosFixos,
    metricasHistoricas
  ] = await Promise.all([
    calcularGarantido(periodo),
    calcularCreditoPacotes(periodo),
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
      creditoPacotes: {
        valor: Math.round(creditoPacotes.total),
        percentual: 0,
        certeza: 0.90,
        cor: 'info',
        detalhes: creditoPacotes.detalhes
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
 * Camada 1: GARANTIDO (dinheiro já recebido no período)
 * - Apenas Payments 'paid' do período (dinheiro que efetivamente entrou no caixa)
 * - NÃO inclui crédito de pacotes (não é dinheiro realizado no mês)
 */
const calcularGarantido = async (periodo) => {
  // Pagamentos recebidos no mês
  const payments = await Payment.find({
    status: 'paid',
    paymentDate: { $gte: periodo.inicio, $lte: periodo.fim }
  });

  return payments.reduce((sum, p) => sum + (p.amount || 0), 0);
};

/**
 * Crédito em Pacotes (dinheiro "preso" em sessões pagas não utilizadas)
 * - Sessões já pagas mas ainda não consumidas
 * - Não é caixa do mês, mas é dinheiro que o cliente pode usar
 */
const calcularCreditoPacotes = async (periodo) => {
  const pacotes = await Package.find({
    financialStatus: { $in: ['paid', 'partially_paid'] },
    status: { $in: ['active', 'in-progress'] }
  }).populate('patient', 'fullName');

  const detalhes = [];
  
  const total = pacotes.reduce((sum, pkg) => {
    const sessoesPagas = pkg.paidSessions || 0;
    const sessoesFeitas = pkg.sessionsDone || 0;
    const sessoesRemanescentes = Math.max(0, sessoesPagas - sessoesFeitas);
    const valor = sessoesRemanescentes * (pkg.sessionValue || 0);
    
    if (valor > 0) {
      detalhes.push({
        pacoteId: pkg._id,
        paciente: pkg.patient?.fullName || 'N/A',
        sessoesRemanescentes,
        valorPorSessao: pkg.sessionValue,
        valorTotal: valor
      });
    }
    
    return sum + valor;
  }, 0);

  return { total, detalhes };
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
    $or: [
      { operationalStatus: 'pending' },
      { operationalStatus: 'scheduled' },
      { operationalStatus: { $exists: false } }
    ],
    clinicalStatus: { $nin: ['completed', 'cancelled'] }
  })
    .select('sessionValue specialty serviceType patient date time')
    .populate('patient', 'fullName');

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



/**
 * Busca pacotes em andamento para a aba de Pacotes
 */
export const getPacotesEmAndamento = async () => {
  const Package = (await import('../models/Package.js')).default;

  const packages = await Package.aggregate([
    {
      $match: {
        $or: [
          { status: { $in: ['active', 'in-progress'] } },
          { financialStatus: { $in: ['paid', 'partially_paid'] } }
        ]
      }
    },
    {
      $lookup: {
        from: 'sessions', // Nome da coleção no MongoDB
        let: { pkgId: '$_id' },
        pipeline: [
          {
            $match: {
              $expr: { $eq: ['$package', '$$pkgId'] },
              status: { $in: ['completed', 'realizado'] }
            }
          },
          { $count: 'count' }
        ],
        as: 'sessionCount'
      }
    },
    {
      $addFields: {
        sessoesRealizadas: { $ifNull: [{ $arrayElemAt: ['$sessionCount.count', 0] }, 0] }
      }
    },
    {
      $match: {
        $expr: {
          $lt: [
            '$sessoesRealizadas',
            { $ifNull: ['$totalSessions', 1] }
          ]
        }
      }
    },
    {
      $lookup: { from: 'patients', localField: 'patient', foreignField: '_id', as: 'patientDoc' }
    },
    {
      $lookup: { from: 'doctors', localField: 'doctor', foreignField: '_id', as: 'doctorDoc' }
    },
    { $unwind: { path: '$patientDoc', preserveNullAndEmptyArrays: true } },
    { $unwind: { path: '$doctorDoc', preserveNullAndEmptyArrays: true } }
  ]);

  return packages.map((pkg, index) => {
    const totalSessoes = pkg.totalSessions || 1;
    const sessoesRealizadas = pkg.sessoesRealizadas || 0;
    const percentual = (sessoesRealizadas / totalSessoes) * 100;
    const valorTotal = pkg.totalValue || 0;
    const valorPorSessao = valorTotal / totalSessoes;
    const valorProvisionado = valorPorSessao * sessoesRealizadas;

    return {
      ID: index + 1,
      'Data Venda': pkg.createdAt ? moment(pkg.createdAt).format('YYYY-MM-DD') : moment().format('YYYY-MM-DD'),
      Cliente: pkg.patientDoc?.fullName || 'N/A',
      Pacote: `Pacote ${totalSessoes} Sessões${pkg.sessionType ? ' - ' + pkg.sessionType : ''}`,
      Categoria: pkg.doctorDoc?.specialty || 'Não categorizado',
      'Valor Total': valorTotal,
      'Total Sessões': totalSessoes,
      Realizadas: sessoesRealizadas,
      Restantes: totalSessoes - sessoesRealizadas,
      '% Concluído': percentual,
      'Valor Provisionado': valorProvisionado,
      'A Provisionar': valorTotal - valorProvisionado
    };
  });
};

/**
 * Busca histórico de pacotes concluídos
 */
export const getPacotesConcluidos = async () => {
  const Package = (await import('../models/Package.js')).default;
  const Session = (await import('../models/Session.js')).default;

  const packages = await Package.find({
    $or: [
      { status: 'completed' },
      { sessionsDone: { $gte: 1 }, $expr: { $gte: ['$sessionsDone', '$totalSessions'] } }
    ]
  })
    .populate('patient', 'fullName')
    .populate('doctor', 'fullName specialty')
    .sort({ updatedAt: -1 })
    .limit(100)
    .lean();

  const resultado = [];
  let index = 1;

  for (const pkg of packages) {
    const sessoesRealizadas = pkg.sessionsDone || 0;
    const totalSessoes = pkg.totalSessions || 1;
    const valorTotal = pkg.totalValue || 0;

    resultado.push({
      ID: index++,
      'Data Venda': pkg.createdAt ? moment(pkg.createdAt).format('YYYY-MM-DD') : moment().format('YYYY-MM-DD'),
      'Data Conclusão': pkg.updatedAt ? moment(pkg.updatedAt).format('YYYY-MM-DD') : '-',
      Cliente: pkg.patient?.fullName || 'N/A',
      Pacote: `Pacote ${totalSessoes} Sessões${pkg.sessionType ? ' - ' + pkg.sessionType : ''}`,
      Categoria: pkg.doctor?.specialty || 'N/A',
      'Valor Total': valorTotal,
      'Total Sessões': totalSessoes,
      Realizadas: sessoesRealizadas,
      StatusFinanceiro: pkg.financialStatus
    });
  }

  return resultado;
};

/**
 * Gera relatório analítico completo (base de dados, faturamento por mês/categoria)
 */
export const gerarRelatorioAnalitico = async (mes, ano) => {
  const mesCompetencia = `${ano}-${String(mes).padStart(2, '0')}`;
  const startDate = `${ano}-${String(mes).padStart(2, '0')}-01`;

  const endDate = moment(`${ano}-${String(mes).padStart(2, '0')}-01`).endOf('month').format('YYYY-MM-DD');

  const Payment = (await import('../models/Payment.js')).default;
  const Appointment = (await import('../models/Appointment.js')).default;

  // Buscar pagamentos do período
  const payments = await Payment.find({
    status: 'paid',
    paymentDate: { $gte: startDate, $lte: endDate }
  })
    .populate('patient', 'fullName')
    .populate('doctor', 'fullName specialty')
    .populate('session')
    .lean();

  // Buscar appointments realizados
  const appointments = await Appointment.find({
    date: { $gte: startDate, $lte: endDate },
    clinicalStatus: 'completed'
  })
    .populate('patient', 'fullName')
    .populate('doctor', 'fullName specialty')
    .lean();

  // Montar base de dados analítica
  const baseDados = [];
  let idCounter = 1;

  // Processar pagamentos
  payments.forEach(payment => {
    const valor = payment.amount || 0;
    const impostos = valor * 0.06; // 6% Simples
    const comissao = valor * 0.10; // 10%
    const taxaCartao = payment.paymentMethod?.includes('card') ? valor * 0.04 : 0;
    const totalCV = impostos + comissao + taxaCartao;

    baseDados.push({
      ID_Venda: `PAY${String(idCounter++).padStart(3, '0')}`,
      Data_Venda: payment.paymentDate || payment.createdAt,
      Cliente: payment.patient?.fullName || 'N/A',
      Tipo_Produto: payment.kind === 'package_receipt' ? 'Pacote' : 'Avulso',
      Categoria: payment.doctor?.specialty || 'Não categorizado',
      Valor_Bruto: valor,
      Desconto: 0,
      Valor_Liquido: valor,
      CMV: 0,
      Impostos: parseFloat(impostos.toFixed(2)),
      Comissao: parseFloat(comissao.toFixed(2)),
      Taxa_Cartao: parseFloat(taxaCartao.toFixed(2)),
      Total_CV: parseFloat(totalCV.toFixed(2)),
      Margem_Contrib: parseFloat((valor - totalCV).toFixed(2)),
      Status: 'realizado',
      Forma_Pagamento: payment.paymentMethod || 'N/A',
      Profissional: payment.doctor?.fullName || 'N/A'
    });
  });

  // Consolidar por mês
  const faturamentoMes = [];
  for (let i = 1; i <= 12; i++) {
    const mesLoop = String(i).padStart(2, '0');
    const vendasMes = baseDados.filter(d => {
      const data = moment(d.Data_Venda);
      return data.month() + 1 === i && data.year() === parseInt(ano);
    });

    const faturamento = vendasMes.reduce((s, d) => s + d.Valor_Liquido, 0);
    const custos = vendasMes.reduce((s, d) => s + d.Total_CV, 0);

    faturamentoMes.push({
      Mes: moment().month(i - 1).format('MMMM'),
      'Qtd Vendas': vendasMes.length,
      'Faturamento Bruto': faturamento,
      'Faturamento Líquido': faturamento,
      'Total CV': custos,
      'Margem Contrib.': faturamento - custos,
      '% Margem': faturamento > 0 ? (((faturamento - custos) / faturamento) * 100).toFixed(2) : 0
    });
  }

  // Total do ano
  const totalFaturamento = baseDados.reduce((s, d) => s + d.Valor_Liquido, 0);
  const totalCustos = baseDados.reduce((s, d) => s + d.Total_CV, 0);

  faturamentoMes.push({
    Mes: 'TOTAL ANO',
    'Qtd Vendas': baseDados.length,
    'Faturamento Bruto': totalFaturamento,
    'Faturamento Líquido': totalFaturamento,
    'Total CV': totalCustos,
    'Margem Contrib.': totalFaturamento - totalCustos,
    '% Margem': totalFaturamento > 0 ? (((totalFaturamento - totalCustos) / totalFaturamento) * 100).toFixed(2) : 0
  });

  // Dashboard
  const dashboard = {
    'FATURAMENTO TOTAL': totalFaturamento,
    'MARGEM DE CONTRIBUIÇÃO': totalFaturamento - totalCustos,
    '% MARGEM': totalFaturamento > 0 ? ((totalFaturamento - totalCustos) / totalFaturamento * 100).toFixed(2) : 0,
    'TICKET MÉDIO': baseDados.length > 0 ? (totalFaturamento / baseDados.length).toFixed(2) : 0,
    'TOTAL DE VENDAS': baseDados.length
  };

  // Por categoria
  const categorias = {};
  baseDados.forEach(item => {
    if (!categorias[item.Categoria]) {
      categorias[item.Categoria] = {
        Categoria: item.Categoria,
        'Faturamento Líquido': 0,
        'Margem Contrib.': 0,
        'Qtd Vendas': 0
      };
    }
    categorias[item.Categoria]['Faturamento Líquido'] += item.Valor_Liquido;
    categorias[item.Categoria]['Margem Contrib.'] += item.Margem_Contrib;
    categorias[item.Categoria]['Qtd Vendas']++;
  });

  return {
    dashboard,
    baseDados,
    faturamentoMes,
    faturamentoCategoria: Object.values(categorias),
    pacotesAndamento: await getPacotesEmAndamento(),
    porPaciente: consolidarPorPaciente(baseDados)
  };
};

/**
 * Agrupa base analítica por paciente
 */
const consolidarPorPaciente = (baseDados) => {
  const pacientes = {};
  baseDados.forEach(item => {
    if (!pacientes[item.Cliente]) {
      pacientes[item.Cliente] = {
        paciente: item.Cliente,
        totalGasto: 0,
        qtdVendas: 0,
        categorias: new Set(),
        ultimaVenda: item.Data_Venda
      };
    }
    pacientes[item.Cliente].totalGasto += item.Valor_Liquido;
    pacientes[item.Cliente].qtdVendas++;
    pacientes[item.Cliente].categorias.add(item.Categoria);
    if (new Date(item.Data_Venda) > new Date(pacientes[item.Cliente].ultimaVenda)) {
      pacientes[item.Cliente].ultimaVenda = item.Data_Venda;
    }
  });

  return Object.values(pacientes).map(p => ({
    ...p,
    categorias: Array.from(p.categorias).join(', ')
  })).sort((a, b) => b.totalGasto - a.totalGasto);
};

/**
 * Exporta dados para Excel
 */
export const exportarExcel = async (mes, ano) => {
  const dados = await gerarRelatorioAnalitico(mes, ano);

  return {
    filename: `provisionamento_${ano}_${String(mes).padStart(2, '0')}.xlsx`,
    abas: [
      { nome: 'Base de Dados', dados: dados.baseDados },
      { nome: 'Faturamento por Mês', dados: dados.faturamentoMes },
      { nome: 'Faturamento por Categoria', dados: dados.faturamentoCategoria },
      { nome: 'Pacotes em Andamento', dados: dados.pacotesAndamento },
      { nome: 'Dashboard', dados: [dados.dashboard] }
    ]
  };
};

/**
 * Simula uma venda (para o front calcular antes de confirmar)
 */
export const simularVenda = async ({ valor, formaPagamento, bandeiraCartao, parcelas, produtoId }) => {
  const ProdutoServico = (await import('../models/ProdutoServico.js')).default;
  const TaxaCartao = (await import('../models/TaxaCartao.js')).default;

  const produto = await ProdutoServico.findById(produtoId);
  if (!produto) throw new Error('Produto não encontrado');

  // Calcular taxa
  let taxaCartao = 0;
  if (['debito', 'credito_1x', 'credito_parcelado'].includes(formaPagamento)) {
    const config = await TaxaCartao.findOne({ bandeira: bandeiraCartao, ativo: true });
    if (config) {
      const tipo = formaPagamento === 'debito' ? 'debito' : 'credito';
      const numParcelas = formaPagamento === 'credito_parcelado' ? parcelas : 1;
      const pct = config.getTaxa ? config.getTaxa(tipo, numParcelas) : (tipo === 'debito' ? 0.90 : 1.85);
      taxaCartao = parseFloat((valor * (pct / 100)).toFixed(2));
    }
  }

  const cmv = produto.custoMercadoria || 0;
  const comissao = parseFloat((valor * ((produto.comissaoPercentual || 10) / 100)).toFixed(2));
  const imposto = parseFloat((valor * 0.06).toFixed(2));

  const totalCustos = cmv + comissao + taxaCartao + imposto;
  const margem = valor - totalCustos;

  return {
    valor,
    custos: {
      cmv,
      imposto,
      comissao,
      taxaCartao,
      total: totalCustos
    },
    margemContribuicao: margem,
    percentualMargem: ((margem / valor) * 100).toFixed(2)
  };
};

export const criarVenda = async (dadosVenda) => {
  // Implementação básica - criar Sale e calcular custos
  const Sale = (await import('../models/Sale.js')).default;
  const Package = (await import('../models/Package.js')).default;

  const venda = new Sale({
    ...dadosVenda,
    mesCompetencia: moment(dadosVenda.dataVenda).format('YYYY-MM')
  });

  if (dadosVenda.tipoVenda === 'pacote' && dadosVenda.packageId) {
    const pkg = await Package.findById(dadosVenda.packageId);
    if (pkg) {
      venda.pacoteInfo = {
        totalSessoes: pkg.totalSessions,
        sessoesRealizadas: 0,
        valorPorSessao: dadosVenda.valorLiquido / pkg.totalSessions,
        saldoAProvisionar: dadosVenda.valorLiquido
      };
    }
  }

  await venda.save();
  return venda;
};

export const realizarSessao = async (sessionId, dataRealizacao) => {
  const Session = (await import('../models/Session.js')).default;
  const session = await Session.findById(sessionId);

  if (!session) throw new Error('Sessão não encontrada');

  session.status = 'completed';
  session.dataRealizacao = dataRealizacao;
  await session.save();

  return { session, provisionado: true };
};


// ==================== EXPORT DEFAULT ====================

export default {
  calcularProvisionamento,
  confirmarAgendamentosMassa,
  liberarVagasMassa,
  getPacotesEmAndamento,
  getPacotesConcluidos,
  gerarRelatorioAnalitico,
  exportarExcel,
  simularVenda,
  criarVenda,
  realizarSessao
};