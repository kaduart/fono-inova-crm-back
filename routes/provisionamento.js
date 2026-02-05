import express from 'express';
import { auth, authorize } from '../middleware/auth.js';
import Appointment from '../models/Appointment.js';
import { 
  calcularProvisionamento, 
  confirmarAgendamentosMassa,
  liberarVagasMassa 
} from '../services/provisionamentoService.js';

const router = express.Router();

// Todas as rotas protegidas
router.use(auth);

/**
 * GET /api/provisionamento?mes=03&ano=2024
 * Calcula provisionamento completo do mês
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
 * GET /api/provisionamento/agenda-temporaria
 * Lista detalhada dos agendamentos pendentes (próximos 7 dias)
 */
router.get('/agenda-temporaria', authorize(['admin', 'secretary']), async (req, res) => {
  try {
    const hoje = new Date().toISOString().split('T')[0];
    const proximaSemana = new Date();
    proximaSemana.setDate(proximaSemana.getDate() + 7);
    
    const pendentes = await Appointment.find({
      operationalStatus: 'pending',
      date: { $gte: hoje, $lte: proximaSemana.toISOString().split('T')[0] }
    })
    .populate('patient', 'fullName phoneNumber')
    .populate('doctor', 'fullName specialty')
    .sort({ date: 1, time: 1 })
    .lean();
    
    // Enriquecer com dados de risco
    const agora = new Date();
    const enriquecidos = pendentes.map(apt => {
      const dataApt = new Date(apt.date + 'T' + (apt.time || '00:00'));
      const horasRestantes = Math.floor((dataApt - agora) / (1000 * 60 * 60));
      
      return {
        ...apt,
        risco: horasRestantes <= 24 ? 'urgente' : 
               horasRestantes <= 72 ? 'medio' : 'baixo',
        acaoSugerida: horasRestantes <= 24 ? 'ligar_agora' : 
                     horasRestantes <= 72 ? 'enviar_lembrete' : 'aguardar',
        horasRestantes: Math.max(0, horasRestantes)
      };
    });
    
    res.json({
      success: true,
      total: pendentes.length,
      urgentes: enriquecidos.filter(p => p.risco === 'urgente').length,
      data: enriquecidos
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
 * POST /api/provisionamento/confirmar-massa
 * Confirma múltiplos agendamentos pendentes
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
 * POST /api/provisionamento/liberar-vagas
 * Cancela/libera múltiplos agendamentos pendentes
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

export default router;
