// services/planningService.js
import mongoose from 'mongoose';
import moment from 'moment-timezone';
import Planning from '../models/Planning.js';
import Session from '../models/Session.js';
import Payment from '../models/Payment.js';
import Appointment from '../models/Appointment.js';
import Package from '../models/Package.js';
import unifiedFinancialService from './unifiedFinancialService.v2.js';
import { recalculateFutureTargets } from './planningAutoService.js';
import { isInsuranceAppointment } from '../utils/appointmentMapper.js';

/**
 * Atualiza automaticamente o progresso do planejamento
 * baseado nos dados reais de sessões e pagamentos
 */
export const updatePlanningProgress = async (planningId) => {
    try {
        const planning = await Planning.findById(planningId);
        if (!planning) throw new Error('Planejamento não encontrado');

        const { start, end } = planning.period;

        console.log(`[Planning Update] 📊 Atualizando planejamento ${planningId}`);
        console.log(`[Planning Update] 📅 Período: ${start} a ${end}`);

        // 🆕 CORREÇÃO: Converte strings para Date objects após migração
        const startDateObj = new Date(start + 'T00:00:00-03:00');
        const endDateObj = new Date(end + 'T23:59:59-03:00');

        const startDate = new Date(start + 'T00:00:00.000Z');
        const endDate = new Date(end + 'T23:59:59.999Z');

        // Todas as queries em paralelo
        const [sessions, payments, appointments, productionResult, cashResult] = await Promise.all([
            Session.find({ date: { $gte: startDateObj, $lte: endDateObj }, status: 'completed' }).lean(),
            Payment.find({ paymentDate: { $gte: startDateObj, $lte: endDateObj }, status: 'paid' }).lean(),
            Appointment.find({ date: { $gte: startDateObj, $lte: endDateObj }, clinicalStatus: 'completed' }).lean(),
            unifiedFinancialService.calculateProduction(startDate, endDate),
            unifiedFinancialService.calculateCash(startDate, endDate)
        ]);

        const completedSessions = sessions.length;

        // 🎯 RESULTADO ECONÔMICO DO MÊS
        // = caixa recebido + produção não recebida (convênio pendente)
        // Evita duplicar particular/pacote/liminar já recebidos.
        const convenioProduzido = productionResult.convenio || 0;
        const convenioRecebido = (cashResult.convenio || 0) + (cashResult.pacote || 0);
        const convenioNaoRecebido = Math.max(0, convenioProduzido - convenioRecebido);

        const actualRevenue = (cashResult.total || 0) + convenioNaoRecebido;
        const actualRevenueParticular = productionResult.particular || 0;
        const actualRevenuePacote = productionResult.pacote || 0;
        const actualRevenueConvenio = convenioProduzido;
        const actualRevenueLiminar = productionResult.liminar || 0;
        const actualRevenueConvenioAReceber = convenioNaoRecebido;
        
        // Calcular horas trabalhadas (baseado na duração dos agendamentos ou 40min padrão)
        const workedHours = appointments.length > 0 
            ? appointments.reduce((sum, apt) => sum + ((apt.duration || 40) / 60), 0)
            : completedSessions * 0.67; // 40min = 0.67h

        // Atualizar dados reais
        planning.actual.completedSessions = completedSessions;
        planning.actual.workedHours = parseFloat(workedHours.toFixed(2));
        planning.actual.usedSlots = completedSessions;
        planning.actual.actualRevenue = actualRevenue;
        planning.actual.actualRevenueParticular = actualRevenueParticular;
        planning.actual.actualRevenueConvenio = actualRevenueConvenio;
        planning.actual.actualRevenueConvenioAReceber = actualRevenueConvenioAReceber;

        console.log(`[Planning Update] ✅ Dados atualizados:`);
        console.log(`[Planning Update]    - Sessões: ${completedSessions}`);
        console.log(`[Planning Update]    - RESULTADO ECONÔMICO: R$ ${actualRevenue}`);
        console.log(`[Planning Update]      ├─ Caixa Recebido:      R$ ${cashResult.total || 0}`);
        console.log(`[Planning Update]      ├─ Convênio Produzido:  R$ ${convenioProduzido}`);
        console.log(`[Planning Update]      ├─ Convênio Recebido:   R$ ${convenioRecebido}`);
        console.log(`[Planning Update]      ├─ Convênio Não Receb:  R$ ${convenioNaoRecebido}`);
        console.log(`[Planning Update]      ├─ Particular:          R$ ${actualRevenueParticular}`);
        console.log(`[Planning Update]      ├─ Pacote:              R$ ${actualRevenuePacote}`);
        console.log(`[Planning Update]      └─ Liminar:             R$ ${actualRevenueLiminar}`);
        console.log(`[Planning Update]    - Horas: ${workedHours.toFixed(2)}h`);
        console.log(`[Planning Update]    - Breakdown raw:`, JSON.stringify(productionResult.byPaymentMethod, null, 2));

        await planning.save(); // Middleware calcula progresso automaticamente

        // Se for planejamento mensal do mês atual/futuro, recalcular metas futuras
        if (planning.type === 'monthly') {
            const today = new Date().toISOString().split('T')[0];
            if (planning.period.end >= today) {
                try {
                    const month = parseInt(planning.period.start.split('-')[1]);
                    const year = parseInt(planning.period.start.split('-')[0]);
                    await recalculateFutureTargets(month, year);
                } catch (recalcErr) {
                    console.error('[Planning Update] ❌ Erro ao recalcular metas futuras:', recalcErr.message);
                }
            }
        }

        return planning;

    } catch (error) {
        console.error('[Planning Update] ❌ Erro ao atualizar progresso:', error);
        throw error;
    }
};

/**
 * Atualiza o progresso de TODOS os planejamentos ativos
 * Útil para rodar em cron jobs
 */
export const updateAllPlanningsProgress = async () => {
    try {
        const today = new Date().toISOString().split('T')[0];
        
        // Buscar planejamentos que ainda estão em andamento
        const plannings = await Planning.find({
            'period.end': { $gte: today }
        });

        console.log(`[Planning Update] 🔄 Atualizando ${plannings.length} planejamentos...`);

        const results = [];
        for (const planning of plannings) {
            try {
                const updated = await updatePlanningProgress(planning._id);
                results.push({
                    id: planning._id,
                    status: 'success',
                    progress: updated.progress
                });
            } catch (err) {
                results.push({
                    id: planning._id,
                    status: 'error',
                    error: err.message
                });
            }
        }

        return {
            success: true,
            updated: results.filter(r => r.status === 'success').length,
            failed: results.filter(r => r.status === 'error').length,
            results
        };

    } catch (error) {
        console.error('[Planning Update] ❌ Erro ao atualizar todos os planejamentos:', error);
        throw error;
    }
};

/**
 * Cria planejamento semanal automático
 */
export const createWeeklyPlanning = async (startDate, userId) => {
    const endDate = moment(startDate).add(6, 'days').format('YYYY-MM-DD');

    return await Planning.create({
        type: 'weekly',
        period: { start: startDate, end: endDate },
        targets: {
            totalSessions: 40,      // exemplo: 40 sessões/semana
            workHours: 26.8,        // 40 sessões * 40min
            availableSlots: 50,     // 50 vagas disponíveis
            expectedRevenue: 8000   // R$ 8k esperado
        },
        createdBy: userId
    });
};

/**
 * Cria planejamento mensal automático
 */
export const createMonthlyPlanning = async (month, year, userId) => {
    const startDate = `${year}-${String(month).padStart(2, '0')}-01`;
    const lastDay = new Date(year, month, 0).getDate();
    const endDate = `${year}-${String(month).padStart(2, '0')}-${lastDay}`;

    return await Planning.create({
        type: 'monthly',
        period: { start: startDate, end: endDate },
        targets: {
            totalSessions: 160,      // exemplo: 160 sessões/mês
            workHours: 107,          // 160 * 40min
            availableSlots: 160,
            expectedRevenue: 32000   // R$ 32k esperado
        },
        createdBy: userId
    });
};

/**
 * Calcula o progresso detalhado com informações extras
 * Retorna dados enriquecidos para o dashboard
 */
export const calculateDetailedProgress = async (planningId) => {
    try {
        const planning = await Planning.findById(planningId);
        if (!planning) throw new Error('Planejamento não encontrado');

        const { start, end } = planning.period;

        // 1. Buscar pagamentos do período com detalhes do paciente
        const pagamentos = await Payment.find({
            paymentDate: { $gte: start, $lte: end },
            status: 'paid'
        })
            .populate('patient', 'fullName phoneNumber')
            .populate('doctor', 'fullName specialty')
            .sort({ paymentDate: -1 })
            .lean();

        // Agrupar por paciente
        const porPaciente = {};
        pagamentos.forEach(pag => {
            const pacienteId = pag.patient?._id?.toString() || 'sem-paciente';
            if (!porPaciente[pacienteId]) {
                porPaciente[pacienteId] = {
                    paciente: pag.patient?.fullName || 'N/A',
                    telefone: pag.patient?.phoneNumber,
                    totalPago: 0,
                    pagamentos: []
                };
            }
            porPaciente[pacienteId].totalPago += pag.amount || 0;
            porPaciente[pacienteId].pagamentos.push({
                data: pag.paymentDate,
                valor: pag.amount,
                forma: pag.paymentMethod,
                profissional: pag.doctor?.fullName
            });
        });

        // 2. Buscar pacotes fechados no período
        const pacotes = await Package.find({
            date: {
                $gte: new Date(start + 'T00:00:00.000Z'),
                $lte: new Date(end + 'T23:59:59.999Z')
            }
        })
            .populate('patient', 'fullName')
            .populate('doctor', 'fullName specialty')
            .lean();

        const pacotesDetalhados = pacotes.map(pkg => ({
            paciente: pkg.patient?.fullName || 'N/A',
            profissional: pkg.doctor?.fullName || 'N/A',
            especialidade: pkg.doctor?.specialty,
            sessoes: pkg.totalSessions,
            valorTotal: pkg.totalValue,
            valorPago: pkg.totalPaid,
            status: pkg.financialStatus,
            criadoEm: pkg.date
        }));

        // 3. Calcular totais gerais e separar por tipo (apenas receita efetivamente recebida)
        let totalRevenueParticular = 0;
        let totalRevenueConvenio = 0;

        pagamentos.forEach(pag => {
            const valor = pag.amount || 0;
            if (pag.billingType === 'convenio' || pag.paymentMethod === 'convenio' ||
                pag.insurance?.status === 'received') {
                totalRevenueConvenio += valor;
            } else {
                totalRevenueParticular += valor;
            }
        });

        const totalSessions = await Session.countDocuments({
            date: { $gte: start, $lte: end },
            status: 'completed'
        });

        // 3.1 Convênio a receber (informativo — não entra em totalRevenue)
        const pagamentosConvenioPendentes = await Payment.find({
            paymentDate: { $gte: start, $lte: end },
            billingType: 'convenio',
            'insurance.status': { $in: ['pending_billing', 'billed'] }
        }).lean();

        const totalConvenioAReceber = pagamentosConvenioPendentes.reduce(
            (sum, p) => sum + (p.insurance?.grossAmount || 0), 0
        );

        // "Realizado" = apenas caixa real recebido (Payment + sessões de pacote sem Payment)
        const totalRevenue = totalRevenueParticular + totalRevenueConvenio;

        // 4. Calcular gap (quanto falta) - baseado na receita total incluindo a receber
        const gapRevenue = Math.max(0, planning.targets.expectedRevenue - totalRevenue);
        const gapSessions = Math.max(0, planning.targets.totalSessions - totalSessions);

        // 5. Calcular dias restantes
        const today = new Date();
        const endDate = new Date(end);
        const daysRemaining = Math.max(0, Math.ceil((endDate - today) / (1000 * 60 * 60 * 24)));

        // 6. Calcular meta diária necessária
        const dailyRevenueNeeded = daysRemaining > 0 ? gapRevenue / daysRemaining : 0;
        const dailySessionsNeeded = daysRemaining > 0 ? gapSessions / daysRemaining : 0;

        return {
            actual: {
                actualRevenue: totalRevenue,
                actualRevenueParticular: totalRevenueParticular,
                actualRevenueConvenio: totalRevenueConvenio,
                actualRevenueConvenioAReceber: totalConvenioAReceber,
                completedSessions: totalSessions,
                workedHours: totalSessions * 0.67
            },
            details: {
                porPaciente: Object.values(porPaciente),
                pacotesFechados: pacotesDetalhados,
                totalPacientes: Object.keys(porPaciente).length,
                totalPacotes: pacotes.length,
                detalhamentoReceita: {
                    particular: {
                        valor: totalRevenueParticular,
                        percentual: totalRevenue > 0 ? Math.round((totalRevenueParticular / totalRevenue) * 100) : 0
                    },
                    convenio: {
                        valor: totalRevenueConvenio,
                        percentual: totalRevenue > 0 ? Math.round((totalRevenueConvenio / totalRevenue) * 100) : 0,
                        aReceber: totalConvenioAReceber
                    }
                }
            },
            progress: {
                sessionsPercentage: Math.round((totalSessions / planning.targets.totalSessions) * 100),
                revenuePercentage: Math.round((totalRevenue / planning.targets.expectedRevenue) * 100),
                gapRevenue: gapRevenue,
                gapSessions: gapSessions,
                overallStatus: totalRevenue >= planning.targets.expectedRevenue ? 'achieved' :
                    totalRevenue >= planning.targets.expectedRevenue * 0.8 ? 'on_track' :
                        totalRevenue >= planning.targets.expectedRevenue * 0.5 ? 'at_risk' : 'behind'
            },
            projections: {
                daysRemaining,
                dailyRevenueNeeded: Math.round(dailyRevenueNeeded),
                dailySessionsNeeded: Math.ceil(dailySessionsNeeded)
            }
        };

    } catch (error) {
        console.error('[Planning Service] ❌ Erro ao calcular progresso detalhado:', error);
        throw error;
    }
};

/**
 * 🎯 Calcula a projeção operacional REAL do mês
 * Baseado em appointments futuros já agendados (agenda real)
 * 
 * Pesos por status:
 *   - confirmed: 100%
 *   - scheduled: 90%
 *   - no_show: 60%
 *   - cancelled / force_cancelled: 0% (ignorados)
 */
export const calculateMonthlyProjection = async (month, year) => {
    try {
        const startStr = `${year}-${String(month).padStart(2, '0')}-01`;
        const lastDay = new Date(year, month, 0).getDate();
        const endStr = `${year}-${String(month).padStart(2, '0')}-${lastDay}`;

        const startDate = new Date(startStr + 'T00:00:00.000Z');
        const endDate = new Date(endStr + 'T23:59:59.999Z');

        // 📌 PAINEL COMERCIAL ESTRATÉGICO — MVP SIMPLES
        // Soma direta de appointments não cancelados.
        // Sem pesos de probabilidade. O foco é "quanto já temos na mão".
        const appointments = await Appointment.find({
            date: { $gte: startDate, $lte: endDate },
            operationalStatus: {
                $nin: ['canceled', 'force_cancelled']
            }
        }).select('date operationalStatus sessionValue billingType package patientType').lean();

        // Separar por fonte E por natureza estratégica
        let totalProjected = 0;
        let recurringRevenue = 0; // base previsível (pacotes + recorrentes)
        let newRevenue = 0;       // captação nova (avulsos + convênios)
        const composition = {
            pacotes: 0,
            convenios: 0,
            perSession: 0,
            recorrentes: 0
        };

        appointments.forEach(appt => {
            const value = appt.sessionValue || 0;
            totalProjected += value;

            // Classificar por fonte
            if (appt.package) {
                composition.pacotes += value;
                recurringRevenue += value; // pacote = compromisso de continuidade
            } else if (isInsuranceAppointment(appt)) {
                composition.convenios += value;
                newRevenue += value; // convênio = geralmente autorização nova
            } else if (appt.patientType === 'recorrente') {
                composition.recorrentes += value;
                recurringRevenue += value; // recorrente = base previsível
            } else {
                composition.perSession += value;
                newRevenue += value; // avulso não-recorrente = captação/esporádico
            }
        });

        // Arredondar
        totalProjected = Math.round(totalProjected);
        recurringRevenue = Math.round(recurringRevenue);
        newRevenue = Math.round(newRevenue);
        composition.pacotes = Math.round(composition.pacotes);
        composition.convenios = Math.round(composition.convenios);
        composition.perSession = Math.round(composition.perSession);
        composition.recorrentes = Math.round(composition.recorrentes);

        return {
            projectedRevenue: totalProjected,
            recurringRevenue,
            newRevenue,
            composition,
            totalAppointments: appointments.length,
            breakdownByStatus: appointments.reduce((acc, appt) => {
                const status = appt.operationalStatus;
                if (!acc[status]) acc[status] = { count: 0, projected: 0 };
                acc[status].count += 1;
                acc[status].projected += Math.round(appt.sessionValue || 0);
                return acc;
            }, {})
        };

    } catch (error) {
        console.error('[Planning Service] ❌ Erro ao calcular projeção mensal:', error);
        throw error;
    }
};

export default {
    updatePlanningProgress,
    updateAllPlanningsProgress,
    createWeeklyPlanning,
    createMonthlyPlanning,
    calculateDetailedProgress,
    calculateMonthlyProjection
};
