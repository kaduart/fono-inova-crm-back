// routes/planningRoutes.js
import express from 'express';
import { auth, authorize } from '../middleware/auth.js';
import Planning from '../models/Planning.js';
import { updatePlanningProgress, createWeeklyPlanning, createMonthlyPlanning } from '../services/planningService.js';

const router = express.Router();

/**
 * @route   POST /api/planning
 * @desc    Criar novo planejamento
 */
router.post('/', auth, authorize(['admin', 'secretary']), async (req, res) => {
  try {
    const { type, period, targets, byDoctor, bySpecialty, notes } = req.body;

    const planning = await Planning.create({
      type,
      period,
      targets,
      byDoctor,
      bySpecialty,
      notes,
      createdBy: req.user.id
    });

    res.status(201).json({
      success: true,
      message: 'Planejamento criado com sucesso 💚',
      data: planning
    });

  } catch (error) {
    console.error('Erro ao criar planejamento:', error);
    res.status(500).json({
      success: false,
      message: 'Erro ao criar planejamento',
      error: error.message
    });
  }
});

/**
 * @route   GET /api/planning
 * @desc    Listar planejamentos
 * @query   ?type=weekly&status=on_track
 */
router.get('/', auth, async (req, res) => {
  try {
    const { type, status, startDate, endDate } = req.query;

    const filters = {};
    if (type) filters.type = type;
    if (status) filters['progress.overallStatus'] = status;
    if (startDate && endDate) {
      filters['period.start'] = { $gte: startDate };
      filters['period.end'] = { $lte: endDate };
    }

    const plannings = await Planning.find(filters)
      .populate('byDoctor.doctor', 'fullName specialty')
      .populate('createdBy', 'fullName')
      .sort({ 'period.start': -1 })
      .lean();

    res.json({
      success: true,
      count: plannings.length,
      data: plannings
    });

  } catch (error) {
    console.error('Erro ao listar planejamentos:', error);
    res.status(500).json({
      success: false,
      message: 'Erro ao listar planejamentos',
      error: error.message
    });
  }
});

/**
 * @route   PATCH /api/planning/:id/update-progress
 * @desc    Atualizar progresso com dados reais
 */
router.patch('/:id/update-progress', auth, async (req, res) => {
  try {
    const planning = await updatePlanningProgress(req.params.id);

    res.json({
      success: true,
      message: 'Progresso atualizado 💚',
      data: planning
    });

  } catch (error) {
    console.error('Erro ao atualizar progresso:', error);
    res.status(500).json({
      success: false,
      message: 'Erro ao atualizar progresso',
      error: error.message
    });
  }
});

/**
 * @route   POST /api/planning/quick/weekly
 * @desc    Criar planejamento semanal rápido
 */
router.post('/quick/weekly', auth, authorize(['admin']), async (req, res) => {
  try {
    const { startDate } = req.body;
    const planning = await createWeeklyPlanning(startDate, req.user.id);

    res.status(201).json({
      success: true,
      message: 'Planejamento semanal criado 💚',
      data: planning
    });

  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Erro ao criar planejamento',
      error: error.message
    });
  }
});

/**
 * @route   POST /api/planning/quick/monthly
 * @desc    Criar planejamento mensal rápido
 */
router.post('/quick/monthly', auth, authorize(['admin']), async (req, res) => {
  try {
    const { month, year } = req.body;
    const planning = await createMonthlyPlanning(month, year, req.user.id);

    res.status(201).json({
      success: true,
      message: 'Planejamento mensal criado 💚',
      data: planning
    });

  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Erro ao criar planejamento',
      error: error.message
    });
  }
});

export default router;