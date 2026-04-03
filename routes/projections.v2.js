// routes/projections.v2.js
/**
 * Projeções Financeiras V2
 * 
 * GET /v2/projections?month=4&year=2026
 * Retorna: ritmo, projeções, status vs meta
 */

import express from 'express';
import moment from 'moment-timezone';
import { auth } from '../middleware/auth.js';
import Payment from '../models/Payment.js';
import Appointment from '../models/Appointment.js';
import Planning from '../models/Planning.js';

const router = express.Router();
const TIMEZONE = 'America/Sao_Paulo';

/**
 * Calcula projeções financeiras
 */
router.get('/', auth, async (req, res) => {
    try {
        const { month, year } = req.query;
        const now = moment().tz(TIMEZONE);
        
        const targetMonth = month ? parseInt(month) : now.month() + 1;
        const targetYear = year ? parseInt(year) : now.year();
        
        const startOfMonth = moment.tz(`${targetYear}-${String(targetMonth).padStart(2, '0')}-01`, TIMEZONE).startOf('month');
        const endOfMonth = startOfMonth.clone().endOf('month');
        const today = now.clone().startOf('day');
        
        const isCurrentMonth = targetMonth === (now.month() + 1) && targetYear === now.year();
        const isPastMonth = targetYear < now.year() || (targetYear === now.year() && targetMonth < (now.month() + 1));
        
        // ======================================================
        // 1. BUSCAR META DO MÊS
        // ======================================================
        const planning = await Planning.findOne({
            type: 'monthly',
            'period.start': { $lte: endOfMonth.toDate() },
            'period.end': { $gte: startOfMonth.toDate() },
            clinicId: req.user?.clinicId || 'default'
        }).lean();
        
        const meta = planning?.targets?.expectedRevenue || 0;
        
        // ======================================================
        // 2. BUSCAR RECEBIDO NO MÊS
        // ======================================================
        const paymentsMatch = {
            status: { $ne: 'canceled' },
            paymentDate: {
                $gte: startOfMonth.format('YYYY-MM-DD'),
                $lte: isCurrentMonth ? today.format('YYYY-MM-DD') : endOfMonth.format('YYYY-MM-DD')
            }
        };
        
        const paymentsAgg = await Payment.aggregate([
            { $match: paymentsMatch },
            { 
                $group: {
                    _id: null,
                    totalReceived: { $sum: '$amount' },
                    count: { $sum: 1 }
                }
            }
        ]);
        
        const received = paymentsAgg[0]?.totalReceived || 0;
        
        // ======================================================
        // 3. BUSCAR PRODUÇÃO (sessões realizadas)
        // ======================================================
        const sessionsMatch = {
            status: { $nin: ['canceled', 'cancelled'] },
            date: {
                $gte: startOfMonth.format('YYYY-MM-DD'),
                $lte: isCurrentMonth ? today.format('YYYY-MM-DD') : endOfMonth.format('YYYY-MM-DD')
            }
        };
        
        const sessionsAgg = await Appointment.aggregate([
            { $match: sessionsMatch },
            {
                $group: {
                    _id: null,
                    totalProduction: { $sum: { $ifNull: ['$sessionValue', 0] } },
                    count: { $sum: 1 }
                }
            }
        ]);
        
        const production = sessionsAgg[0]?.totalProduction || 0;
        
        // ======================================================
        // 4. BUSCAR A RECEBER
        // ======================================================
        const pendingAgg = await Appointment.aggregate([
            {
                $match: {
                    status: { $nin: ['canceled', 'cancelled'] },
                    date: { $lte: isCurrentMonth ? today.format('YYYY-MM-DD') : endOfMonth.format('YYYY-MM-DD') },
                    $or: [
                        { paymentStatus: 'pending' },
                        { paymentStatus: { $exists: false } }
                    ]
                }
            },
            {
                $group: {
                    _id: null,
                    totalPending: { $sum: { $ifNull: ['$sessionValue', 0] } },
                    count: { $sum: 1 }
                }
            }
        ]);
        
        const aReceber = pendingAgg[0]?.totalPending || 0;
        
        // ======================================================
        // 5. BUSCAR AGENDAMENTOS FUTUROS CONFIRMADOS
        // ======================================================
        let agendadosConfirmados = 0;
        let agendadosPendentes = 0;
        
        if (isCurrentMonth) {
            const futureMatch = {
                status: { $nin: ['canceled', 'cancelled'] },
                date: {
                    $gt: today.format('YYYY-MM-DD'),
                    $lte: endOfMonth.format('YYYY-MM-DD')
                }
            };
            
            const futureAgg = await Appointment.aggregate([
                { $match: futureMatch },
                {
                    $group: {
                        _id: '$operationalStatus',
                        total: { $sum: { $ifNull: ['$sessionValue', 0] } },
                        count: { $sum: 1 }
                    }
                }
            ]);
            
            futureAgg.forEach(item => {
                if (item._id === 'confirmed') {
                    agendadosConfirmados = item.total;
                } else if (item._id === 'scheduled') {
                    agendadosPendentes = item.total;
                }
            });
        }
        
        // ======================================================
        // 6. CÁLCULOS DE RITMO E PROJEÇÃO
        // ======================================================
        const daysInMonth = endOfMonth.date();
        const daysElapsed = isCurrentMonth ? today.date() : (isPastMonth ? daysInMonth : 0);
        const daysRemaining = Math.max(0, daysInMonth - daysElapsed);
        
        const ritmoAtual = daysElapsed > 0 ? received / daysElapsed : 0;
        const ritmoNecessario = (meta > 0 && daysRemaining > 0) 
            ? Math.max(0, meta - received) / daysRemaining 
            : 0;
        
        // Cenários de projeção
        const baseGarantida = received + (aReceber * 0.9); // 90% do a receber
        const projecaoPessimista = baseGarantida + (agendadosConfirmados * 0.7) + (agendadosPendentes * 0.2);
        const projecaoRealista = baseGarantida + (agendadosConfirmados * 0.85) + (agendadosPendentes * 0.4);
        const projecaoOtimista = baseGarantida + (agendadosConfirmados * 0.95) + (agendadosPendentes * 0.7);
        
        // ======================================================
        // 7. STATUS E INSIGHTS
        // ======================================================
        const percentualMeta = meta > 0 ? (received / meta) * 100 : 0;
        const percentualMes = daysInMonth > 0 ? (daysElapsed / daysInMonth) * 100 : 0;
        const gap = meta - received;
        
        let status = 'no_track';
        let mensagem = '';
        
        if (meta === 0) {
            status = 'no_meta';
            mensagem = 'Nenhuma meta definida para o período';
        } else if (percentualMeta >= 100) {
            status = 'achieved';
            mensagem = `Meta atingida! ${(percentualMeta).toFixed(0)}%`;
        } else if (percentualMeta >= percentualMes) {
            status = 'on_track';
            mensagem = 'No ritmo da meta';
        } else if (percentualMeta >= percentualMes - 10) {
            status = 'at_risk';
            mensagem = 'Levemente abaixo do ritmo';
        } else {
            status = 'behind';
            mensagem = `${(percentualMes - percentualMeta).toFixed(0)}% abaixo do esperado`;
        }
        
        // ======================================================
        // 8. RESPOSTA
        // ======================================================
        res.json({
            success: true,
            data: {
                period: {
                    month: targetMonth,
                    year: targetYear,
                    daysInMonth,
                    daysElapsed,
                    daysRemaining,
                    isCurrentMonth,
                    isPastMonth
                },
                meta: {
                    value: meta,
                    percentualAtingido: Math.round(percentualMeta * 10) / 10,
                    gap: Math.round(gap * 100) / 100,
                    status,
                    mensagem
                },
                atual: {
                    received: Math.round(received * 100) / 100,
                    production: Math.round(production * 100) / 100,
                    aReceber: Math.round(aReceber * 100) / 100,
                    agendadosConfirmados: Math.round(agendadosConfirmados * 100) / 100,
                    agendadosPendentes: Math.round(agendadosPendentes * 100) / 100
                },
                ritmo: {
                    atual: Math.round(ritmoAtual * 100) / 100,
                    necessario: Math.round(ritmoNecessario * 100) / 100,
                    isOnTrack: ritmoAtual >= ritmoNecessario || meta === 0
                },
                projecao: {
                    pessimista: Math.round(projecaoPessimista * 100) / 100,
                    realista: Math.round(projecaoRealista * 100) / 100,
                    otimista: Math.round(projecaoOtimista * 100) / 100,
                    vsMeta: meta > 0 ? Math.round((projecaoRealista / meta) * 1000) / 10 : 0
                }
            }
        });
        
    } catch (error) {
        console.error('[ProjectionsV2] Erro:', error);
        res.status(500).json({ 
            success: false, 
            error: error.message 
        });
    }
});

export default router;
