import Appointment from '../models/Appointment.js';
import Patient from '../models/Patient.js';

/**
 * 📊 Analytics de Agendamentos - Novos vs Recorrentes
 * Endpoint específico para marketing/lançamentos
 */

/**
 * GET /analytics/appointments/by-type
 * 
 * Retorna agendamentos separados por:
 * - novos (primeiro agendamento do paciente)
 * - recorrentes (já tem agendamentos anteriores)
 * 
 * Query params:
 * - date: data específica (YYYY-MM-DD) - padrão: hoje
 * - startDate, endDate: período
 * - doctorId: filtrar por médico
 */
export const getAppointmentsByType = async (req, res) => {
    try {
        const { date, startDate, endDate, doctorId } = req.query;

        // Definir período
        let dateFilter = {};
        
        if (date) {
            // Data específica
            const targetDate = new Date(date);
            const nextDay = new Date(targetDate);
            nextDay.setDate(nextDay.getDate() + 1);
            
            dateFilter = {
                createdAt: {
                    $gte: targetDate,
                    $lt: nextDay
                }
            };
        } else if (startDate && endDate) {
            // Período
            dateFilter = {
                createdAt: {
                    $gte: new Date(startDate),
                    $lte: new Date(endDate + 'T23:59:59.999Z')
                }
            };
        } else {
            // Padrão: hoje
            const today = new Date();
            today.setHours(0, 0, 0, 0);
            const tomorrow = new Date(today);
            tomorrow.setDate(tomorrow.getDate() + 1);
            
            dateFilter = {
                createdAt: {
                    $gte: today,
                    $lt: tomorrow
                }
            };
        }

        // Filtro de médico (opcional)
        if (doctorId) {
            dateFilter.doctor = doctorId;
        }

        // 🚀 Buscar todos os agendamentos do período
        const appointments = await Appointment.find(dateFilter)
            .populate('patient', 'name phone')
            .populate('doctor', 'fullName')
            .lean();

        // 🧠 Analisar cada agendamento: é novo ou recorrente?
        const patientIds = [...new Set(appointments.map(a => a.patient?._id?.toString()))];
        
        // Buscar histórico de agendamentos desses pacientes
        const patientHistories = await Appointment.aggregate([
            {
                $match: {
                    patient: { $in: patientIds.map(id => new mongoose.Types.ObjectId(id)) }
                }
            },
            {
                $group: {
                    _id: '$patient',
                    totalAppointments: { $sum: 1 },
                    firstAppointmentDate: { $min: '$createdAt' }
                }
            }
        ]);

        // Criar mapa de histórico
        const historyMap = patientHistories.reduce((acc, h) => {
            acc[h._id.toString()] = {
                total: h.totalAppointments,
                firstDate: h.firstAppointmentDate
            };
            return acc;
        }, {});

        // Separar novos vs recorrentes
        const novos = [];
        const recorrentes = [];

        appointments.forEach(apt => {
            const patientId = apt.patient?._id?.toString();
            const history = historyMap[patientId];
            
            // É NOVO se:
            // - Total de agendamentos do paciente = 1 (só tem esse)
            // - E a data do primeiro agendamento é igual a este
            const isNovo = history && 
                          history.total === 1 && 
                          history.firstDate.toISOString() === apt.createdAt.toISOString();

            const formatted = {
                _id: apt._id,
                patient: apt.patient,
                doctor: apt.doctor,
                date: apt.date,
                time: apt.time,
                specialty: apt.specialty,
                serviceType: apt.serviceType,
                createdAt: apt.createdAt,
                status: apt.operationalStatus,
                totalDoPaciente: history?.total || 1
            };

            if (isNovo) {
                novos.push(formatted);
            } else {
                recorrentes.push(formatted);
            }
        });

        // Calcular totais
        const totalNovos = novos.length;
        const totalRecorrentes = recorrentes.length;
        const totalGeral = appointments.length;

        res.json({
            success: true,
            period: {
                date: date || new Date().toISOString().split('T')[0],
                startDate: startDate || null,
                endDate: endDate || null
            },
            summary: {
                total: totalGeral,
                novos: {
                    count: totalNovos,
                    percentage: totalGeral > 0 ? Math.round((totalNovos / totalGeral) * 100) : 0
                },
                recorrentes: {
                    count: totalRecorrentes,
                    percentage: totalGeral > 0 ? Math.round((totalRecorrentes / totalGeral) * 100) : 0
                }
            },
            details: {
                novos,
                recorrentes
            }
        });

    } catch (error) {
        console.error('❌ Erro em getAppointmentsByType:', error);
        res.status(500).json({
            success: false,
            message: 'Erro ao analisar agendamentos',
            error: error.message
        });
    }
};

/**
 * GET /analytics/appointments/conversion-timeline
 * 
 * Timeline de conversão: quando leads viraram pacientes (primeiro agendamento)
 * Útil para ver efetividade de campanhas
 */
export const getConversionTimeline = async (req, res) => {
    try {
        const { days = 30 } = req.query;
        
        const startDate = new Date();
        startDate.setDate(startDate.getDate() - parseInt(days));

        // Buscar primeiros agendamentos no período
        const firstAppointments = await Appointment.aggregate([
            // Agrupa por paciente e pega o primeiro
            {
                $group: {
                    _id: '$patient',
                    firstAppointment: { $min: '$createdAt' },
                    appointmentData: { $first: '$$ROOT' }
                }
            },
            // Filtra só os que converteram no período
            {
                $match: {
                    firstAppointment: { $gte: startDate }
                }
            },
            // Ordena por data
            {
                $sort: { firstAppointment: 1 }
            },
            // Popula dados do paciente
            {
                $lookup: {
                    from: 'patients',
                    localField: '_id',
                    foreignField: '_id',
                    as: 'patient'
                }
            },
            { $unwind: '$patient' }
        ]);

        // Agrupa por dia
        const byDay = firstAppointments.reduce((acc, item) => {
            const dateKey = item.firstAppointment.toISOString().split('T')[0];
            if (!acc[dateKey]) {
                acc[dateKey] = { count: 0, patients: [] };
            }
            acc[dateKey].count++;
            acc[dateKey].patients.push({
                name: item.patient.name,
                phone: item.patient.phone,
                date: item.firstAppointment
            });
            return acc;
        }, {});

        res.json({
            success: true,
            period: `${days} dias`,
            totalConversions: firstAppointments.length,
            dailyBreakdown: byDay
        });

    } catch (error) {
        console.error('❌ Erro em getConversionTimeline:', error);
        res.status(500).json({
            success: false,
            message: 'Erro ao buscar timeline de conversão',
            error: error.message
        });
    }
};

import mongoose from 'mongoose';
