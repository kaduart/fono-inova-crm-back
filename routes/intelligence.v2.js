// routes/intelligence.v2.js
/**
 * Inteligência Financeira V2
 * 
 * GET /api/v2/intelligence?month=4&year=2026
 * Retorna: metas, ritmo, projeção, status completo
 */

import express from 'express';
import moment from 'moment-timezone';
import { auth } from '../middleware/auth.js';
import Planning from '../models/Planning.js';
import Payment from '../models/Payment.js';
import Appointment from '../models/Appointment.js';

const router = express.Router();
const TIMEZONE = 'America/Sao_Paulo';

/**
 * Calcula inteligência financeira completa
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
        
        // ======================================================
        // 1. BUSCAR META MENSAL (PADRONIZADO com goals.v2.js)
        // ======================================================
        const start = `${targetYear}-${String(targetMonth).padStart(2, '0')}-01`;
        const lastDay = new Date(targetYear, targetMonth, 0).getDate();
        const end = `${targetYear}-${String(targetMonth).padStart(2, '0')}-${lastDay}`;
        
        const planning = await Planning.findOne({
            type: 'monthly',
            'period.start': start,
            'period.end': end,
            createdBy: req.user?.id
        }).lean();
        
        const metaMensal = planning?.targets?.expectedRevenue || 0;
        
        // ======================================================
        // 2. BUSCAR RECEBIDO NO MÊS
        // ======================================================
        const paymentsMatch = {
            status: { $in: ['paid', 'completed', 'confirmed'] },
            $or: [
                {
                    paymentDate: {
                        $gte: startOfMonth.format('YYYY-MM-DD'),
                        $lte: isCurrentMonth ? today.format('YYYY-MM-DD') : endOfMonth.format('YYYY-MM-DD')
                    }
                },
                {
                    createdAt: { 
                        $gte: startOfMonth.toDate(), 
                        $lte: isCurrentMonth ? today.endOf('day').toDate() : endOfMonth.toDate() 
                    }
                }
            ]
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
        
        const recebido = paymentsAgg[0]?.totalReceived || 0;
        
        // ======================================================
        // 3. BUSCAR A RECEBER E AGENDADOS
        // ======================================================
        const aReceberAgg = await Appointment.aggregate([
            {
                $match: {
                    operationalStatus: { $nin: ['canceled'] },
                    appointmentId: { $exists: false },
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
                    total: { $sum: { $ifNull: ['$sessionValue', 0] } },
                    count: { $sum: 1 }
                }
            }
        ]);
        
        const aReceber = aReceberAgg[0]?.total || 0;
        
        // Agendados confirmados futuros
        let agendadosConfirmados = 0;
        if (isCurrentMonth) {
            const futureAgg = await Appointment.aggregate([
                {
                    $match: {
                        operationalStatus: 'confirmed',
                        appointmentId: { $exists: false },
                        date: { $gt: today.format('YYYY-MM-DD'), $lte: endOfMonth.format('YYYY-MM-DD') }
                    }
                },
                {
                    $group: {
                        _id: null,
                        total: { $sum: { $ifNull: ['$sessionValue', 0] } }
                    }
                }
            ]);
            agendadosConfirmados = futureAgg[0]?.total || 0;
        }
        
        // ======================================================
        // 4. CÁLCULOS DE TEMPO
        // ======================================================
        const daysInMonth = endOfMonth.date();
        const daysElapsed = isCurrentMonth ? today.date() : daysInMonth;
        const daysRemaining = Math.max(0, daysInMonth - daysElapsed);
        
        // ======================================================
        // 5. METAS DERIVADAS
        // ======================================================
        const metaDiaria = metaMensal > 0 ? metaMensal / daysInMonth : 0;
        const metaSemanal = metaMensal > 0 ? metaMensal / 4 : 0; // 4 semanas no mês
        
        // Calcular semana atual
        const currentWeekStart = today.clone().startOf('week');
        const currentWeekEnd = today.clone().endOf('week');
        const weekDaysElapsed = today.day() === 0 ? 7 : today.day(); // 1-7
        const weekDaysRemaining = 7 - weekDaysElapsed + 1;
        
        // Recebido na semana atual
        const weekPayments = await Payment.aggregate([
            {
                $match: {
                    status: { $in: ['paid', 'completed', 'confirmed'] },
                    $or: [
                        { paymentDate: { $gte: currentWeekStart.format('YYYY-MM-DD'), $lte: currentWeekEnd.format('YYYY-MM-DD') } },
                        { createdAt: { $gte: currentWeekStart.toDate(), $lte: currentWeekEnd.toDate() } }
                    ]
                }
            },
            { $group: { _id: null, total: { $sum: '$amount' } } }
        ]);
        const recebidoSemana = weekPayments[0]?.total || 0;
        
        // Recebido hoje
        const todayPayments = await Payment.aggregate([
            {
                $match: {
                    status: { $in: ['paid', 'completed', 'confirmed'] },
                    $or: [
                        { paymentDate: today.format('YYYY-MM-DD') },
                        { createdAt: { $gte: today.toDate(), $lte: today.endOf('day').toDate() } }
                    ]
                }
            },
            { $group: { _id: null, total: { $sum: '$amount' } } }
        ]);
        const recebidoHoje = todayPayments[0]?.total || 0;
        
        // ======================================================
        // 6. RITMO E PROJEÇÃO
        // ======================================================
        const ritmoAtual = daysElapsed > 0 ? recebido / daysElapsed : 0;
        const ritmoNecessario = (metaMensal > 0 && daysRemaining > 0) 
            ? (metaMensal - recebido) / daysRemaining 
            : 0;
        
        // Projeções
        const baseGarantida = recebido + (aReceber * 0.9);
        const projecaoPessimista = baseGarantida + (agendadosConfirmados * 0.6);
        const projecaoRealista = baseGarantida + (agendadosConfirmados * 0.85);
        const projecaoOtimista = baseGarantida + (agendadosConfirmados * 0.95) + (metaDiaria * daysRemaining * 0.3);
        
        // ======================================================
        // 7. STATUS E GAPS
        // ======================================================
        const percentualMeta = metaMensal > 0 ? (recebido / metaMensal) * 100 : 0;
        const gapMensal = Math.max(0, metaMensal - recebido);
        const gapDiario = Math.max(0, metaDiaria - recebidoHoje);
        const gapSemanal = Math.max(0, metaSemanal - recebidoSemana);
        
        let statusMensal = 'no_goal';
        if (metaMensal > 0) {
            if (percentualMeta >= 100) statusMensal = 'achieved';
            else if (ritmoAtual >= ritmoNecessario) statusMensal = 'on_track';
            else if (ritmoAtual >= ritmoNecessario * 0.8) statusMensal = 'at_risk';
            else statusMensal = 'behind';
        }
        
        // Quantos atendimentos/pacotes faltam
        const ticketMedio = 200;
        const valorPacote = 1500;
        const sessoesNecessarias = gapMensal > 0 ? Math.ceil(gapMensal / ticketMedio) : 0;
        const pacotesNecessarios = gapMensal > 0 ? Math.ceil(gapMensal / valorPacote) : 0;
        
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
                    isCurrentMonth
                },
                
                // Metas
                metas: {
                    mensal: metaMensal,
                    diaria: Math.round(metaDiaria * 100) / 100,
                    semanal: Math.round(metaSemanal * 100) / 100
                },
                
                // Realizado
                realizado: {
                    mensal: Math.round(recebido * 100) / 100,
                    semanal: Math.round(recebidoSemana * 100) / 100,
                    diario: Math.round(recebidoHoje * 100) / 100,
                    aReceber: Math.round(aReceber * 100) / 100,
                    agendadosConfirmados: Math.round(agendadosConfirmados * 100) / 100
                },
                
                // Progresso
                progresso: {
                    percentual: Math.round(percentualMeta * 10) / 10,
                    status: statusMensal,
                    gap: Math.round(gapMensal * 100) / 100
                },
                
                // Ritmo
                ritmo: {
                    atual: Math.round(ritmoAtual * 100) / 100,
                    necessario: Math.round(ritmoNecessario * 100) / 100,
                    diferenca: Math.round((ritmoAtual - ritmoNecessario) * 100) / 100,
                    isOnTrack: ritmoAtual >= ritmoNecessario
                },
                
                // Gap detalhado
                gap: {
                    mensal: Math.round(gapMensal * 100) / 100,
                    semanal: Math.round(gapSemanal * 100) / 100,
                    diario: Math.round(gapDiario * 100) / 100,
                    sessoesNecessarias,
                    pacotesNecessarios,
                    ticketMedio,
                    valorPacote
                },
                
                // Projeções
                projecao: {
                    pessimista: Math.round(projecaoPessimista * 100) / 100,
                    realista: Math.round(projecaoRealista * 100) / 100,
                    otimista: Math.round(projecaoOtimista * 100) / 100,
                    vsMeta: metaMensal > 0 ? Math.round((projecaoRealista / metaMensal) * 1000) / 10 : 0
                }
            }
        });
        
    } catch (error) {
        console.error('[IntelligenceV2] Erro:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

export default router;
