import express from 'express';
import moment from 'moment-timezone';
import { auth, authorize } from '../middleware/auth.js';
import Appointment from '../models/Appointment.js';
import TaxaCartao from '../models/TaxaCartao.js';
import {
  calcularProvisionamento,
  confirmarAgendamentosMassa,
  exportarExcel,
  gerarRelatorioAnalitico,
  getPacotesEmAndamento,
  getPacotesConcluidos,
  liberarVagasMassa,
  simularVenda
} from '../services/provisionamentoService.js';
import Payment from '../models/Payment.js';

const router = express.Router();

// Todas as rotas protegidas
router.use(auth);
const TIMEZONE = 'America/Sao_Paulo';
/**
 * GET /api/provisionamento?mes=03&ano=2024
 * Calcula provisionamento completo do mês (ANTIGO - mantido)
 */
router.get('/', authorize(['admin', 'secretary']), async (req, res) => {
  try {
    const { mes, ano } = req.query;

    const mesAtual = mes ? parseInt(mes) : new Date().getMonth() + 1;
    const anoAtual = ano ? parseInt(ano) : new Date().getFullYear();

    const resultado = await calcularProvisionamento(mesAtual, anoAtual);

    res.json({
      success: true,
      data: resultado
    });
  } catch (error) {
    console.error('Erro ao calcular provisionamento:', error);
    res.status(500).json({
      success: false,
      message: 'Erro ao calcular provisionamento',
      error: error.message
    });
  }
});

/**
 * GET /api/provisionamento/atividade-hoje
 * Dashboard em tempo real: agendamentos do dia, pacotes criados, vendas
 */
router.get('/atividade-hoje', authorize(['admin', 'secretary']), async (req, res) => {
  try {
    const hoje = moment().tz(TIMEZONE).format('YYYY-MM-DD');
    const inicioDia = moment().tz(TIMEZONE).startOf('day').toDate();
    const fimDia = moment().tz(TIMEZONE).endOf('day').toDate();

    console.log('Buscando atividade do dia:', hoje);

    // 1. Agendamentos de hoje (clínicaStatus pending = ainda não atendidos)
    const agendamentosHoje = await Appointment.find({
      date: hoje,
      clinicalStatus: { $in: ['pending', 'scheduled'] },
      operationalStatus: { $in: ['confirmed', 'scheduled'] }
    })
      .populate('patient', 'fullName phoneNumber')
      .populate('doctor', 'fullName specialty')
      .sort({ time: 1 })
      .lean();

    // 2. Pacotes criados hoje
    const Package = (await import('../models/Package.js')).default;
    const pacotesCriadosHoje = await Package.find({
      createdAt: { $gte: inicioDia, $lte: fimDia }
    })
      .populate('patient', 'fullName')
      .populate('doctor', 'fullName specialty')
      .lean();

    // 3. Agendamentos criados hoje (novos na plataforma)
    const agendamentosCriadosHoje = await Appointment.find({
      createdAt: { $gte: inicioDia, $lte: fimDia },
      date: { $gte: hoje }
    })
      .populate('patient', 'fullName')
      .lean();

    // 4. Calcular valores
    const valorAgendamentosHoje = agendamentosHoje.reduce((sum, apt) => sum + (apt.sessionValue || 0), 0);
    const valorPacotesHoje = pacotesCriadosHoje.reduce((sum, pkg) => sum + (pkg.totalValue || 0), 0);

    // Enriquecer dados para o front
    const agora = moment().tz(TIMEZONE);
    const agendaEnriquecida = agendamentosHoje.map(apt => {
      const horaApt = moment.tz(`${apt.date}T${apt.time || '00:00'}:00`, TIMEZONE);
      const horasRestantes = horaApt.diff(agora, 'hours');
      const minutosRestantes = horaApt.diff(agora, 'minutes');

      return {
        ...apt,
        statusTempo: minutosRestantes < 0 ? 'atrasado' :
          minutosRestantes < 60 ? 'proximo' :
            horasRestantes < 24 ? 'hoje' : 'futuro',
        minutosAteAtendimento: minutosRestantes
      };
    });

    res.json({
      success: true,
      data: {
        data: hoje,
        resumo: {
          totalAgendamentosHoje: agendamentosHoje.length,
          totalPacotesCriados: pacotesCriadosHoje.length,
          totalNovosAgendamentos: agendamentosCriadosHoje.length,
          valorTotalAgendado: valorAgendamentosHoje,
          valorTotalPacotes: valorPacotesHoje,
          faturamentoPotencialDia: valorAgendamentosHoje + valorPacotesHoje
        },
        agendaHoje: agendaEnriquecida,
        pacotesCriados: pacotesCriadosHoje.map(pkg => ({
          _id: pkg._id,
          paciente: pkg.patient?.fullName,
          especialidade: pkg.doctor?.specialty,
          sessoes: pkg.totalSessions,
          valor: pkg.totalValue,
          statusPagamento: pkg.financialStatus,
          horaCriacao: moment(pkg.createdAt).format('HH:mm')
        })),
        novosAgendamentos: agendamentosCriadosHoje.map(apt => ({
          _id: apt._id,
          paciente: apt.patient?.fullName,
          data: apt.date,
          hora: apt.time,
          horaCriacao: moment(apt.createdAt).format('HH:mm:ss')
        }))
      }
    });
  } catch (error) {
    console.error('Erro ao buscar atividade do dia:', error);
    res.status(500).json({
      success: false,
      message: 'Erro ao buscar atividade do dia',
      error: error.message
    });
  }
});

/**
 * GET /api/provisionamento/agenda-temporaria (CORRIGIDO)
 * Agora mostra agendamentos pendentes de confirmação ou do dia
 */
router.get('/agenda-temporaria', authorize(['admin', 'secretary']), async (req, res) => {
  try {
    const { month, year } = req.query;

    let inicio, fim;

    if (month && year) {
      // Busca pelo mês selecionado
      inicio = `${year}-${String(month).padStart(2, '0')}-01`;
      fim = moment(`${year}-${String(month).padStart(2, '0')}-01`).endOf('month').format('YYYY-MM-DD');
    } else {
      // Padrão: próxima semana
      inicio = moment().tz(TIMEZONE).format('YYYY-MM-DD');
      fim = moment().tz(TIMEZONE).add(7, 'days').format('YYYY-MM-DD');
    }

    console.log('Buscando agenda entre:', inicio, 'e', fim);

    // Buscar agendamentos confirmados do período
    const agendamentos = await Appointment.find({
      date: { $gte: inicio, $lte: fim },
      operationalStatus: { $in: ['confirmed', 'scheduled'] },
      clinicalStatus: 'pending'
    })
      .populate('patient', 'fullName phoneNumber')
      .populate('doctor', 'fullName specialty')
      .sort({ date: 1, time: 1 })
      .lean();

    console.log(`Encontrados ${agendamentos.length} agendamentos`);

    const agora = moment().tz(TIMEZONE);
    const hoje = moment().tz(TIMEZONE).format('YYYY-MM-DD');

    // Enriquecer dados
    const dadosEnriquecidos = agendamentos.map(apt => {
      const dataHora = moment.tz(`${apt.date}T${apt.time || '00:00'}:00`, TIMEZONE);
      const horasRestantes = dataHora.diff(agora, 'hours');
      const ehHoje = apt.date === hoje;
      const diasRestantes = moment(apt.date).diff(moment(), 'days');

      return {
        ...apt,
        risco: ehHoje && horasRestantes <= 2 ? 'urgente' :
          ehHoje && horasRestantes <= 4 ? 'medio' :
            !ehHoje && horasRestantes <= 24 ? 'urgente' :
              !ehHoje && horasRestantes <= 72 ? 'medio' : 'baixo',
        ehHoje: ehHoje,
        horasRestantes: Math.max(0, horasRestantes),
        diasRestantes: diasRestantes,
        acaoSugerida: ehHoje ? 'atender_hoje' :
          horasRestantes <= 24 ? 'confirmar_urgente' :
            horasRestantes <= 72 ? 'enviar_lembrete' : 'aguardar'
      };
    });

    res.json({
      success: true,
      total: agendamentos.length,
      hoje: dadosEnriquecidos.filter(a => a.ehHoje).length,
      urgentes: dadosEnriquecidos.filter(a => a.risco === 'urgente').length,
      periodo: { inicio, fim },
      data: dadosEnriquecidos
    });
  } catch (error) {
    console.error('Erro ao buscar agenda temporária:', error);
    res.status(500).json({
      success: false,
      message: 'Erro ao buscar agenda temporária',
      error: error.message
    });
  }
});

/**
 * POST /api/provisionamento/confirmar-massa (ANTIGO - mantido)
 */
router.post('/confirmar-massa', authorize(['admin', 'secretary']), async (req, res) => {
  try {
    const { ids } = req.body;

    if (!ids || !Array.isArray(ids) || ids.length === 0) {
      return res.status(400).json({
        success: false,
        message: 'IDs dos agendamentos são obrigatórios'
      });
    }

    const resultado = await confirmarAgendamentosMassa(ids);

    res.json({
      success: true,
      message: `${resultado.quantidade} agendamentos confirmados com sucesso`,
      data: resultado
    });
  } catch (error) {
    console.error('Erro ao confirmar agendamentos:', error);
    res.status(500).json({
      success: false,
      message: 'Erro ao confirmar agendamentos',
      error: error.message
    });
  }
});

/**
 * POST /api/provisionamento/liberar-vagas (ANTIGO - mantido)
 */
router.post('/liberar-vagas', authorize(['admin', 'secretary']), async (req, res) => {
  try {
    const { ids, motivo } = req.body;

    if (!ids || !Array.isArray(ids) || ids.length === 0) {
      return res.status(400).json({
        success: false,
        message: 'IDs dos agendamentos são obrigatórios'
      });
    }

    const resultado = await liberarVagasMassa(ids, motivo || 'Não confirmou');

    res.json({
      success: true,
      message: `${resultado.quantidade} vagas liberadas com sucesso`,
      data: resultado
    });
  } catch (error) {
    console.error('Erro ao liberar vagas:', error);
    res.status(500).json({
      success: false,
      message: 'Erro ao liberar vagas',
      error: error.message
    });
  }
});

/**
 * GET /api/provisionamento/dashboard?month=03&year=2024
 * Dashboard com indicadores principais
 */
router.get('/dashboard', authorize(['admin', 'secretary']), async (req, res) => {
  try {
    const { month, year } = req.query;

    if (!month || !year) {
      return res.status(400).json({
        success: false,
        message: 'Parâmetros obrigatórios: month e year'
      });
    }

    const dados = await gerarRelatorioAnalitico(parseInt(month), parseInt(year));

    const cards = {
      faturamentoTotal: dados.dashboard['FATURAMENTO TOTAL'] || 0,
      margemContribuicao: dados.dashboard['MARGEM DE CONTRIBUIÇÃO'] || 0,
      percentualMargem: parseFloat(dados.dashboard['% MARGEM'] || 0),
      ticketMedio: parseFloat(dados.dashboard['TICKET MÉDIO'] || 0),
      totalVendas: dados.dashboard['TOTAL DE VENDAS'] || 0,
      pacotesAtivos: dados.pacotesAndamento.length,
      custosVariaveis: dados.faturamentoMes.find(m => m.Mes === moment().month(parseInt(month) - 1).format('MMMM'))?.['Total CV'] || 0
    };

    const evolucaoMensal = dados.faturamentoMes
      .filter(m => m.Mes !== 'TOTAL ANO')
      .map(m => ({
        mes: m.Mes,
        faturamento: m['Faturamento Líquido'],
        margem: m['Margem Contrib.'],
        custos: m['Total CV']
      }));

    const porCategoria = dados.faturamentoCategoria.map(c => ({
      categoria: c.Categoria,
      valor: c['Faturamento Líquido'],
      margem: c['Margem Contrib.']
    }));

    res.json({
      success: true,
      periodo: { mes: parseInt(month), ano: parseInt(year), label: `${moment().month(parseInt(month) - 1).format('MMMM')}/${year}` },
      cards,
      evolucaoMensal,
      porCategoria,
      alertas: dados.pacotesAndamento.length > 0 ? `${dados.pacotesAndamento.length} pacotes em andamento` : null
    });
  } catch (error) {
    console.error('Erro dashboard:', error);
    res.status(500).json({ success: false, message: error.message });
  }
});

/**
 * GET /api/provisionamento/analitico?month=03&year=2024
 * Lista detalhada para planilha
 */
router.get('/analitico', authorize(['admin', 'secretary']), async (req, res) => {
  try {
    const { month, year, page = 1, limit = 50 } = req.query;

    if (!month || !year) {
      return res.status(400).json({
        success: false,
        message: 'Parâmetros obrigatórios: month e year'
      });
    }

    const dados = await gerarRelatorioAnalitico(parseInt(month), parseInt(year));

    let detalhamento = dados.baseDados;
    const start = (page - 1) * limit;
    const end = start + parseInt(limit);
    const paginated = detalhamento.slice(start, end);

    res.json({
      success: true,
      total: detalhamento.length,
      page: parseInt(page),
      pages: Math.ceil(detalhamento.length / limit),
      data: paginated,
      totais: {
        bruto: detalhamento.reduce((s, d) => s + (d.Valor_Bruto || 0), 0),
        liquido: detalhamento.reduce((s, d) => s + (d.Valor_Liquido || 0), 0),
        custos: detalhamento.reduce((s, d) => s + (d.Total_CV || 0), 0),
        margem: detalhamento.reduce((s, d) => s + (d.Margem_Contrib || 0), 0)
      }
    });
  } catch (error) {
    console.error('Erro no analítico:', error);
    res.status(500).json({ success: false, message: error.message });
  }
});

router.get('/pacotes-andamento', authorize(['admin', 'secretary']), async (req, res) => {
  try {
    const dados = await getPacotesEmAndamento();

    res.json({
      success: true,
      count: dados.length,
      data: dados
    });
  } catch (error) {
    console.error('Erro ao buscar pacotes:', error);
    res.status(500).json({
      success: false,
      message: 'Erro ao buscar faturamento por pacote',
      error: error.message
    });
  }
});

/**
 * GET /api/provisionamento/pacotes-concluidos
 * Lista de pacotes finalizados/concluidos
 */
router.get('/pacotes-concluidos', authorize(['admin', 'secretary']), async (req, res) => {
  try {
    const dados = await getPacotesConcluidos();
    res.json({
      success: true,
      count: dados.length,
      data: dados
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

/**
 * GET /api/provisionamento/fechamento-mensal?month=03&year=2024
 * DRE - Demonstração do Resultado
 */
router.get('/fechamento-mensal', authorize(['admin']), async (req, res) => {
  try {
    const { month, year } = req.query;

    if (!month || !year) {
      return res.status(400).json({
        success: false,
        message: 'Parâmetros obrigatórios: month e year'
      });
    }

    const dados = await gerarRelatorioAnalitico(parseInt(month), parseInt(year));

    const mesAtual = dados.faturamentoMes.find(m =>
      m.Mes === moment().month(parseInt(month) - 1).format('MMMM')
    );

    const dre = {
      receitaBruta: mesAtual?.['Faturamento Bruto'] || 0,
      descontos: mesAtual?.['Descontos'] || 0,
      receitaLiquida: mesAtual?.['Faturamento Líquido'] || 0,
      cmv: mesAtual?.['CMV'] || dados.baseDados.reduce((s, d) => s + (d.CMV || 0), 0),
      impostos: mesAtual?.['Impostos'] || dados.baseDados.reduce((s, d) => s + (d.Impostos || 0), 0),
      comissoes: mesAtual?.['Comissões'] || dados.baseDados.reduce((s, d) => s + (d.Comissao || 0), 0),
      taxasCartao: mesAtual?.['Taxas Cartão'] || dados.baseDados.reduce((s, d) => s + (d.Taxa_Cartao || 0), 0),
      outrosCV: mesAtual?.['Outros CV'] || dados.baseDados.reduce((s, d) => s + (d.Embalagem || 0), 0),
      totalCV: mesAtual?.['Total CV'] || 0,
      margemContribuicao: mesAtual?.['Margem Contrib.'] || 0,
      percentualMargem: mesAtual?.['% Margem'] || 0
    };

    res.json({
      success: true,
      periodo: `${month}/${year}`,
      dre
    });
  } catch (error) {
    console.error('Erro no fechamento:', error);
    res.status(500).json({ success: false, message: error.message });
  }
});

/**
 * GET /api/provisionamento/export/excel?month=03&year=2024
 * Exporta planilha
 */
router.get('/export/excel', authorize(['admin']), async (req, res) => {
  try {
    const { month, year } = req.query;

    if (!month || !year) {
      return res.status(400).json({
        success: false,
        message: 'Parâmetros obrigatórios: month e year'
      });
    }

    const exportData = await exportarExcel(parseInt(month), parseInt(year));

    res.json({
      success: true,
      filename: exportData.filename,
      abas: exportData.abas
    });
  } catch (error) {
    console.error('Erro na exportação:', error);
    res.status(500).json({ success: false, message: error.message });
  }
});

/**
 * GET /api/provisionamento/taxas-cartao
 * Lista taxas de cartão configuradas
 */
router.get('/taxas-cartao', async (req, res) => {
  try {
    const taxas = await TaxaCartao.find({ ativo: true }).sort('nomeExibicao');
    res.json({ success: true, data: taxas });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

/**
 * POST /api/provisionamento/simular
 * Simula uma venda antes de confirmar (calcula custos)
 * @access  Admin, Secretary
 */
router.post('/simular', authorize(['admin', 'secretary']), async (req, res) => {
  try {
    const { valor, formaPagamento, bandeiraCartao, parcelas, produtoId } = req.body;

    const resultado = await simularVenda({
      valor,
      formaPagamento,
      bandeiraCartao,
      parcelas,
      produtoId
    });

    res.json({
      success: true,
      simulacao: resultado
    });
  } catch (error) {
    console.error('Erro na simulação:', error);
    res.status(500).json({ success: false, message: error.message });
  }
});

router.get('/projecao-mes', authorize(['admin', 'secretary']), async (req, res) => {
  try {
    const { month, year } = req.query;
    const mes = parseInt(month);
    const ano = parseInt(year);

    const inicioMes = `${ano}-${String(mes).padStart(2, '0')}-01`;
    const fimMes = moment(`${ano}-${String(mes).padStart(2, '0')}-01`).endOf('month').format('YYYY-MM-DD');
    const hoje = moment().tz(TIMEZONE).format('YYYY-MM-DD');

    // Verificar se o mês é passado, atual ou futuro
    const ehMesPassado = fimMes < hoje;
    const ehMesAtual = (inicioMes <= hoje && fimMes >= hoje);
    const ehMesFuturo = inicioMes > hoje;

    console.log(`Mês: ${mes}/${ano} | Início: ${inicioMes} | Fim: ${fimMes} | Hoje: ${hoje}`);
    console.log(`Status: ${ehMesPassado ? 'PASSADO' : ehMesAtual ? 'ATUAL' : 'FUTURO'}`);

    // 1. PRODUÇÃO = Sessões REALIZADAS no período (Session model — correto)
    const Payment = (await import('../models/Payment.js')).default;
    const Session = (await import('../models/Session.js')).default;

    const sessoesDoMes = await Session.find({
      status: 'completed',
      date: { $gte: inicioMes, $lte: fimMes }
    }).populate('package', 'insuranceGrossAmount').lean();

    // Valor de cada sessão: sessionValue → pkg.insuranceGrossAmount
    const valorSessao = (s) => {
      if (s.sessionValue > 0) return s.sessionValue;
      if (s.package?.insuranceGrossAmount > 0) return s.package.insuranceGrossAmount;
      return 0;
    };

    const sessoesParticular = sessoesDoMes.filter(s => s.paymentMethod !== 'convenio');
    const sessoesConvenio = sessoesDoMes.filter(s => s.paymentMethod === 'convenio');

    const valorParticular = sessoesParticular.reduce((sum, s) => sum + valorSessao(s), 0);
    const valorConvenio = sessoesConvenio.reduce((sum, s) => sum + valorSessao(s), 0);
    const valorRealizados = valorParticular + valorConvenio;
    const quantidadeRealizados = sessoesDoMes.length;

    // 2. CAIXA REAL = pagamentos efetivamente recebidos (Payment model)
    const pagamentosRecebidos = await Payment.find({
      paymentDate: { $gte: inicioMes, $lte: fimMes },
      status: 'paid'
    });
    
    // 3. CRÉDITO DE PACOTES (sessões pagas não utilizadas - excluindo canceladas)
    const Package = (await import('../models/Package.js')).default;
    const pacotesCredito = await Package.find({
      type: { $ne: 'convenio' },
      financialStatus: { $in: ['paid', 'partially_paid'] },
      status: { $in: ['active', 'in-progress'] }
    }).populate('patient', 'fullName');
    
    let valorCreditoPacotes = 0;
    const detalhesCreditoPacotes = [];
    
    for (const pkg of pacotesCredito) {
      // Buscar sessões não canceladas do pacote
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
        valorCreditoPacotes += valor;
        detalhesCreditoPacotes.push({
          pacoteId: pkg._id,
          paciente: pkg.patient?.fullName || 'N/A',
          sessoesRemanescentes,
          valorPorSessao: pkg.sessionValue,
          valorTotal: valor
        });
      }
    }
    
    // 4. CONVÊNIO AGENDADO (sessões de pacotes de convênio agendadas no mês)
    const sessoesConvenioAgendadas = await Session.find({
      date: { $gte: inicioMes, $lte: fimMes },
      status: { $in: ['scheduled', 'confirmed'] },
      paymentMethod: 'convenio'
    }).populate('package', 'insuranceGrossAmount insuranceProvider').populate('patient', 'fullName');
    
    let valorConvenioAgendado = 0;
    const detalhesConvenioAgendado = sessoesConvenioAgendadas.map(s => {
      const valor = s.sessionValue || s.package?.insuranceGrossAmount || 0;
      valorConvenioAgendado += valor;
      return {
        sessaoId: s._id,
        data: s.date,
        hora: s.time,
        paciente: s.patient?.fullName || 'Paciente',
        convenio: s.package?.insuranceProvider || 'N/A',
        valor
      };
    });
    const valorJaRecebido = pagamentosRecebidos.reduce((sum, p) => sum + (p.amount || 0), 0);

    // Detalhes dos atendimentos realizados (para a tabela)
    const detalhesRealizados = sessoesDoMes.map(s => ({
      _id: s._id,
      data: s.date,
      hora: s.time || '--:--',
      valor: valorSessao(s),
      paciente: s.patientName || 'Paciente',
      tipo: s.paymentMethod === 'convenio'
        ? (s.package ? 'Convênio Pacote' : 'Convênio Avulso')
        : 'Particular'
    }));

    let valorAgendados = 0;
    let valorPendentes = 0;
    let agendados = [];
    let pendentes = [];

    if (ehMesPassado) {
      // MÊS PASSADO: Buscar o que foi agendado e realizado na época (histórico)
      // Não tem projeção, só o que realmente aconteceu
      agendados = await Appointment.find({
        date: { $gte: inicioMes, $lte: fimMes },
        operationalStatus: { $in: ['confirmed', 'scheduled'] },
        clinicalStatus: 'completed', // No passado, só conta o que foi atendido
        package: { $exists: false }  // Exclui appointments de pacote
      }).populate('patient', 'fullName').select('sessionValue date time');

      valorAgendados = agendados.reduce((sum, apt) => sum + (apt.sessionValue || 0), 0);

      // Pendentes do passado = agendamentos que não viraram atendimento
      pendentes = await Appointment.find({
        date: { $gte: inicioMes, $lte: fimMes },
        clinicalStatus: { $in: ['pending', 'cancelled', 'no_show'] }
      }).populate('patient', 'fullName').select('sessionValue date time');

      valorPendentes = pendentes.reduce((sum, apt) => sum + (apt.sessionValue || 0), 0);

    } else if (ehMesAtual) {
      // MÊS ATUAL: Projeção normal (restante do mês)
      // Inclui package_paid: sessão de pacote já pago ainda vai acontecer (produção real)
      agendados = await Appointment.find({
        date: { $gt: hoje, $lte: fimMes },
        operationalStatus: { $in: ['confirmed', 'scheduled'] },
        clinicalStatus: { $nin: ['completed', 'cancelled'] },
        package: { $exists: false }  // Exclui appointments de pacote (já contado nos pacotes)
      }).populate('patient', 'fullName').select('sessionValue date time');

      valorAgendados = agendados.reduce((sum, apt) => sum + (apt.sessionValue || 0), 0);

      pendentes = await Appointment.find({
        date: { $gt: hoje, $lte: fimMes },
        $or: [{ operationalStatus: 'pending' }, { operationalStatus: { $exists: false } }],
        clinicalStatus: { $ne: 'completed' },
        package: { $exists: false }  // Exclui appointments de pacote
      }).populate('patient', 'fullName').select('sessionValue date time');

      valorPendentes = pendentes.reduce((sum, apt) => sum + (apt.sessionValue || 0), 0);

    } else {
      // MÊS FUTURO: Tudo é projeção
      agendados = await Appointment.find({
        date: { $gte: inicioMes, $lte: fimMes },
        operationalStatus: { $in: ['confirmed', 'scheduled'] },
        package: { $exists: false }  // Exclui appointments de pacote
      }).populate('patient', 'fullName').select('sessionValue date time');

      valorAgendados = agendados.reduce((sum, apt) => sum + (apt.sessionValue || 0), 0);

      pendentes = await Appointment.find({
        date: { $gte: inicioMes, $lte: fimMes },
        $or: [{ operationalStatus: 'pending' }, { operationalStatus: { $exists: false } }]
      }).populate('patient', 'fullName').select('sessionValue date time');

      valorPendentes = pendentes.reduce((sum, apt) => sum + (apt.sessionValue || 0), 0);
    }

    // Calcular taxa de conversão histórica (últimos 90 dias)
    const dataCorte = moment().subtract(90, 'days').format('YYYY-MM-DD');
    const totalHistorico = await Appointment.countDocuments({
      date: { $gte: dataCorte, $lte: hoje },
      operationalStatus: { $in: ['confirmed', 'scheduled'] }
    });
    const convertidosHistorico = await Appointment.countDocuments({
      date: { $gte: dataCorte, $lte: hoje },
      clinicalStatus: 'completed'
    });
    const taxaConversao = totalHistorico > 0 ? convertidosHistorico / totalHistorico : 0.85;

    // Cenários
    let valorPessimista, valorRealista, valorOtimista;

    if (ehMesPassado) {
      // Mês passado: resultado final é o que foi realizado
      valorPessimista = valorRealizados;
      valorRealista = valorRealizados;
      valorOtimista = valorRealizados + valorPendentes; // O que poderia ter sido
    } else {
      // Atual ou futuro: projeção (mínimo = já realizado)
      valorPessimista = Math.max(valorRealizados, valorRealizados + (valorAgendados * 0.7) + (valorPendentes * 0.2));
      valorRealista = Math.max(valorRealizados, valorRealizados + (valorAgendados * 0.85) + (valorPendentes * (taxaConversao * 0.6)));
      valorOtimista = Math.max(valorRealizados, valorRealizados + (valorAgendados * 0.95) + (valorPendentes * 0.7));
    }

    // Meta real do Planning — se não houver, nenhuma meta é exibida
    const Planning = (await import('../models/Planning.js')).default;
    const planningDoMes = await Planning.findOne({
      type: 'monthly',
      'period.start': { $lte: fimMes },
      'period.end': { $gte: inicioMes }
    });
    const metaReal = planningDoMes?.targets?.expectedRevenue || 0;
    const percentualAtual = metaReal > 0 ? (valorRealizados / metaReal) * 100 : 0;

    // Insights
    const insights = [];

    if (ehMesPassado) {
      insights.push({
        tipo: 'info',
        titulo: 'Mês Finalizado',
        mensagem: `Faturamento real: ${valorRealizados.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })}`
      });

      if (valorPendentes > 0) {
        insights.push({
          tipo: 'warning',
          titulo: `${pendentes.length} agendamentos não convertidos`,
          mensagem: `Perda potencial: ${valorPendentes.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })}`
        });
      }
    } else {
      // Insights para atual/futuro
      const gapMeta = metaReal - valorRealizados - valorAgendados;
      if (gapMeta > 0) {
        insights.push({
          tipo: 'warning',
          titulo: 'Meta em risco',
          mensagem: `Faltam ${gapMeta.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })} em agendamentos para bater a meta`,
          acao: 'Agendar mais pacientes'
        });
      }

      if (pendentes.length > 0) {
        const urgentes = pendentes.filter(p => {
          const dias = moment(p.date).diff(moment(), 'days');
          return dias <= 3 && dias >= 0;
        });

        if (urgentes.length > 0) {
          insights.push({
            tipo: 'error',
            titulo: `${urgentes.length} agendamentos precisam de confirmação urgente`,
            mensagem: 'Próximos 3 dias com pendências',
            acao: 'Confirmar agora'
          });
        }
      }
    }

    res.json({
      success: true,
      periodo: {
        mes,
        ano,
        hoje,
        fimMes,
        diasRestantes: moment(fimMes).diff(moment(hoje), 'days'),
        status: ehMesPassado ? 'PASSADO' : ehMesAtual ? 'ATUAL' : 'FUTURO'
      },
      resumo: {
        jaFaturado: valorRealizados,
        jaRecebido: valorJaRecebido,
        aReceber: valorRealizados - valorJaRecebido,
        atendimentosRealizados: quantidadeRealizados,
        valorProduzido: valorRealizados,
        ticketMedio: quantidadeRealizados > 0 ? valorRealizados / quantidadeRealizados : 0,
        particular: valorParticular,
        convenio: valorConvenio,
        agendadoConfirmado: valorAgendados,
        pendenteConfirmacao: valorPendentes,
        creditoPacotes: valorCreditoPacotes,
        convenioAgendado: valorConvenioAgendado,
        totalPotencial: valorRealizados + valorAgendados + valorPendentes + valorCreditoPacotes + valorConvenioAgendado
      },
      // Cenários atualizados incluindo crédito pacotes (90%) e convênio agendado (85%)
      cenarios: {
        pessimista: { 
          valor: Math.round(valorRealizados + (valorAgendados * 0.7) + (valorPendentes * 0.2) + (valorCreditoPacotes * 0.8) + (valorConvenioAgendado * 0.7)), 
          probabilidade: ehMesPassado ? 'Realizado' : '70%' 
        },
        realista: { 
          valor: Math.round(valorRealizados + (valorAgendados * 0.85) + (valorPendentes * (taxaConversao * 0.6)) + (valorCreditoPacotes * 0.90) + (valorConvenioAgendado * 0.85)), 
          probabilidade: ehMesPassado ? 'Realizado' : 'Mais provável' 
        },
        otimista: { 
          valor: Math.round(valorRealizados + (valorAgendados * 0.95) + (valorPendentes * 0.7) + (valorCreditoPacotes * 0.95) + (valorConvenioAgendado * 0.95)), 
          probabilidade: ehMesPassado ? 'Potencial' : '30%' 
        }
      },
      metas: {
        sugerida: Math.round(metaReal),
        gapParaMeta: ehMesPassado ? 0 : Math.max(0, metaReal - valorRealizados - valorAgendados - valorCreditoPacotes - valorConvenioAgendado),
        percentualAtual: Math.round(percentualAtual * 100) / 100
      },
      taxaConversaoHistorica: taxaConversao,
      insights,
      detalhes: {
        realizados: detalhesRealizados,
        agendados: agendados.map(a => ({
          _id: a._id,
          data: a.date,
          hora: a.time,
          valor: a.sessionValue,
          paciente: a.patient?.fullName
        })),
        pendentes: pendentes.map(p => ({
          _id: p._id,
          data: p.date,
          hora: p.time,
          valor: p.sessionValue,
          paciente: p.patient?.fullName,
          diasParaAtendimento: moment(p.date).diff(moment(), 'days')
        })),
        creditoPacotes: detalhesCreditoPacotes,
        convenioAgendado: detalhesConvenioAgendado
      }
    });
  } catch (error) {
    console.error('Erro na projeção:', error);
    res.status(500).json({ success: false, message: error.message });
  }
});

/**
 * GET /api/provisionamento/metricas-mes?month=2&year=2026
 * Métricas detalhadas do mês: atendimentos, cancelamentos, comparativos
 */
router.get('/metricas-mes', authorize(['admin', 'secretary']), async (req, res) => {
  try {
    const { month, year } = req.query;
    const mes = parseInt(month);
    const ano = parseInt(year);

    const inicioMes = `${ano}-${String(mes).padStart(2, '0')}-01`;
    const fimMes = moment(`${ano}-${String(mes).padStart(2, '0')}-01`).endOf('month').format('YYYY-MM-DD');

    // Mês anterior para comparação
    const inicioMesAnterior = moment(inicioMes).subtract(1, 'month').format('YYYY-MM-DD');
    const fimMesAnterior = moment(inicioMes).subtract(1, 'day').format('YYYY-MM-DD');

    // 1. ATENDIMENTOS DO MÊS ATUAL
    const atendimentosRealizados = await Appointment.countDocuments({
      date: { $gte: inicioMes, $lte: fimMes },
      clinicalStatus: 'completed'
    });

    const atendimentosCancelados = await Appointment.countDocuments({
      date: { $gte: inicioMes, $lte: fimMes },
      $or: [
        { clinicalStatus: 'cancelled' },
        { clinicalStatus: 'no_show' },
        { operationalStatus: 'canceled' }
      ]
    });

    const atendimentosAgendados = await Appointment.countDocuments({
      date: { $gte: inicioMes, $lte: fimMes }
    });

    // 2. VALORES DO MÊS ATUAL
    const pagamentosMes = await Payment.find({
      paymentDate: { $gte: inicioMes, $lte: fimMes },
      status: 'paid'
    });

    const faturamentoMes = pagamentosMes.reduce((sum, p) => sum + (p.amount || 0), 0);

    // 3. DADOS DO MÊS ANTERIOR (PARA COMPARAÇÃO)
    const atendimentosMesAnterior = await Appointment.countDocuments({
      date: { $gte: inicioMesAnterior, $lte: fimMesAnterior },
      clinicalStatus: 'completed'
    });

    const faturamentoMesAnterior = await Payment.aggregate([
      {
        $match: {
          paymentDate: { $gte: inicioMesAnterior, $lte: fimMesAnterior },
          status: 'paid'
        }
      },
      {
        $group: {
          _id: null,
          total: { $sum: '$amount' }
        }
      }
    ]);

    const valorMesAnterior = faturamentoMesAnterior[0]?.total || 0;

    // 4. CÁLCULO DE CRESCIMENTO
    const crescimentoAtendimentos = atendimentosMesAnterior > 0
      ? ((atendimentosRealizados - atendimentosMesAnterior) / atendimentosMesAnterior) * 100
      : 0;

    const crescimentoFaturamento = valorMesAnterior > 0
      ? ((faturamentoMes - valorMesAnterior) / valorMesAnterior) * 100
      : 0;

    // 5. TAXAS DO MÊS
    const taxaComparecimento = atendimentosAgendados > 0
      ? (atendimentosRealizados / atendimentosAgendados) * 100
      : 0;

    const taxaCancelamento = atendimentosAgendados > 0
      ? (atendimentosCancelados / atendimentosAgendados) * 100
      : 0;

    // 6. PROJEÇÃO DE CRESCIMENTO (se continuar nesse ritmo)
    const diasDecorridos = moment().diff(moment(inicioMes), 'days');
    const diasMes = moment(fimMes).diff(moment(inicioMes), 'days') + 1;
    const percentualDecorridos = diasDecorridos / diasMes;

    let projecaoCrescimento = 0;
    if (percentualDecorridos > 0 && atendimentosMesAnterior > 0) {
      const ritmoAtual = atendimentosRealizados / percentualDecorridos;
      projecaoCrescimento = ((ritmoAtual - atendimentosMesAnterior) / atendimentosMesAnterior) * 100;
    }

    // 7. POR ESPECIALIDADE (Top 5)
    const porEspecialidade = await Appointment.aggregate([
      {
        $match: {
          date: { $gte: inicioMes, $lte: fimMes },
          clinicalStatus: 'completed'
        }
      },
      {
        $lookup: {
          from: 'doctors',
          localField: 'doctor',
          foreignField: '_id',
          as: 'doctorInfo'
        }
      },
      {
        $group: {
          _id: { $arrayElemAt: ['$doctorInfo.specialty', 0] },
          total: { $sum: 1 },
          valor: { $sum: '$sessionValue' }
        }
      },
      { $sort: { total: -1 } },
      { $limit: 5 }
    ]);

    res.json({
      success: true,
      periodo: { mes, ano, inicio: inicioMes, fim: fimMes },
      resumo: {
        atendimentosRealizados,
        atendimentosCancelados,
        atendimentosAgendados,
        faturamentoMes,
        ticketMedio: atendimentosRealizados > 0 ? faturamentoMes / atendimentosRealizados : 0
      },
      comparativo: {
        mesAnterior: {
          atendimentos: atendimentosMesAnterior,
          faturamento: valorMesAnterior
        },
        crescimento: {
          atendimentos: Math.round(crescimentoAtendimentos * 100) / 100,
          faturamento: Math.round(crescimentoFaturamento * 100) / 100,
          projecao: Math.round(projecaoCrescimento * 100) / 100
        }
      },
      taxas: {
        comparecimento: Math.round(taxaComparecimento * 100) / 100,
        cancelamento: Math.round(taxaCancelamento * 100) / 100
      },
      porEspecialidade: porEspecialidade.map(item => ({
        especialidade: item._id || 'Não definida',
        atendimentos: item.total,
        valor: item.valor
      }))
    });
  } catch (error) {
    console.error('Erro ao buscar métricas:', error);
    res.status(500).json({ success: false, message: error.message });
  }
});

/**
 * GET /api/provisionamento/paciente/:id/resumo
 * Resumo financeiro de um paciente específico
 */
router.get('/paciente/:id/resumo', authorize(['admin', 'secretary']), async (req, res) => {
  try {
    const { id } = req.params;
    const Patient = (await import('../models/Patient.js')).default;
    const Payment = (await import('../models/Payment.js')).default;
    const Package = (await import('../models/Package.js')).default;

    const [patient, payments, packages] = await Promise.all([
      Patient.findById(id).select('fullName'),
      Payment.find({ patient: id, status: 'paid' }).lean(),
      Package.find({ patient: id }).populate('doctor', 'specialty').lean()
    ]);

    if (!patient) return res.status(404).json({ success: false, message: 'Paciente não encontrado' });

    const totalPago = payments.reduce((sum, p) => sum + (p.amount || 0), 0);
    const pacotesAtivos = packages.filter(p => p.status !== 'completed');
    const pacotesConcluidos = packages.filter(p => p.status === 'completed');

    res.json({
      success: true,
      data: {
        paciente: patient.fullName,
        estatisticas: {
          totalPago,
          qtdPagamentos: payments.length,
          pacotesAtivos: pacotesAtivos.length,
          pacotesConcluidos: pacotesConcluidos.length
        },
        pacotes: packages.map(p => ({
          _id: p._id,
          tipo: p.sessionType,
          status: p.status,
          totalSessoes: p.totalSessions,
          sessoesFeitas: p.sessionsDone,
          valorTotal: p.totalValue,
          pago: p.totalPaid
        }))
      }
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});
export default router;
