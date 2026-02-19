// routes/planningRoutes.js
import express from 'express';
import { auth, authorize } from '../middleware/auth.js';
import Planning from '../models/Planning.js';
import { updatePlanningProgress, updateAllPlanningsProgress, createWeeklyPlanning, createMonthlyPlanning, calculateDetailedProgress } from '../services/planningService.js';

const router = express.Router();

console.log('[Planning Routes] ✅ Rotas de planejamento carregadas');

/**
 * @route   GET /api/planning/test
 * @desc    Testar se as rotas estão funcionando
 */
router.get('/test', (req, res) => {
  res.json({ success: true, message: 'Rotas de planejamento OK', timestamp: new Date() });
});

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
 * @desc    Listar planejamentos (com recálculo automático)
 * @query   ?type=weekly&status=on_track&refresh=true
 */
router.get('/', auth, async (req, res) => {
  try {
    const { type, status, startDate, endDate, refresh } = req.query;

    const filters = {};
    if (type) filters.type = type;
    if (status) filters['progress.overallStatus'] = status;
    if (startDate && endDate) {
      filters['period.start'] = { $gte: startDate };
      filters['period.end'] = { $lte: endDate };
    }

    // Buscar planejamentos
    let plannings = await Planning.find(filters)
      .populate('byDoctor.doctor', 'fullName specialty')
      .populate('createdBy', 'fullName')
      .sort({ 'period.start': -1 });

    // Se solicitado refresh, recalcular todos
    if (refresh === 'true') {
      console.log('[Planning GET] 🔄 Recalculando todos os planejamentos...');
      for (const planning of plannings) {
        try {
          await updatePlanningProgress(planning._id);
        } catch (err) {
          console.error(`[Planning GET] ❌ Erro ao atualizar ${planning._id}:`, err.message);
        }
      }
      
      // Buscar novamente após atualização
      plannings = await Planning.find(filters)
        .populate('byDoctor.doctor', 'fullName specialty')
        .populate('createdBy', 'fullName')
        .sort({ 'period.start': -1 });
    }

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
 * @route   GET /api/planning/:id/details
 * @desc    Buscar detalhes do planejamento com projeções
 */
router.get('/:id/details', auth, async (req, res) => {
  try {
    const details = await calculateDetailedProgress(req.params.id);

    res.json({
      success: true,
      data: details
    });

  } catch (error) {
    console.error('Erro ao buscar detalhes:', error);
    res.status(500).json({
      success: false,
      message: 'Erro ao buscar detalhes do planejamento',
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
 * @route   POST /api/planning/refresh-all
 * @desc    Atualizar progresso de todos os planejamentos ativos
 */
router.post('/refresh-all', auth, authorize(['admin']), async (req, res) => {
  try {
    const result = await updateAllPlanningsProgress();

    res.json({
      success: true,
      message: `${result.updated} planejamentos atualizados 💚`,
      data: result
    });

  } catch (error) {
    console.error('Erro ao atualizar planejamentos:', error);
    res.status(500).json({
      success: false,
      message: 'Erro ao atualizar planejamentos',
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

/**
 * @route   PUT /api/planning/:id
 * @desc    Atualizar planejamento existente
 */
router.put('/:id', auth, authorize(['admin', 'secretary']), async (req, res) => {
  console.log(`[Planning PUT] 📝 Atualizando planejamento: ${req.params.id}`);
  try {
    const { type, period, targets, byDoctor, bySpecialty, notes, actual } = req.body;

    const planning = await Planning.findById(req.params.id);
    
    if (!planning) {
      return res.status(404).json({
        success: false,
        message: 'Planejamento não encontrado'
      });
    }

    // Atualizar campos
    if (type) planning.type = type;
    if (period) planning.period = { ...planning.period, ...period };
    if (targets) planning.targets = { ...planning.targets, ...targets };
    if (byDoctor) planning.byDoctor = byDoctor;
    if (bySpecialty) planning.bySpecialty = bySpecialty;
    if (notes !== undefined) planning.notes = notes;
    if (actual) planning.actual = { ...planning.actual, ...actual };

    await planning.save();

    res.json({
      success: true,
      message: 'Planejamento atualizado com sucesso 💚',
      data: planning
    });

  } catch (error) {
    console.error('Erro ao atualizar planejamento:', error);
    res.status(500).json({
      success: false,
      message: 'Erro ao atualizar planejamento',
      error: error.message
    });
  }
});

/**
 * @route   DELETE /api/planning/:id
 * @desc    Excluir planejamento
 */
router.delete('/:id', auth, authorize(['admin']), async (req, res) => {
  console.log(`[Planning DELETE] 🗑️ Excluindo planejamento: ${req.params.id}`);
  try {
    const planning = await Planning.findById(req.params.id);
    
    if (!planning) {
      return res.status(404).json({
        success: false,
        message: 'Planejamento não encontrado'
      });
    }

    await Planning.findByIdAndDelete(req.params.id);

    res.json({
      success: true,
      message: 'Planejamento excluído com sucesso 💚'
    });

  } catch (error) {
    console.error('Erro ao excluir planejamento:', error);
    res.status(500).json({
      success: false,
      message: 'Erro ao excluir planejamento',
      error: error.message
    });
  }
});

export default router;