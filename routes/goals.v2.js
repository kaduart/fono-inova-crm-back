// routes/goals.v2.js
/**
 * Metas V2 - Simplificado para configuração rápida
 * Usa o modelo Planning existente
 */

import express from 'express';
import moment from 'moment-timezone';
import { auth } from '../middleware/auth.js';
import Planning from '../models/Planning.js';
import { updatePlanningProgress } from '../services/planningService.js';

const router = express.Router();
const TIMEZONE = 'America/Sao_Paulo';

/**
 * GET /api/v2/goals - Buscar meta atual
 */
router.get('/', auth, async (req, res) => {
    try {
        const { month, year, type = 'monthly' } = req.query;
        
        const targetMonth = month ? parseInt(month) : moment().tz(TIMEZONE).month() + 1;
        const targetYear = year ? parseInt(year) : moment().tz(TIMEZONE).year();
        
        // Busca planejamento do mês
        const start = `${targetYear}-${String(targetMonth).padStart(2, '0')}-01`;
        const lastDay = new Date(targetYear, targetMonth, 0).getDate();
        const end = `${targetYear}-${String(targetMonth).padStart(2, '0')}-${lastDay}`;
        
        let planning = await Planning.findOne({
            type,
            'period.start': start,
            'period.end': end,
            createdBy: req.user?.id
        });
        
        // Se não existe, retorna estrutura vazia
        if (!planning) {
            return res.json({
                success: true,
                data: {
                    exists: false,
                    month: targetMonth,
                    year: targetYear,
                    targets: {
                        expectedRevenue: 0,
                        totalSessions: 0,
                        workHours: 0
                    },
                    actual: {
                        actualRevenue: 0,
                        completedSessions: 0
                    },
                    progress: {
                        revenuePercentage: 0,
                        gapRevenue: 0,
                        overallStatus: 'no_goal'
                    }
                }
            });
        }
        
        // Atualiza progresso antes de retornar
        await updatePlanningProgress(planning._id);
        planning = await Planning.findById(planning._id);
        
        res.json({
            success: true,
            data: {
                exists: true,
                id: planning._id,
                month: targetMonth,
                year: targetYear,
                targets: planning.targets,
                actual: planning.actual,
                progress: planning.progress
            }
        });
        
    } catch (error) {
        console.error('[GoalsV2] Erro:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

/**
 * POST /api/v2/goals - Criar ou atualizar meta
 */
router.post('/', auth, async (req, res) => {
    try {
        const { month, year, type = 'monthly', startDate, endDate, expectedRevenue, totalSessions, workHours, notes } = req.body;
        
        let start, end, goalType;
        
        if (type === 'daily' && startDate) {
            // Meta diária
            goalType = 'daily';
            start = startDate;
            end = endDate || startDate;
        } else if (type === 'weekly' && startDate) {
            // Meta semanal
            goalType = 'weekly';
            start = startDate;
            end = endDate || moment.tz(startDate, TIMEZONE).endOf('week').format('YYYY-MM-DD');
        } else {
            // Meta mensal (padrão)
            goalType = 'monthly';
            const targetMonth = month || moment().tz(TIMEZONE).month() + 1;
            const targetYear = year || moment().tz(TIMEZONE).year();
            start = `${targetYear}-${String(targetMonth).padStart(2, '0')}-01`;
            const lastDay = new Date(targetYear, targetMonth, 0).getDate();
            end = `${targetYear}-${String(targetMonth).padStart(2, '0')}-${lastDay}`;
        }
        
        // Busca se já existe (qualquer tipo)
        let planning = await Planning.findOne({
            type: goalType,
            'period.start': start,
            'period.end': end,
            createdBy: req.user?.id
        });
        
        if (planning) {
            // Atualiza
            planning.targets.expectedRevenue = expectedRevenue || planning.targets.expectedRevenue;
            planning.targets.totalSessions = totalSessions || planning.targets.totalSessions;
            planning.targets.workHours = workHours || planning.targets.workHours;
            if (notes) planning.notes = notes;
            
            await planning.save();
            
            return res.json({
                success: true,
                message: 'Meta atualizada!',
                data: planning
            });
        }
        
        // Cria novo
        planning = await Planning.create({
            type: goalType,
            period: { start, end },
            targets: {
                expectedRevenue: expectedRevenue || 0,
                totalSessions: totalSessions || 0,
                workHours: workHours || 0
            },
            actual: {
                actualRevenue: 0,
                completedSessions: 0,
                workedHours: 0
            },
            createdBy: req.user?.id,
            notes
        });
        
        res.status(201).json({
            success: true,
            message: 'Meta criada!',
            data: planning
        });
        
    } catch (error) {
        console.error('[GoalsV2] Erro:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

/**
 * DELETE /api/v2/goals/:id - Remover meta
 */
router.delete('/:id', auth, async (req, res) => {
    try {
        await Planning.findByIdAndDelete(req.params.id);
        res.json({ success: true, message: 'Meta removida' });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

export default router;
