import moment from 'moment';
import mongoose from 'mongoose';
import Appointment from '../models/Appointment.js';
import MedicalEvent from '../models/MedicalEvent.js';
import Package from '../models/Package.js';
import Patient from '../models/Patient.js';
import Payment from '../models/Payment.js';
import Session from '../models/Session.js';
import InsuranceGuide from '../models/InsuranceGuide.js';
import { distributePayments } from '../services/distributePayments.js';
import { getHolidaysWithNames } from '../config/feriadosBR-dynamic.js';

import { syncEvent } from '../services/syncService.js';
import { runJourneyFollowups } from '../services/journeyFollowupEngine.js';
import Leads from '../models/Leads.js';

/**
 * 🏥 Cria recebível de convênio quando sessão é completada
 * @param {Object} session - Sessão completada
 * @param {Object} pkg - Pacote da sessão
 * @param {Object} mongoSession - Sessão do MongoDB para transação
 */
async function criarRecebivelConvenio(session, pkg, mongoSession) {
    try {
        // Verificar se é pacote de convênio
        if (pkg.type !== 'convenio' && session.paymentMethod !== 'convenio') {
            return null; // Não é convênio, não cria recebível
        }

        // Verificar se já existe recebível para esta sessão
        const existingPayment = await Payment.findOne({
            session: session._id,
            billingType: 'convenio'
        }).session(mongoSession);

        if (existingPayment) {
            console.log(`⚠️ Recebível de convênio já existe para sessão ${session._id}`);
            return existingPayment;
        }

        // Buscar guia de convênio
        const guide = pkg.insuranceGuide 
            ? await InsuranceGuide.findById(pkg.insuranceGuide).session(mongoSession)
            : null;

        // Valor da tabela do convênio
        const valorTabela = pkg.sessionValue || 80;
        const convenio = pkg.insuranceProvider || guide?.insurance || 'Convênio';

        // Criar pagamento de convênio
        const recebivel = await Payment.create([{
            patient: session.patient,
            doctor: session.doctor,
            session: session._id,
            package: pkg._id,
            serviceType: 'package_session',
            amount: 0, // Zerado - só entra no caixa quando receber
            paymentMethod: 'convenio',
            billingType: 'convenio',
            status: 'pending',
            paymentDate: session.date,
            notes: `Atendimento ${convenio} - ${pkg.sessionType || pkg.specialty}`,
            insurance: {
                provider: convenio,
                grossAmount: valorTabela,
                authorizationCode: guide?.number || pkg.insuranceAuthorization || null,
                status: 'pending_billing', // Aguardando faturamento
                expectedReceiptDate: moment(session.date).add(1, 'month').endOf('month').toDate()
            }
        }], { session: mongoSession });

        console.log(`✅ Recebível de convênio criado: ${recebivel[0]._id} - ${convenio} - R$ ${valorTabela}`);
        
        return recebivel[0];
    } catch (error) {
        console.error('❌ Erro ao criar recebível de convênio:', error);
        throw error;
    }
}

const APPOINTMENTS_API_BASE_URL = 'http://167.234.249.6:5000/api';
const validateInputs = {
    sessionType: (type) => ['fonoaudiologia', 'terapia_ocupacional', 'psicologia', 'fisioterapia', 'psicomotricidade', 'musicoterapia', 'psicopedagogia'].includes(type),
    paymentMethod: (method) => ['dinheiro', 'pix', 'cartão'].includes(method),
    paymentType: (type) => ['full', 'per-session', 'partial'].includes(type)
};

/**
 * 🗓️ Ajusta data se cair em feriado - pula para próxima semana
 * @param {string} dateStr - Data no formato YYYY-MM-DD
 * @param {string} timeStr - Hora no formato HH:mm
 * @returns {string} - Data ajustada (YYYY-MM-DD)
 */
function adjustDateIfHoliday(dateStr, timeStr) {
    const year = parseInt(dateStr.split('-')[0], 10);
    const holidays = getHolidaysWithNames(year);
    const holidayDates = new Set(holidays.map(h => h.date));
    
    let currentDate = moment(dateStr, 'YYYY-MM-DD');
    let currentDateStr = dateStr;
    let iterations = 0;
    const maxIterations = 52; // Máximo 52 semanas (1 ano)
    
    while (holidayDates.has(currentDateStr) && iterations < maxIterations) {
        // Verifica se é feriado parcial (Quarta-feira de Cinzas)
        const holiday = holidays.find(h => h.date === currentDateStr);
        const isAshWednesday = holiday?.name === 'Quarta-feira de Cinzas';
        
        if (isAshWednesday) {
            // Quarta-feira de Cinzas: bloqueia apenas manhã (antes das 12h)
            const hour = parseInt(timeStr?.split(':')[0] || '0', 10);
            if (hour >= 12) {
                // Tarde está liberada, não precisa pular
                break;
            }
            // Manhã bloqueada, vai para próxima semana
        }
        
        // Pula para próxima semana (mesmo dia da semana)
        currentDate.add(7, 'days');
        currentDateStr = currentDate.format('YYYY-MM-DD');
        
        // Atualiza feriados se mudou de ano
        const newYear = currentDate.year();
        if (newYear !== year) {
            const newHolidays = getHolidaysWithNames(newYear);
            holidayDates.clear();
            newHolidays.forEach(h => holidayDates.add(h.date));
        }
        
        iterations++;
    }
    
    if (iterations >= maxIterations) {
        console.warn(`⚠️ Não foi possível encontrar data válida após ${maxIterations} semanas para ${dateStr}`);
    }
    
    return currentDateStr;
}

// Operações CRUD Completas
export const packageOperations = {
    create: async (req, res) => {
        const mongoSession = await mongoose.startSession();
        let transactionCommitted = false;

        try {
            await mongoSession.startTransaction();

            const {
                date,
                patientId,
                doctorId,
                specialty,
                paymentMethod,
                paymentType,
                durationMonths,
                sessionsPerWeek,
                sessionType,
                appointmentId,
                sessionValue,
                calculationMode,
                totalSessions,
                selectedSlots = [], // 💡 novo campo
                payments = [],
                // ⚖️ Campos específicos para liminar
                type = 'therapy',
                liminarProcessNumber,
                liminarCourt,
                liminarExpirationDate,
                liminarMode = 'hybrid',
                liminarAuthorized = true
            } = req.body;

            if (date === 'Invalid date' || !moment(date, 'YYYY-MM-DD', true).isValid()) {
                throw new Error('Data inválida');
            }
            const paymentDate = req.body.paymentDate
                ? req.body.paymentDate
                : new Date().toISOString().split('T')[0];

            // ==========================================================
            // 1️⃣ VALIDAÇÕES BÁSICAS
            // ==========================================================
            if (!date || !patientId || !doctorId || !sessionType || !specialty || !sessionValue) {
                throw new Error('Campos obrigatórios não fornecidos');
            }
            if (!selectedSlots.length) {
                throw new Error('Nenhum horário selecionado (selectedSlots está vazio)');
            }

            // ⚖️ Log para pacotes liminar (campos opcionais)
            if (type === 'liminar') {
                console.log('⚖️ Criando pacote LIMINAR:', {
                    processo: liminarProcessNumber || 'Não informado',
                    vara: liminarCourt || 'Não informada',
                    modo: liminarMode
                });
            }

            // ==========================================================
            // 2️⃣ CONVERSÃO / REAPROVEITAMENTO DO PRIMEIRO SLOT EXISTENTE
            //     - Funciona com appointmentId explícito OU detecta automaticamente
            //       pelo primeiro selectedSlot (data/hora).
            // ==========================================================
            let existingAppointment = null;
            let replacedAppointmentId = null;
            let replacedSessionId = null;

            // 2.1) Caso explícito: veio appointmentId no body
            // 🚀 OTIMIZAÇÃO: Buscar FORA da transação (sem lock)
            if (appointmentId) {
                existingAppointment = await Appointment.findById(appointmentId)
                    .populate('session')
                    .lean();

                if (!existingAppointment) {
                    throw new Error('Agendamento a ser convertido não encontrado');
                }

                // 🚫 TRAVA: esse agendamento já está em um pacote?
                if (existingAppointment.package || existingAppointment.session?.package) {
                    const err = new Error(
                        'Este agendamento já está vinculado a um pacote e não pode ser usado para criar outro.'
                    );
                    err.code = 'APPOINTMENT_IN_OTHER_PACKAGE';
                    err.packageId = existingAppointment.package || existingAppointment.session?.package;
                    throw err;
                }

                // Extrair IDs para usar na transação
                const sessionIdToDelete = existingAppointment.session?._id;
                replacedSessionId = sessionIdToDelete?.toString();
                replacedAppointmentId = appointmentId;

                // 🚀 Transação mínima: só os deletes
                await Appointment.deleteOne({ _id: appointmentId }).session(mongoSession);
                if (sessionIdToDelete) {
                    await Session.deleteOne({ _id: sessionIdToDelete }).session(mongoSession);
                }
            }

            // 2.2) Caso implícito: NÃO veio appointmentId → detectar pelo primeiro slot
            // 🚀 OTIMIZAÇÃO: Buscar FORA da transação (sem lock)
            if (!existingAppointment && selectedSlots?.length > 0) {
                const firstSlot = selectedSlots[0];
                if (firstSlot?.date && firstSlot?.time) {
                    const toConvert = await Appointment.findOne({
                        patient: patientId,
                        doctor: doctorId,
                        date: firstSlot.date,
                        time: firstSlot.time,
                        status: { $ne: 'canceled' }
                    })
                        .populate('session')
                        .lean();

                    if (toConvert) {
                        // 🚫 TRAVA: já é de pacote?
                        if (toConvert.package || toConvert.session?.package) {
                            const err = new Error(
                                'Este agendamento já está vinculado a um pacote e não pode ser usado para criar outro.'
                            );
                            err.code = 'APPOINTMENT_IN_OTHER_PACKAGE';
                            err.packageId = toConvert.package || toConvert.session?.package;
                            throw err;
                        }

                        // Extrair IDs para transação
                        const sessionIdToDelete = toConvert.session?._id;
                        replacedSessionId = sessionIdToDelete?.toString();
                        replacedAppointmentId = toConvert._id.toString();

                        // 🚀 Transação mínima: só os deletes
                        await Appointment.deleteOne({ _id: toConvert._id }).session(mongoSession);
                        if (sessionIdToDelete) {
                            await Session.deleteOne({ _id: sessionIdToDelete }).session(mongoSession);
                        }
                    }
                }
            }

            // ==========================================================
            // 3️⃣ CÁLCULO DE SESSÕES E VALORES
            // ==========================================================
            const numericSessionValue = Number(sessionValue) || 0;
            const numericSessionsPerWeek = Number(sessionsPerWeek) || selectedSlots.length;
            const numericDurationMonths = Number(durationMonths) || 0;
            const numericTotalSessions = Number(totalSessions) || 0;

            let finalTotalSessions, finalDurationMonths;
            if (calculationMode === 'sessions') {
                finalTotalSessions = numericTotalSessions;
                finalDurationMonths = Math.ceil(finalTotalSessions / ((numericSessionsPerWeek * 4) || 1));
            } else {
                finalTotalSessions = numericDurationMonths * 4 * numericSessionsPerWeek;
                finalDurationMonths = numericDurationMonths;
            }

            const totalValue = numericSessionValue * finalTotalSessions;

            // ==========================================================
            // 4️⃣ CRIAR O PACOTE
            // ==========================================================
            const packageData = {
                patient: patientId,
                doctor: doctorId,
                date,
                sessionType,
                specialty,
                sessionValue: numericSessionValue,
                totalSessions: finalTotalSessions,
                sessionsPerWeek: numericSessionsPerWeek,
                durationMonths: finalDurationMonths,
                paymentMethod,
                paymentType,
                totalValue,
                totalPaid: 0,
                balance: totalValue,
                status: 'active',
                calculationMode,
                type
            };

            // ⚖️ Adicionar campos específicos do liminar
            if (type === 'liminar') {
                packageData.liminarProcessNumber = liminarProcessNumber;
                packageData.liminarCourt = liminarCourt;
                packageData.liminarExpirationDate = liminarExpirationDate || null;
                packageData.liminarMode = liminarMode;
                packageData.liminarAuthorized = liminarAuthorized;
                packageData.liminarTotalCredit = totalValue;
                packageData.liminarCreditBalance = totalValue;
                packageData.recognizedRevenue = 0;
                // Para liminar, o financialStatus inicia como 'unpaid' até reconhecer a receita
                packageData.financialStatus = 'unpaid';
            }

            const newPackage = new Package(packageData);

            await newPackage.save({ session: mongoSession });
            // 🔧 Reconciliação mínima de pagamentos herdados da sessão/appointment avulso
            if (replacedSessionId) {
                // 2.1) Deleta pendentes/abertos da sessão avulsa (evita o “extra”)
                await Payment.deleteMany(
                    {
                        session: replacedSessionId,
                        status: { $in: ['pending', 'unpaid'] },
                        serviceType: { $in: ['individual_session', 'evaluation'] }
                    },
                    { session: mongoSession }
                );

                // 2.2) Converte pagos da sessão avulsa em recibo do pacote (preserva histórico financeiro)
                await Payment.updateMany(
                    {
                        session: replacedSessionId,
                        status: 'paid',
                        serviceType: { $in: ['individual_session', 'evaluation'] }
                    },
                    {
                        $set: {
                            package: newPackage._id,
                            kind: 'package_receipt',
                            serviceType: 'package_session',
                            migratedFrom: { session: replacedSessionId }
                        },
                        $unset: { session: "", appointment: "" }
                    },
                    { session: mongoSession }
                );
            }

            // (opcional) reforço por appointment também:
            if (replacedAppointmentId) {
                await Payment.updateMany(
                    {
                        appointment: replacedAppointmentId,
                        status: { $in: ['pending', 'unpaid'] },
                        serviceType: { $in: ['individual_session', 'evaluation'] }
                    },
                    { $unset: { appointment: "" } },
                    { session: mongoSession }
                );

                await Payment.updateMany(
                    {
                        appointment: replacedAppointmentId,
                        status: 'paid',
                        serviceType: { $in: ['individual_session', 'evaluation'] }
                    },
                    {
                        $set: {
                            package: newPackage._id,
                            kind: 'package_receipt',
                            serviceType: 'package_session',
                            migratedFrom: { appointment: replacedAppointmentId }
                        },
                        $unset: { appointment: "" }
                    },
                    { session: mongoSession }
                );
            }


            await Patient.findByIdAndUpdate(patientId, { $addToSet: { packages: newPackage._id } }, { session: mongoSession });

            // ==========================================================
            // 5️⃣ GERAR SESSÕES E AGENDAMENTOS (com base em selectedSlots)
            // ==========================================================
            const sessionsToCreate = [];
            const appointmentsToCreate = [];

            for (const slot of selectedSlots) {
                if (!slot.date || !slot.time) continue;

                // 🗓️ Ajusta data se cair em feriado (pula para próxima semana)
                const adjustedDate = adjustDateIfHoliday(slot.date, slot.time);
                
                if (adjustedDate !== slot.date) {
                    console.log(`🗓️ Feriado detectado! Ajustando ${slot.date} → ${adjustedDate} (${slot.time})`);
                }

                sessionsToCreate.push({
                    date: adjustedDate,
                    time: slot.time,
                    patient: patientId,
                    doctor: doctorId,
                    package: newPackage._id,
                    sessionValue: numericSessionValue,
                    sessionType,
                    specialty,
                    status: 'scheduled',
                    isPaid: false,
                    paymentStatus: 'pending',
                    visualFlag: 'pending',
                    paymentMethod
                });
            }

/* 

            // ==========================================================
            // 🚫 5.1️⃣ VALIDAÇÃO DE CONFLITOS COM SESSÕES EXISTENTES
            // ==========================================================
            for (const s of sessionsToCreate) {
                const conflict = await Session.findOne({
                    date: s.date,
                    time: s.time,
                    doctor: s.doctor,
                    patient: s.patient,
                    specialty: s.specialty,
                    status: { $ne: 'canceled' } // ignora canceladas
                }).lean();

                if (conflict) {
                    throw new Error(
                        `Conflito detectado: o paciente já possui uma sessão de ${s.specialty} com este profissional ` +
                        `no dia ${moment(s.date).format('DD/MM/YYYY')} às ${s.time}.`
                    );
                }
            } */


            const insertedSessions = await Session.insertMany(sessionsToCreate, { session: mongoSession });

            // 🔥 CALCULA SE É PRIMEIRO AGENDAMENTO DO PACIENTE (para todos do pacote)
            const existingAppointments = await Appointment.countDocuments({ 
                patient: patientId 
            }).session(mongoSession);
            const isFirstAppointment = existingAppointments === 0;
            console.log(`[CREATE PACKAGE] isFirstAppointment para paciente ${patientId}:`, isFirstAppointment);

            for (const s of insertedSessions) {
                appointmentsToCreate.push({
                    patient: patientId,
                    doctor: doctorId,
                    date: s.date,
                    time: s.time,
                    duration: 40,
                    specialty,
                    session: s._id,
                    package: newPackage._id,
                    serviceType: 'package_session',
                    operationalStatus: 'scheduled',
                    clinicalStatus: 'pending',
                    paymentStatus: 'pending',
                    sessionValue: numericSessionValue,  // ⭐ VALOR PARA PROJEÇÃO FINANCEIRA
                    // 🔥 NOVO: Primeiro agendamento do paciente?
                    isFirstAppointment: isFirstAppointment
                });
            }

            // 1 appointment por session, sempre — sem dedup por data (cada session._id é único)
            const insertedAppointments = await Appointment.insertMany(appointmentsToCreate, { session: mongoSession });

            // 🔗 Vincula sessions→appointments pelo session._id (robusto, sem risco de colisão por data)
            const appointmentMap = new Map(
                insertedAppointments.map(a => [a.session.toString(), a._id])
            );
            console.log('Sessions:', insertedSessions.length, 'Appointments:', insertedAppointments.length);

            // 🗓️ Log de ajustes por feriado
            const adjustedDates = sessionsToCreate.filter((s, i) => s.date !== selectedSlots[i]?.date);
            if (adjustedDates.length > 0) {
                console.log(`🗓️ ${adjustedDates.length} sessão(ões) ajustada(s) por feriado:`);
                adjustedDates.forEach(s => {
                    const original = selectedSlots.find(sl => sl.time === s.time);
                    console.log(`   ${original?.date} → ${s.date} (${s.time})`);
                });
            }

            await Session.bulkWrite(
                insertedSessions.map(s => {
                    const appId = appointmentMap.get(s._id.toString());

                    if (!appId) {
                        console.warn(`⚠️ Sessão ${s._id} (${s.date} ${s.time}) sem appointment correspondente — verifique o insert.`);
                        return { updateOne: { filter: { _id: s._id }, update: {} } }; // noop
                    }

                    return {
                        updateOne: {
                            filter: { _id: s._id },
                            update: { $set: { appointmentId: appId } }
                        }
                    };
                }),
                { session: mongoSession }
            );


            // ==========================================================
            // 6️⃣ PAGAMENTOS
            // ==========================================================
            let amountPaid = 0;
            const paymentDocs = [];

            // 🔥 SE for per-session, ignora pagamentos antecipados (paga no dia)
            if (paymentType === 'per-session') {
                console.log(`[CREATE PACKAGE] Modo per-session: ignorando ${payments.length} pagamentos do body`);
                // Não cria nenhum pagamento agora - será criado quando concluir sessão
            } else {
                // Cria pagamentos normalmente (full ou partial)
                for (const p of payments) {
                    const value = Number(p.amount) || 0;
                    if (value <= 0) continue;

                    const paymentDoc = new Payment({
                        package: newPackage._id,
                        patient: patientId,
                        doctor: doctorId,
                        amount: value,
                        paymentMethod: p.method,
                        paymentDate: p.date || new Date(),
                        kind: 'package_receipt',
                        status: 'paid',
                        serviceType: 'package_session',
                        notes: p.description || 'Pagamento do pacote'
                    });

                    await paymentDoc.save({ session: mongoSession });
                    paymentDocs.push(paymentDoc);
                    newPackage.payments.push(paymentDoc._id);
                    newPackage.totalPaid += value;
                    amountPaid += value;
                }
            }

            // 🧩 Sanitização garantida antes do cálculo
            if (isNaN(newPackage.totalValue) || newPackage.totalValue === undefined || newPackage.totalValue === null) {
                newPackage.totalValue = 0;
            }
            if (isNaN(newPackage.totalPaid) || newPackage.totalPaid === undefined || newPackage.totalPaid === null) {
                newPackage.totalPaid = 0;
            }

            newPackage.balance = newPackage.totalValue - newPackage.totalPaid;
            newPackage.financialStatus =
                newPackage.balance <= 0 ? 'paid' :
                    newPackage.totalPaid > 0 ? 'partially_paid' : 'unpaid';

            // 🔢 Soma dos pagos migrados (sessão/appointment avulsos convertidos)
            const migratedPaid = await Payment.aggregate([
                {
                    $match: {
                        package: newPackage._id,
                        status: 'paid',
                        kind: 'package_receipt',
                        serviceType: 'package_session',
                        migratedFrom: { $exists: true }            // ⬅️ só os que acabamos de migrar
                    }
                },
                { $group: { _id: null, total: { $sum: '$amount' } } }
            ]).session(mongoSession);

            const migratedTotal = migratedPaid?.[0]?.total || 0;

            // Atualiza o array de payments do pacote (IDs migrados)
            const migratedIds = await Payment.find({
                package: newPackage._id,
                status: 'paid',
                kind: 'package_receipt',
                serviceType: 'package_session',
                migratedFrom: { $exists: true }
            }, { _id: 1 }).session(mongoSession);

            if (migratedIds.length) {
                await Package.updateOne(
                    { _id: newPackage._id },
                    { $addToSet: { payments: { $each: migratedIds.map(p => p._id) } } },
                    { session: mongoSession }
                );
            }

            // Agora some no totalPaid do pacote ANTES da finalização
            newPackage.totalPaid = (newPackage.totalPaid || 0) + migratedTotal;
            newPackage.balance = (newPackage.totalValue || 0) - (newPackage.totalPaid || 0);
            newPackage.financialStatus =
                newPackage.balance <= 0 ? 'paid' :
                    newPackage.totalPaid > 0 ? 'partially_paid' : 'unpaid';
            await newPackage.save({ session: mongoSession });

            await newPackage.save({ session: mongoSession });

            // ==========================================================
            // 7️⃣ FINALIZAÇÃO
            // ==========================================================
            await mongoSession.commitTransaction();
            transactionCommitted = true;

            // 🔹 Atualiza o pacote com todas as referências
            await Package.findByIdAndUpdate(newPackage._id, {
                $set: {
                    sessions: insertedSessions.map(s => s._id),
                    appointments: insertedAppointments.map(a => a._id),
                },
            });

            // 🔹 Recarrega o pacote completo para garantir consistência
            const freshPackage = await Package.findById(newPackage._id)
                .populate('sessions appointments payments')
                .lean();

            await syncEvent(freshPackage, 'package');

            // 🕐 Aguarda propagação de visibilidade do Mongo (garante que inserts estejam visíveis)
            await new Promise(resolve => setTimeout(resolve, 250));

            // 🔁 Recarrega o pacote direto do banco, sem cache e com todas as sessões visíveis
            const reloadedPackage = await Package.findById(newPackage._id)
                .lean();

            // 💸 Distribui também o valor migrado (pagos convertidos do avulso → pacote)
            // 🔥 SÓ distribui se NÃO for pagamento por sessão (per_session)
            if (migratedTotal > 0 && paymentType !== 'per-session') {
                try {
                    await distributePayments(reloadedPackage._id, migratedTotal, null, null);
                } catch (e) {
                    console.error(`⚠️ Erro ao distribuir valor migrado:`, e.message);
                }
            }


            // 💰 Distribui pagamentos após garantir consistência total
            // 🔥 SÓ distribui se NÃO for pagamento por sessão (per_session)
            if (paymentType !== 'per-session') {
                for (const p of paymentDocs) {
                    try {
                        await distributePayments(reloadedPackage._id, p.amount, null, p._id);
                    } catch (e) {
                        console.error(`⚠️ Erro ao distribuir pagamento ${p._id}:`, e.message);
                    }
                }
            } else {
                console.log(`[CREATE PACKAGE] Modo 'per-session' - distribuição de pagamentos ignorada`);
            }


            // 🔹 Retorna pacote atualizado
            const result = await Package.findById(reloadedPackage._id)
                .populate('sessions appointments payments')
                .lean();

            // 🔹 Busca o paciente para obter o leadId (se existir)
            const patient = await Patient.findById(patientId).lean();
            const leadId = patient?.lead;
            
            if (leadId) {
                await Leads.findByIdAndUpdate(leadId, {
                    patientJourneyStage: "renovacao"
                });

                runJourneyFollowups(leadId, {
                    patientName: patient.name
                });
            }

            res.status(201).json({
                success: true,
                data: result,
                replacedAppointment: appointmentId || null,
            });
        } catch (error) {
            if (mongoSession?.inTransaction() && !transactionCommitted) {
                await mongoSession.abortTransaction();
            }

            if (error.code === 'APPOINTMENT_IN_OTHER_PACKAGE') {
                return res.status(400).json({
                    success: false,
                    message: error.message,
                    errorCode: 'APPOINTMENT_IN_OTHER_PACKAGE',
                    packageId: error.packageId || null
                });
            }

            if (error.message.includes('Conflito detectado')) {
                return res.status(409).json({
                    success: false,
                    message: error.message,
                    errorCode: 'SESSION_CONFLICT'
                });
            }

            if (error.code === 11000 && error.message.includes('unique_appointment')) {
                const dateMatch = error.message.match(/date:\s+"([^"]+)"/);
                const timeMatch = error.message.match(/time:\s+"([^"]+)"/);

                const date = dateMatch ? dateMatch[1] : 'data desconhecida';
                const time = timeMatch ? timeMatch[1] : 'horário desconhecido';

                // 👉 Envia HTML direto
                const detailedMessage = `Já existe um agendamento para este paciente no dia ${date} às ${time}.`;

                return res.status(400).json({
                    success: false,
                    message: detailedMessage,
                    errorCode: 'DUPLICATE_APPOINTMENT'
                });
            }

            console.error('❌ Erro ao criar agendamento/pacote:', error);

            return res.status(500).json({
                success: false,
                message: 'Erro ao criar agendamento ou pacote. Tente novamente.',
                errorCode: 'PACKAGE_CREATION_ERROR'
            });
        } finally {
            await mongoSession.endSession();
        }
    },

    get: {
        all: async (req, res) => {
            try {
                const { patientId } = req.query;

                if (!patientId) {
                    return res.status(400).json({ message: 'ID do paciente é obrigatório.' });
                }

                const packages = await Package.find({ patient: patientId })
                    .populate({
                        path: 'sessions',
                    })
                    .populate({
                        path: 'payments',
                    })
                    .populate('patient')
                    .populate({
                        path: 'doctor',
                        model: 'Doctor',
                        select: '_id fullName specialty',
                    })
                    .lean();

                const enhancedPackages = packages.map(pkg => {
                    return {
                        ...pkg,
                        date: pkg.date,
                        time: pkg.time,
                        sessions: pkg.sessions?.map(session => ({
                            ...session,
                            // Mantém as datas originais das sessões
                            date: session.date, // "YYYY-MM-DD"
                            time: session.time, // "HH:mm"
                        })) || [],
                        remaining: pkg.totalSessions - pkg.sessionsDone,
                        totalValue: pkg.totalValue,
                    };
                });

                res.status(200).json(enhancedPackages);
            } catch (error) {
                if (error.name === 'ValidationError') {
                    const errors = Object.keys(error.errors).reduce((acc, key) => {
                        acc[key] = error.errors[key].message;
                        return acc;
                    }, {});

                    return res.status(400).json({
                        message: 'Falha na validação dos dados',
                        errors
                    });
                }

                console.error('Erro ao buscar pacotes:', error);
                return res.status(500).json({
                    error: 'Erro interno no servidor',
                    details: error.message
                });
            }
        },
        byId: async (req, res) => {
            try {
                const pkg = await Package.findById(req.params.id)
                    .populate('patient', 'name');
                if (!pkg) return res.status(404).json({ error: 'Pacote não encontrado' });
                res.json(pkg);
            } catch (error) {
                if (error.name === 'ValidationError') {
                    // 💡 Extrai erros campo a campo
                    const errors = Object.keys(error.errors).reduce((acc, key) => {
                        acc[key] = error.errors[key].message;
                        return acc;
                    }, {});

                    return res.status(400).json({
                        message: 'Falha na validação dos dados',
                        errors
                    });
                }

                return res.status(500).json({ error: 'Erro interno' });
            }
        },
        search: async (req, res) => {
            try {
                const { status, type, startDate, endDate } = req.query;
                const filters = {};

                if (status) filters.status = status;
                if (type) filters.type = type;
                if (startDate && endDate) {
                    filters.createdAt = {
                        $gte: new Date(startDate),
                        $lte: new Date(endDate)
                    };
                }

                const packages = await Package.find(filters)
                    .populate('sessions payments')
                    .lean();

                res.status(200).json(packages);
            } catch (error) {
                if (error.name === 'ValidationError') {
                    // 💡 Extrai erros campo a campo
                    const errors = Object.keys(error.errors).reduce((acc, key) => {
                        acc[key] = error.errors[key].message;
                        return acc;
                    }, {});

                    return res.status(400).json({
                        message: 'Falha na validação dos dados',
                        errors
                    });
                }

                return res.status(500).json({ error: 'Erro interno' });
            }
        },
    },

    // Atualizar
    update: {
        package: async (req, res) => {
            try {
                const { version } = req.body;
                const packageId = req.params.id;

                // Verificar conflito de versão
                const currentPackage = await Package.findById(packageId);
                if (currentPackage.version !== version) {
                    return res.status(409).json({
                        error: 'Conflito de versão',
                        message: 'O pacote foi modificado por outro usuário. Por favor, recarregue os dados.'
                    });
                }

                // Atualizar com incremento de versão
                const updated = await Package.findByIdAndUpdate(
                    packageId,
                    { ...req.body, $inc: { version: 1 } },
                    { new: true, runValidators: true }
                );

                res.json(updated);
            } catch (error) {
                if (error.name === 'ValidationError') {
                    // 💡 Extrai erros campo a campo
                    const errors = Object.keys(error.errors).reduce((acc, key) => {
                        acc[key] = error.errors[key].message;
                        return acc;
                    }, {});

                    return res.status(400).json({
                        message: 'Falha na validação dos dados',
                        errors
                    });
                }

                return res.status(500).json({ error: 'Erro interno' });
            }
        },
        session: async (req, res) => {
            const mongoSession = await mongoose.startSession();
            let transactionCommitted = false;

            try {
                await mongoSession.startTransaction();

                const { sessionId } = req.params;
                const {
                    date,
                    time,
                    notes,
                    doctorId,
                    patientId,
                    status,
                    confirmedAbsence,
                    payment = {},
                    sessionType,
                    serviceType,
                    specialty
                } = req.body;

                // Validações básicas
                if (!date || isNaN(Date.parse(date))) {
                    throw new Error("Data inválida ou não fornecida");
                }
                if (!time || !/^\d{2}:\d{2}$/.test(time)) {
                    throw new Error("Hora inválida ou não fornecida");
                }
                if (status && !['pending', 'completed', 'canceled', 'scheduled'].includes(status)) {
                    throw new Error("Status inválido. Valores permitidos: pending, completed, canceled, scheduled");
                }
                if (status === 'canceled' && confirmedAbsence === undefined) {
                    throw new Error("Para sessões canceladas, 'confirmedAbsence' é obrigatório");
                }

                // Buscar sessão
                const sessionDoc = await Session.findById(sessionId)
                    .populate({
                        path: 'package',
                        select: 'sessionType sessionsPerWeek doctor patient sessionValue totalSessions totalPaid sessionsDone status paymentType type'
                    })
                    .populate('appointmentId')
                    .session(mongoSession);

                if (!sessionDoc) {
                    throw new Error("Sessão não encontrada");
                }

                const previousStatus = sessionDoc.status;

                // Atualiza campos da sessão
                sessionDoc.date = date;
                sessionDoc.time = time;
                sessionDoc.notes = notes ?? sessionDoc.notes;
                if (doctorId) sessionDoc.doctor = doctorId;
                if (patientId) sessionDoc.patient = patientId;
                if (status) sessionDoc.status = status;
                if (sessionType) sessionDoc.sessionType = sessionType;
                if (!sessionType && specialty) sessionDoc.sessionType = specialty;

                // Atualiza confirmedAbsence
                if (confirmedAbsence !== undefined) {
                    sessionDoc.confirmedAbsence = confirmedAbsence;
                    if (status !== 'canceled') {
                        sessionDoc.confirmedAbsence = null;
                    }
                }

                // Funções auxiliares para status do agendamento
                const getOperationalStatus = (s) => {
                    if (s === 'completed') return 'confirmed';
                    if (s === 'canceled') return 'canceled';
                    return 'scheduled';
                };

                const getClinicalStatus = (s, confirmed) => {
                    if (s === 'completed') return 'completed';
                    if (s === 'canceled') return 'missed'; // Sessão cancelada = falta (missed)
                    return 'pending';
                };

                // ============================================
                // AJUSTES DE PACOTE (CORRIGIDO)
                // ============================================
                if (sessionDoc.package) {
                    const pkgId = sessionDoc.package._id;

                    // Caso 1: Sessão foi COMPLETADA (estava pending/scheduled)
                    if (previousStatus !== 'completed' && status === 'completed') {

                        // Incrementa sessionsDone
                        const updatedPackage = await Package.findByIdAndUpdate(
                            pkgId,
                            { $inc: { sessionsDone: 1 } },
                            { new: true, session: mongoSession }
                        );

                        // 🔧 CORREÇÃO: Verificar se todas as sessões ATIVAS foram concluídas
                        const allSessions = await Session.find({ package: pkgId })
                            .session(mongoSession);

                        const activeSessions = allSessions.filter(s => s.status !== 'canceled');
                        const completedSessions = allSessions.filter(s => s.status === 'completed');

                        // Marca como finished se TODAS as sessões ativas foram concluídas
                        if (completedSessions.length >= activeSessions.length) {
                            await Package.findByIdAndUpdate(
                                pkgId,
                                { status: 'finished' },
                                { session: mongoSession }
                            );
                            console.log(`✅ Pacote ${pkgId} marcado como finished (${completedSessions.length}/${activeSessions.length} ativas concluídas)`);
                        }

                        // 🔧 CORREÇÃO: Usar sessionValue ao invés de value
                        // 🏥 CONVÊNIO: Criar recebível (não entra no caixa ainda)
                        // 💰 PARTICULAR: Criar pagamento normal (entra no caixa)
                        // ⚖️ LIMINAR: Reconhece receita diferida (crédito por sessão)
                        const isConvenio = sessionDoc.package.type === 'convenio' || 
                                          sessionDoc.paymentMethod === 'convenio' ||
                                          sessionDoc.billingType === 'convenio';
                        const isLiminar = sessionDoc.package.type === 'liminar';

                        if (isLiminar) {
                            // ⚖️ LIMINAR: Reconhecer receita diferida por sessão
                            const sessionRevenue = sessionDoc.sessionValue || sessionDoc.package.sessionValue || 0;
                            
                            // Atualizar saldo de crédito e receita reconhecida
                            const updatedPackage = await Package.findByIdAndUpdate(
                                pkgId,
                                {
                                    $inc: { 
                                        liminarCreditBalance: -sessionRevenue,
                                        recognizedRevenue: sessionRevenue
                                    }
                                },
                                { new: true, session: mongoSession }
                            );

                            // Criar registro de receita reconhecida
                            const revenueDoc = new Payment({
                                patient: sessionDoc.patient,
                                doctor: sessionDoc.doctor,
                                serviceType: 'package_session',
                                amount: sessionRevenue,
                                paymentMethod: 'liminar_credit',
                                billingType: 'particular',  // ← Entra no caixa como receita particular
                                session: sessionDoc._id,
                                package: pkgId,
                                serviceDate: sessionDoc.date,
                                paymentDate: sessionDoc.date,  // ← Entra no caixa no dia do atendimento
                                status: 'paid',  // ← 'recognized' não é pego pela query de caixa
                                kind: 'revenue_recognition',
                                notes: `Receita reconhecida - Processo: ${sessionDoc.package.liminarProcessNumber}`
                            });
                            await revenueDoc.save({ session: mongoSession });

                            // Atualizar totalPaid do pacote (receita reconhecida)
                            await Package.findByIdAndUpdate(
                                pkgId,
                                {
                                    $inc: { totalPaid: sessionRevenue },
                                    $push: { payments: revenueDoc._id }
                                },
                                { session: mongoSession }
                            );

                            sessionDoc.isPaid = true;
                            sessionDoc.paymentStatus = 'recognized';
                            sessionDoc.visualFlag = 'ok';

                            console.log(`⚖️ Receita liminar reconhecida: R$ ${sessionRevenue} - Processo: ${sessionDoc.package.liminarProcessNumber}`);
                            console.log(`💳 Saldo de crédito restante: R$ ${updatedPackage.liminarCreditBalance - sessionRevenue}`);

                        } else if (isConvenio) {
                            // 🏥 Criar recebível de convênio
                            await criarRecebivelConvenio(sessionDoc, sessionDoc.package, mongoSession);
                            
                            // Marcar sessão como aguardando recebimento do convênio
                            sessionDoc.isPaid = false;
                            sessionDoc.paymentStatus = 'pending_receipt';
                            sessionDoc.visualFlag = 'pending';
                        } else if (!sessionDoc.isPaid) {
                            // 💰 PARTICULAR: Verificar se é per-session (pagamento no dia)
                            const isPerSession = sessionDoc.package.paymentType === 'per-session';
                            
                            if (isPerSession) {
                                // 🔥 PER-SESSION: Cria pagamento automaticamente ao completar
                                const sessionValue = sessionDoc.sessionValue || sessionDoc.package.sessionValue || 0;
                                
                                const paymentDoc = new Payment({
                                    patient: sessionDoc.patient,
                                    doctor: sessionDoc.doctor,
                                    serviceType: 'package_session',
                                    amount: sessionValue,
                                    paymentMethod: 'pix', // Default, pode ser alterado depois
                                    billingType: 'particular',
                                    session: sessionDoc._id,
                                    package: pkgId,
                                    serviceDate: sessionDoc.date,
                                    paymentDate: sessionDoc.date, // Entra no caixa no dia
                                    status: 'paid',
                                    kind: 'session_payment',
                                    notes: `Pagamento automático - Sessão ${moment(sessionDoc.date).format('DD/MM/YYYY')} ${sessionDoc.time}`
                                });
                                await paymentDoc.save({ session: mongoSession });
                                
                                // Atualizar pacote
                                const newTotalPaid = (sessionDoc.package.totalPaid || 0) + sessionValue;
                                const newBalance = (sessionDoc.package.totalValue || 0) - newTotalPaid;
                                const newFinancialStatus = newBalance <= 0 ? 'paid' : 
                                                           newTotalPaid > 0 ? 'partially_paid' : 'unpaid';
                                
                                await Package.findByIdAndUpdate(
                                    pkgId,
                                    {
                                        $inc: { totalPaid: sessionValue, paidSessions: 1 },
                                        $push: { payments: paymentDoc._id },
                                        $set: {
                                            balance: newBalance,
                                            financialStatus: newFinancialStatus,
                                            lastPaymentAt: new Date()
                                        }
                                    },
                                    { session: mongoSession }
                                );
                                
                                // Atualizar sessão
                                sessionDoc.isPaid = true;
                                sessionDoc.paymentStatus = 'paid';
                                sessionDoc.paymentId = paymentDoc._id;
                                sessionDoc.visualFlag = 'ok';
                                sessionDoc.paidAt = new Date();
                                sessionDoc.paymentMethod = 'pix';
                                
                                console.log(`💰 Pagamento per-session automático: R$ ${sessionValue} - Sessão ${sessionDoc._id}`);
                                
                            } else {
                                // 💰 FULL/PARTIAL: Sem pagamento prévio → deixa em aberto
                                // O pagamento já foi feito antecipadamente
                                sessionDoc.isPaid = false;
                                sessionDoc.paymentStatus = 'pending';
                                sessionDoc.visualFlag = 'pending';
                            }
                        }

                    }
                    // Caso 2: Sessão foi DESCOMPLETADA (estava completed, voltou para outro status)
                    else if (previousStatus === 'completed' && status !== 'completed') {

                        // Decrementa sessionsDone
                        const updatedPackage = await Package.findByIdAndUpdate(
                            pkgId,
                            { $inc: { sessionsDone: -1 } },
                            { new: true, session: mongoSession }
                        );

                        // Se estava finished e agora tem sessões pendentes, volta para active
                        if (updatedPackage.status === 'finished') {
                            const allSessions = await Session.find({ package: pkgId })
                                .session(mongoSession);

                            const activeSessions = allSessions.filter(s => s.status !== 'canceled');
                            const completedSessions = allSessions.filter(s => s.status === 'completed');

                            // Só volta para active se ainda há sessões ativas não concluídas
                            if (completedSessions.length < activeSessions.length) {
                                await Package.findByIdAndUpdate(
                                    pkgId,
                                    { status: 'active' },
                                    { session: mongoSession }
                                );
                                console.log(`🔄 Pacote ${pkgId} voltou para active (${completedSessions.length}/${activeSessions.length} concluídas)`);
                            }
                        }

                        // ============================================
                        // LÓGICA REFINADA DE REMOÇÃO DE PAGAMENTO
                        // ============================================

                        // ⚖️ LIMINAR: Reverter reconhecimento de receita
                        const isLiminar = sessionDoc.package.type === 'liminar';
                        
                        // 🏥 CONVÊNIO: Remover recebível se existir
                        const isConvenio = sessionDoc.package.type === 'convenio' || 
                                          sessionDoc.paymentMethod === 'convenio' ||
                                          sessionDoc.billingType === 'convenio';

                        if (isLiminar) {
                            // ⚖️ LIMINAR: Reverter receita reconhecida
                            // 💡 IMPORTANTE: Não é necessário cancelar a sessão! 
                            // Ao alterar o status de 'completed' para outro, o crédito volta automaticamente.
                            const sessionRevenue = sessionDoc.sessionValue || sessionDoc.package.sessionValue || 0;
                            
                            // Buscar e remover o registro de receita reconhecida
                            const revenueRecord = await Payment.findOne({
                                session: sessionDoc._id,
                                kind: 'revenue_recognition',
                                status: 'recognized'
                            }).session(mongoSession);

                            if (revenueRecord) {
                                // Restaurar saldo de crédito
                                await Package.findByIdAndUpdate(
                                    pkgId,
                                    {
                                        $inc: { 
                                            liminarCreditBalance: sessionRevenue,
                                            recognizedRevenue: -sessionRevenue,
                                            totalPaid: -sessionRevenue
                                        },
                                        $pull: { payments: revenueRecord._id }
                                    },
                                    { session: mongoSession }
                                );

                                await Payment.deleteOne({ _id: revenueRecord._id })
                                    .session(mongoSession);

                                console.log(`⚖️ Receita liminar revertida: R$ ${sessionRevenue}`);
                                console.log(`💡 Crédito restaurado! Status alterado de 'completed' para '${status}'. Não foi necessário cancelar a sessão.`);
                            }
                            
                            sessionDoc.isPaid = false;
                            sessionDoc.paymentStatus = 'pending';
                            sessionDoc.visualFlag = 'pending';
                        } else if (isConvenio) {
                            // Buscar e remover recebível de convênio
                            const recebivelConvenio = await Payment.findOne({
                                session: sessionDoc._id,
                                billingType: 'convenio',
                                'insurance.status': 'pending_billing'
                            }).session(mongoSession);

                            if (recebivelConvenio) {
                                await Payment.deleteOne({ _id: recebivelConvenio._id })
                                    .session(mongoSession);
                                console.log(`🏥 Recebível de convênio removido: ${recebivelConvenio._id}`);
                            }
                            
                            sessionDoc.isPaid = false;
                            sessionDoc.paymentStatus = 'pending';
                            sessionDoc.visualFlag = 'pending';
                        } else {
                            // 💰 PARTICULAR: Buscar pagamento de conclusão automático
                            const autoPayment = await Payment.findOne({
                                session: sessionDoc._id,
                                kind: 'session_completion',
                                status: 'paid'
                            }).session(mongoSession);

                            if (autoPayment) {
                                // Verificar se a sessão já estava paga ANTES de ser concluída
                                const wasAlreadyPaid = sessionDoc.isPaid &&
                                    sessionDoc.paymentStatus === 'paid';

                                if (!wasAlreadyPaid) {
                                    // Remove pagamento automático (não estava pago antes)
                                    await Payment.deleteOne({ _id: autoPayment._id })
                                        .session(mongoSession);

                                    await Package.findByIdAndUpdate(
                                        pkgId,
                                        {
                                            $pull: { payments: autoPayment._id },
                                            $inc: { totalPaid: -autoPayment.amount }
                                        },
                                        { session: mongoSession }
                                    );

                                    sessionDoc.isPaid = false;
                                    sessionDoc.paymentStatus = 'pending';

                                    console.log(`💰 Pagamento automático removido (sessão não estava paga antes)`);
                                } else {
                                    console.log(`💰 Pagamento mantido (sessão já estava paga antes da conclusão)`);
                                }
                            }
                        }
                    }

                    // Recalcular balance do pacote
                    const pkg = await Package.findById(pkgId).session(mongoSession);
                    const allPkgSessions = await Session.find({ package: pkgId })
                        .session(mongoSession);

                    pkg.balance = pkg.totalValue - (pkg.totalPaid || 0);
                    pkg.financialStatus =
                        pkg.balance <= 0 ? 'paid' :
                            pkg.totalPaid > 0 ? 'partially_paid' : 'unpaid';

                    await pkg.save({ session: mongoSession });
                }

                // ============================================
                // ATUALIZAR OU CRIAR APPOINTMENT
                // ============================================
                if (sessionDoc.appointmentId) {
                    const appointment = await Appointment.findById(sessionDoc.appointmentId._id)
                        .session(mongoSession);

                    if (appointment) {
                        appointment.patient = sessionDoc.patient;
                        appointment.doctor = sessionDoc.doctor;
                        appointment.date = date;
                        appointment.time = time;
                        appointment.duration = 40;
                        appointment.specialty = sessionDoc.sessionType;
                        appointment.operationalStatus = getOperationalStatus(sessionDoc.status);
                        appointment.clinicalStatus = getClinicalStatus(sessionDoc.status, sessionDoc.confirmedAbsence);
                        appointment.sessionType = sessionDoc.sessionType;
                        appointment.serviceType = serviceType;
                        appointment.session = sessionDoc._id;
                        // 💰 Sincroniza status financeiro com a sessão
                        appointment.paymentStatus = sessionDoc.paymentStatus;
                        appointment.visualFlag = sessionDoc.visualFlag;
                        await appointment.save({ session: mongoSession });
                    }
                } else {
                    const appointment = new Appointment({
                        patient: sessionDoc.patient,
                        doctor: sessionDoc.doctor,
                        date,
                        time,
                        duration: 40,
                        specialty: sessionDoc.sessionType,
                        operationalStatus: getOperationalStatus(sessionDoc.status),
                        clinicalStatus: getClinicalStatus(sessionDoc.status, sessionDoc.confirmedAbsence),
                        session: sessionDoc._id,
                        serviceType: serviceType,
                        sessionType: sessionDoc.sessionType,
                        // 💰 Sincroniza status financeiro com a sessão
                        paymentStatus: sessionDoc.paymentStatus,
                        visualFlag: sessionDoc.visualFlag
                    });
                    await appointment.save({ session: mongoSession });
                    sessionDoc.appointmentId = appointment._id;
                }

                // Salva sessão atualizada
                await sessionDoc.save({ session: mongoSession });

                // Commit da transação
                await mongoSession.commitTransaction();
                transactionCommitted = true;

                // Retorna dados atualizados
                const updatedSession = await Session.findById(sessionId)
                    .populate({
                        path: 'package',
                        populate: { path: 'payments sessions' }
                    })
                    .populate('doctor patient')
                    .populate('appointmentId');

                res.json({
                    success: true,
                    session: updatedSession,
                    package: updatedSession.package
                });

            } catch (error) {
                console.error("❌ Erro na atualização da sessão:", error);
                if (!transactionCommitted && mongoSession.inTransaction()) {
                    await mongoSession.abortTransaction();
                }
                res.status(500).json({
                    success: false,
                    error: error.message
                });
            } finally {
                await mongoSession.endSession();
            }
        }
    },

    delete: {
        package: async (req, res) => {
            const session = await mongoose.startSession();
            try {
                await session.startTransaction();

                const packageId = req.params.id;

                // 1. Buscar o pacote para obter referências
                const packageDoc = await Package.findById(packageId)
                    .session(session);

                if (!packageDoc) {
                    return res.status(404).json({ error: 'Pacote não encontrado' });
                }

                // 2. Coletar todos os IDs relacionados
                const sessionIds = packageDoc.sessions || [];
                const paymentIds = packageDoc.payments || [];

                // 3. Obter IDs de agendamentos associados às sessões
                const sessions = await Session.find({ _id: { $in: sessionIds } })
                    .select('appointmentId')
                    .session(session);

                const appointmentIds = sessions
                    .map(s => s.appointmentId)
                    .filter(id => id);

                // 4. Deletar em cascata - Ordem correta para evitar erros de chave estrangeira
                // a. Deletar agendamentos
                if (appointmentIds.length > 0) {
                    await Appointment.deleteMany({
                        _id: { $in: appointmentIds }
                    }).session(session);
                }

                // b. Deletar sessões
                if (sessionIds.length > 0) {
                    await Session.deleteMany({
                        _id: { $in: sessionIds }
                    }).session(session);
                }

                // c. Deletar pagamentos
                if (paymentIds.length > 0) {
                    await Payment.deleteMany({
                        _id: { $in: paymentIds }
                    }).session(session);
                }

                // d. Deletar o pacote principal
                await Package.deleteOne({ _id: packageId }).session(session);

                // 🔹 Remover referência do pacote do paciente
                await Patient.findByIdAndUpdate(
                    packageDoc.patient,
                    { $pull: { packages: packageId } },
                    { session }
                );


                // 5. Deletar eventos médicos relacionados
                await MedicalEvent.deleteMany({
                    originalId: {
                        $in: [
                            packageId,
                            ...sessionIds,
                            ...appointmentIds,
                            ...paymentIds
                        ]
                    }
                }).session(session);

                await session.commitTransaction();
                res.status(204).send();

            } catch (error) {
                await session.abortTransaction();
                console.error('Erro ao deletar pacote:', error);

                if (error.name === 'ValidationError') {
                    const errors = Object.keys(error.errors).reduce((acc, key) => {
                        acc[key] = error.errors[key].message;
                        return acc;
                    }, {});

                    return res.status(400).json({
                        message: 'Falha na validação dos dados',
                        errors
                    });
                }

                res.status(500).json({
                    error: 'Erro interno',
                    details: process.env.NODE_ENV === 'development' ? error.message : undefined
                });
            } finally {
                await session.endSession();
            }
        },
        session: async (req, res) => {
            const session = await mongoose.startSession();
            try {
                await session.startTransaction();

                const { id: packageId, sessionId } = req.params;

                // 1. Buscar a sessão para obter referências
                const sessionDoc = await Session.findById(sessionId)
                    .session(session);

                if (!sessionDoc) {
                    return res.status(404).json({ error: 'Sessão não encontrada' });
                }

                // 2. Coletar IDs relacionados
                const appointmentId = sessionDoc.appointmentId;
                const paymentId = sessionDoc.paymentId; // assumindo que pode ter

                // 3. Deletar em cascata
                // a. Deletar agendamento se existir
                if (appointmentId) {
                    await Appointment.deleteOne({ _id: appointmentId })
                        .session(session);
                }

                // b. Deletar pagamento se existir
                if (paymentId) {
                    await Payment.deleteOne({ _id: paymentId })
                        .session(session);
                }

                // c. Deletar a sessão
                await Session.deleteOne({ _id: sessionId })
                    .session(session);

                // d. Remover referência no pacote
                await Package.findByIdAndUpdate(
                    packageId,
                    { $pull: { sessions: sessionId } },
                    { session }
                );

                // e. Deletar eventos médicos relacionados
                await MedicalEvent.deleteMany({
                    originalId: {
                        $in: [
                            sessionId,
                            appointmentId,
                            paymentId
                        ].filter(Boolean) // remove valores null/undefined
                    }
                }).session(session);

                await session.commitTransaction();
                res.status(204).send();

            } catch (error) {
                await session.abortTransaction();
                console.error('Erro ao deletar sessão:', error);

                if (error.name === 'ValidationError') {
                    const errors = Object.keys(error.errors).reduce((acc, key) => {
                        acc[key] = error.errors[key].message;
                        return acc;
                    }, {});

                    return res.status(400).json({
                        message: 'Falha na validação dos dados',
                        errors
                    });
                }

                res.status(500).json({
                    error: 'Erro interno',
                    details: process.env.NODE_ENV === 'development' ? error.message : undefined
                });
            } finally {
                await session.endSession();
            }
        }

    },

    // Operações Específicas
    addSession: async (req, res) => {
        try {
            const pkg = await Package.findByIdAndUpdate(
                req.params.id,
                { $push: { sessions: req.body } },
                { new: true, runValidators: true }
            );
            res.json(pkg);
        } catch (error) {
            if (error.name === 'ValidationError') {
                // 💡 Extrai erros campo a campo
                const errors = Object.keys(error.errors).reduce((acc, key) => {
                    acc[key] = error.errors[key].message;
                    return acc;
                }, {});

                return res.status(400).json({
                    message: 'Falha na validação dos dados',
                    errors
                });
            }

            return res.status(500).json({ error: 'Erro interno' });
        }
    },


    addSessionToPackage: async (req, res) => {
        const mongoSession = await mongoose.startSession();
        let transactionCommitted = false;

        try {
            await mongoSession.startTransaction();

            const packageId = req.params.id;
            const {
                date,
                time,
                notes,
                patientId,
                doctorId,
                sessionType,
                specialty,
                sessionValue,
                status = 'scheduled'
            } = req.body;

            // ============================================================
            // VALIDAÇÕES BÁSICAS
            // ============================================================
            if (!date || !time) {
                throw new Error('Data e horário são obrigatórios');
            }

            if (!isValidDateString(date)) {
                throw new Error('Formato de data inválido. Use YYYY-MM-DD');
            }

            if (!isValidTimeString(time)) {
                throw new Error('Formato de hora inválido. Use HH:mm');
            }

            // ============================================================
            // BUSCAR O PACOTE
            // ============================================================
            const pkg = await Package.findById(packageId).session(mongoSession);
            if (!pkg) {
                throw new Error('Pacote não encontrado');
            }

            console.log('📦 Pacote encontrado:', pkg._id);

            // ============================================================
            // ✅ VALIDAR E NORMALIZAR sessionValue
            // ============================================================
            let validSessionValue = pkg.sessionValue || 0;

            if (sessionValue !== undefined && sessionValue !== null && sessionValue !== '') {
                const parsed = Number(sessionValue);
                if (!isNaN(parsed) && parsed >= 0) {
                    validSessionValue = parsed;
                }
            }

            console.log('💰 SessionValue:', {
                recebido: sessionValue,
                doPacote: pkg.sessionValue,
                utilizado: validSessionValue
            });

            // ============================================================
            // VERIFICAR CONFLITO
            // ============================================================
            const conflictSession = await Session.findOne({
                date,
                time,
                doctor: doctorId || pkg.doctor,
                patient: patientId || pkg.patient,
                specialty: specialty || pkg.specialty,
                status: { $ne: 'canceled' }
            }).session(mongoSession);

            if (conflictSession) {
                throw new Error(
                    `Já existe uma sessão agendada para ${moment(date).format('DD/MM/YYYY')} às ${time}`
                );
            }

            // ============================================================
            // BUSCAR SESSÃO CANCELADA QUE TINHA PAGAMENTO
            // ============================================================
            const canceledPaidSession = await Session.findOne({
                package: packageId,
                status: 'canceled',
                $or: [
                    { originalPaymentStatus: { $exists: true } },
                    { originalIsPaid: true },
                    { originalPartialAmount: { $exists: true, $gt: 0 } }
                ]
            })
                .sort({ canceledAt: -1 })
                .session(mongoSession);

            // ============================================================
            // ✅ DEFINIR VALORES FINANCEIROS (HERDA DA CANCELADA SE EXISTIR)
            // ============================================================
            let isPaid, paymentStatus, visualFlag, paymentMethod, partialAmount;

            if (canceledPaidSession && canceledPaidSession.originalPartialAmount > 0) {
                isPaid = true;
                paymentStatus = 'paid';
                visualFlag = 'ok';
                paymentMethod =
                    canceledPaidSession.originalPaymentMethod || pkg.paymentMethod || 'pix';
                partialAmount = Number(canceledPaidSession.originalPartialAmount);

                // ✅ ZERAR CANCELADA (UMA VEZ SÓ)
                canceledPaidSession.originalPartialAmount = 0;
                canceledPaidSession.originalPaymentStatus = null;
                canceledPaidSession.originalIsPaid = false;
                canceledPaidSession.originalPaymentMethod = null;

                await canceledPaidSession.save({
                    session: mongoSession,
                    validateBeforeSave: false
                });

                console.log('♻️ Sessão cancelada zerada:', canceledPaidSession._id);
            } else {
                isPaid = false;
                paymentStatus = 'pending';
                visualFlag = 'pending';
                paymentMethod = pkg.paymentMethod || 'pix';
                partialAmount = 0;

                console.log('📝 Nova sessão sem pagamento prévio');
            }

            console.log('💰 Dados financeiros calculados PARA A SESSÃO:', {
                isPaid,
                paymentStatus,
                visualFlag,
                partialAmount
            });

            // ============================================================
            // CRIAR NOVA SESSÃO
            // ============================================================
            const newSession = new Session({
                date,
                time,
                patient: patientId || pkg.patient,
                doctor: doctorId || pkg.doctor,
                package: packageId,
                sessionValue: validSessionValue,
                sessionType: sessionType || pkg.sessionType,
                specialty: specialty || pkg.specialty || pkg.sessionType,
                status,
                isPaid,
                paymentStatus,
                visualFlag,
                paymentMethod,
                partialAmount,
                notes: notes || '',
                _inFinancialTransaction: true
            });

            await newSession.save({
                session: mongoSession,
                validateBeforeSave: false
            });

            console.log('✅ Nova sessão criada:', newSession._id);

            // ============================================================
            // CRIAR APPOINTMENT
            // ============================================================
            
            // 🔥 CALCULA SE É PRIMEIRO AGENDAMENTO DO PACIENTE
            const existingAppointments = await Appointment.countDocuments({ 
                patient: newSession.patient 
            }).session(mongoSession);
            const isFirstAppointment = existingAppointments === 0;
            
            const newAppointment = new Appointment({
                patient: newSession.patient,
                doctor: newSession.doctor,
                date: newSession.date,
                time: newSession.time,
                duration: 40,
                specialty: newSession.specialty,
                session: newSession._id,
                package: packageId,
                serviceType: 'package_session',
                operationalStatus: 'scheduled',
                clinicalStatus: 'pending',
                paymentStatus: newSession.paymentStatus,
                visualFlag: newSession.visualFlag,
                // 🔥 NOVO: Primeiro agendamento do paciente?
                isFirstAppointment: isFirstAppointment
            });

            await newAppointment.save({
                session: mongoSession,
                validateBeforeSave: false
            });

            console.log('✅ Agendamento criado:', newAppointment._id);

            // ============================================================
            // VINCULAR APPOINTMENT À SESSÃO
            // ============================================================
            newSession.appointmentId = newAppointment._id;
            await newSession.save({
                session: mongoSession,
                validateBeforeSave: false
            });

            // ============================================================
            // ✅ ATUALIZAR PACOTE (SEM MEXER NO FINANCEIRO)
            // ============================================================
            const updatedPkg = await Package.findByIdAndUpdate(
                packageId,
                {
                    $push: {
                        sessions: newSession._id,
                        appointments: newAppointment._id
                    }
                    // 🔒 NÃO mexe em totalSessions
                    // 🔒 NÃO mexe em totalPaid
                    // 🔒 NÃO mexe em balance
                    // 🔒 NÃO mexe em financialStatus
                },
                {
                    session: mongoSession,
                    new: true
                }
            );

            console.log('✅ Pacote atualizado:', {
                id: updatedPkg._id,
                totalSessions: updatedPkg.totalSessions,
                totalPaid: updatedPkg.totalPaid,
                balance: updatedPkg.balance,
                financialStatus: updatedPkg.financialStatus
            });

            // ============================================================
            // COMMIT DA TRANSAÇÃO
            // ============================================================
            await mongoSession.commitTransaction();
            transactionCommitted = true;

            console.log('✅ Transação concluída');

            // ============================================================
            // SINCRONIZAÇÃO
            // ============================================================
            try {
                await syncEvent(updatedPkg, 'package');
            } catch (syncError) {
                console.error('⚠️ Erro na sincronização:', syncError.message);
            }

            // ============================================================
            // RETORNAR RESULTADO
            // ============================================================
            const result = await Package.findById(packageId)
                .populate('sessions appointments payments')
                .populate('patient')
                .populate({
                    path: 'doctor',
                    model: 'Doctor',
                    select: '_id fullName specialty'
                })
                .lean();

            res.status(201).json({
                success: true,
                message:
                    canceledPaidSession && partialAmount > 0
                        ? 'Sessão adicionada reaproveitando pagamento anterior'
                        : 'Sessão adicionada com sucesso',
                session: {
                    _id: newSession._id,
                    date: newSession.date,
                    time: newSession.time,
                    isPaid: newSession.isPaid,
                    paymentStatus: newSession.paymentStatus,
                    visualFlag: newSession.visualFlag,
                    partialAmount: newSession.partialAmount,
                    sessionValue: newSession.sessionValue
                },
                package: result,
                reusedPayment: !!(canceledPaidSession && partialAmount > 0)
            });
        } catch (error) {
            if (mongoSession?.inTransaction() && !transactionCommitted) {
                await mongoSession.abortTransaction();
            }

            console.error('❌ Erro ao adicionar sessão:', error);

            let statusCode = 500;
            let message = error.message || 'Erro ao adicionar sessão';

            if (error.message.includes('Já existe')) {
                statusCode = 409;
            } else if (error.message.includes('não encontrado')) {
                statusCode = 404;
            } else if (error.message.includes('obrigatório') || error.message.includes('inválido')) {
                statusCode = 400;
            }

            res.status(statusCode).json({
                success: false,
                message,
                errorCode: 'ADD_SESSION_ERROR'
            });
        } finally {
            await mongoSession.endSession();
        }
    },

    registerPayment: async (req, res) => {
        const mongoSession = await mongoose.startSession();
        try {
            await mongoSession.startTransaction();

            const { amount, paymentMethod, notes } = req.body;
            const packageId = req.params.id;

            if (!amount || !paymentMethod) {
                throw new Error("Valor e método de pagamento são obrigatórios.");
            }

            // 🔹 Buscar pacote existente (FORA da transação - otimizado)
            const pkg = await Package.findById(packageId)
                .populate("sessions")
                .lean();

            if (!pkg) throw new Error("Pacote não encontrado.");

            // 🔹 Criar pagamento principal (recibo do pacote)
            const paymentDoc = new Payment({
                package: pkg._id,
                patient: pkg.patient,
                doctor: pkg.doctor,
                amount: parseFloat(amount),
                paymentMethod,
                notes: notes || "Pagamento adicional registrado manualmente.",
                status: "paid",
                kind: "package_receipt",
                serviceType: "package_session",
                paymentDate: moment()
                    .tz("America/Sao_Paulo")
                    .format("YYYY-MM-DD"),
                updatedAt: new Date()
            });

            await paymentDoc.save({ session: mongoSession });

            // 🔹 Distribuir valor entre sessões pendentes
            const updatedPackage = await distributePayments(
                packageId,
                parseFloat(amount),
                mongoSession,
                paymentDoc._id // passa o recibo como parentPayment
            );

            // 🔹 Atualizar vínculos no pacote (usando updateOne - otimizado)
            const newTotalPaid = (pkg.totalPaid || 0) + parseFloat(amount);
            const newBalance = pkg.totalSessions * pkg.sessionValue - newTotalPaid;
            const newFinancialStatus =
                newBalance <= 0
                    ? "paid"
                    : newTotalPaid > 0
                        ? "partially_paid"
                        : "unpaid";

            await Package.updateOne(
                { _id: packageId },
                {
                    $push: { payments: paymentDoc._id },
                    $set: {
                        totalPaid: newTotalPaid,
                        balance: newBalance,
                        financialStatus: newFinancialStatus,
                        lastPaymentAt: new Date()
                    }
                },
                { session: mongoSession }
            );

            // 🔹 Finalizar transação
            await mongoSession.commitTransaction();

            res.json({
                success: true,
                message: "Pagamento registrado e distribuído com sucesso.",
                payment: paymentDoc,
                updatedPackage,
            });
        } catch (error) {
            await mongoSession.abortTransaction();
            console.error("❌ Erro em registerPayment:", error);
            res.status(500).json({
                success: false,
                message: error.message || "Erro interno ao registrar pagamento.",
            });
        } finally {
            await mongoSession.endSession();
        }
    },

};

// Operação de Atualização de Status
export const updateStatus = async (req, res) => {
    try {
        const { status } = req.body;
        const validStatus = ['active', 'finished', 'canceled'];

        if (!validStatus.includes(status)) {
            return res.status(400).json({ error: 'Status inválido' });
        }

        const updated = await Package.findByIdAndUpdate(
            req.params.id,
            { status },
            { new: true, runValidators: true }
        );

        res.json({
            _id: updated._id,
            status: updated.status,
            updatedAt: updated.updatedAt
        });
    } catch (error) {
        if (error.name === 'ValidationError') {
            // 💡 Extrai erros campo a campo
            const errors = Object.keys(error.errors).reduce((acc, key) => {
                acc[key] = error.errors[key].message;
                return acc;
            }, {});

            return res.status(400).json({
                message: 'Falha na validação dos dados',
                errors
            });
        }

        return res.status(500).json({ error: 'Erro interno' });
    }
};

// Operação de Relatório
export const generateReport = async (req, res) => {
    try {
        const packages = await Package.find()
            .populate('patient', 'name')
            .lean();

        const reportData = packages.map(pkg => ({
            patient: pkg.patient.name,
            totalSessions: pkg.totalSessions,
            sessionsDone: pkg.sessions.length,
            totalPaid: pkg.totalPaid,
            balance: pkg.balance
        }));

        res.json(reportData);
    } catch (error) {
        if (error.name === 'ValidationError') {
            // 💡 Extrai erros campo a campo
            const errors = Object.keys(error.errors).reduce((acc, key) => {
                acc[key] = error.errors[key].message;
                return acc;
            }, {});

            return res.status(400).json({
                message: 'Falha na validação dos dados',
                errors
            });
        }

        return res.status(500).json({ error: 'Erro interno' });
    }
};

export const getPackageById = async (req, res) => {
    try {
        const packages = await Package.findById(req.params.id)
            .populate('patient', 'name birthDate'); // Campos necessários

        if (!packages) return res.status(404).json({ error: 'Pacote não encontrado' });
        res.json(packages);
    } catch (error) {
        if (error.name === 'ValidationError') {
            // 💡 Extrai erros campo a campo
            const errors = Object.keys(error.errors).reduce((acc, key) => {
                acc[key] = error.errors[key].message;
                return acc;
            }, {});

            return res.status(400).json({
                message: 'Falha na validação dos dados',
                errors
            });
        }

        return res.status(500).json({ error: 'Erro interno' });
    }
}

export const getPackageVersionHistory = async (req, res) => {
    try {
        const packageId = req.params.id;

        // Buscar histórico no MedicalEvent
        const event = await MedicalEvent.findOne({
            originalId: packageId,
            type: 'package'
        }).select('versionHistory');

        if (!event) {
            return res.status(404).json({ error: 'Histórico não encontrado' });
        }

        res.json(event.versionHistory);
    } catch (error) {
        res.status(500).json({ error: 'Erro ao buscar histórico' });
    }
};

// ============================================
// 🔄 CANCELAMENTO EM MASSA DE SESSÕES (BULKWRITE)
// ============================================
export const bulkCancelSessions = async (req, res) => {
    const startTime = Date.now();
    const mongoSession = await mongoose.startSession();
    let transactionCommitted = false;

    try {
        const { sessionIds, confirmedAbsence = false } = req.body;
        const packageId = req.params.id;

        if (!sessionIds || !Array.isArray(sessionIds) || sessionIds.length === 0) {
            return res.status(400).json({ error: 'sessionIds deve ser um array não vazio' });
        }

        // 📝 LOG: Início da operação
        console.log({
            event: 'BULK_CANCEL_START',
            packageId,
            totalRequested: sessionIds.length,
            timestamp: new Date().toISOString()
        });

        await mongoSession.startTransaction();

        // Busca o pacote
        const pkg = await Package.findById(packageId).session(mongoSession);
        if (!pkg) {
            throw new Error('Pacote não encontrado');
        }

        // Busca apenas sessões que não estão canceladas
        const sessions = await Session.find({
            _id: { $in: sessionIds },
            package: packageId,
            status: { $ne: 'canceled' }
        }).session(mongoSession).lean();

        if (sessions.length === 0) {
            await mongoSession.abortTransaction();
            console.log({
                event: 'BULK_CANCEL_SKIPPED',
                packageId,
                reason: 'Nenhuma sessão precisa ser cancelada',
                timestamp: new Date().toISOString()
            });
            return res.json({
                success: true,
                message: 'Nenhuma sessão precisa ser cancelada',
                canceledCount: 0,
                totalRequested: sessionIds.length
            });
        }

        // 🚀 BULKWRITE: Atualiza todas as sessões de uma vez
        const sessionBulkOps = sessions.map(s => ({
            updateOne: {
                filter: { _id: s._id },
                update: {
                    $set: {
                        status: 'canceled',
                        confirmedAbsence: confirmedAbsence,
                        canceledAt: new Date()
                    }
                }
            }
        }));

        // ⚡ ordered: false = continua mesmo se algum falhar
        const bulkResult = await Session.bulkWrite(sessionBulkOps, { 
            session: mongoSession,
            ordered: false 
        });

        // 🚀 BULKWRITE: Atualiza appointments relacionados de uma vez
        const appointmentIds = sessions
            .filter(s => s.appointmentId)
            .map(s => s.appointmentId);

        let appointmentsUpdated = 0;
        if (appointmentIds.length > 0) {
            const appointmentResult = await Appointment.updateMany(
                { 
                    _id: { $in: appointmentIds },
                    operationalStatus: { $ne: 'canceled' }
                },
                {
                    $set: {
                        operationalStatus: 'canceled',
                        clinicalStatus: 'missed'
                    }
                },
                { session: mongoSession }
            );
            appointmentsUpdated = appointmentResult.modifiedCount || 0;
        }

        // Conta quantas eram 'completed' (para ajustar sessionsDone)
        const completedCount = sessions.filter(s => s.status === 'completed').length;

        // Ajusta sessionsDone do pacote se necessário
        if (completedCount > 0) {
            await Package.findByIdAndUpdate(
                packageId,
                { $inc: { sessionsDone: -completedCount } },
                { session: mongoSession }
            );
        }

        // Verifica status final do pacote (contagem otimizada)
        const [activeCount, completedRemaining] = await Promise.all([
            Session.countDocuments({ package: packageId, status: { $ne: 'canceled' } }).session(mongoSession),
            Session.countDocuments({ package: packageId, status: 'completed' }).session(mongoSession)
        ]);

        let packageStatusUpdated = null;
        if (activeCount === 0 && sessions.length > 0) {
            await Package.findByIdAndUpdate(
                packageId,
                { status: 'finished' },
                { session: mongoSession }
            );
            packageStatusUpdated = 'finished';
        } else if (completedRemaining < activeCount && pkg.status === 'finished') {
            await Package.findByIdAndUpdate(
                packageId,
                { status: 'active' },
                { session: mongoSession }
            );
            packageStatusUpdated = 'active';
        }

        await mongoSession.commitTransaction();
        transactionCommitted = true;

        const duration = Date.now() - startTime;

        // 📝 LOG: Sucesso
        console.log({
            event: 'BULK_CANCEL_SUCCESS',
            packageId,
            canceledCount: sessions.length,
            totalRequested: sessionIds.length,
            appointmentsUpdated,
            packageStatusUpdated,
            durationMs: duration,
            timestamp: new Date().toISOString()
        });

        res.json({
            success: true,
            message: `${sessions.length} sessão(ões) cancelada(s) com sucesso`,
            canceledCount: sessions.length,
            totalRequested: sessionIds.length,
            durationMs: duration
        });

    } catch (error) {
        if (!transactionCommitted) {
            await mongoSession.abortTransaction();
        }

        // 📝 LOG: Erro
        console.error({
            event: 'BULK_CANCEL_ERROR',
            packageId: req.params.id,
            error: error.message,
            stack: error.stack,
            timestamp: new Date().toISOString()
        });

        res.status(500).json({
            error: 'Erro ao cancelar sessões em massa',
            message: error.message
        });
    } finally {
        await mongoSession.endSession();
    }
};

// ============================================
// 🚀 CANCELAR TODAS AS SESSÕES DO PACOTE (ULTRA SIMPLES)
// ============================================
export const cancelAllSessions = async (req, res) => {
    const startTime = Date.now();
    const packageId = req.params.id;
    
    // 🔥 IDEMPOTÊNCIA: Lock para evitar duplo clique/concorrência
    const lockKey = `cancel:all:${packageId}`;
    try {
        const lock = await redis?.set(lockKey, '1', 'NX', 'EX', 30); // 30s de lock
        if (!lock) {
            return res.status(409).json({ 
                error: 'Cancelamento já em andamento',
                message: 'Aguarde alguns segundos e tente novamente'
            });
        }
    } catch (redisErr) {
        // ⚡ Se Redis cair, continua sem lock (loga warning)
        console.warn('[CANCEL-ALL] Redis indisponível, continuando sem lock:', redisErr.message);
    }

    const mongoSession = await mongoose.startSession();
    let transactionCommitted = false;

    try {
        const { confirmedAbsence = false } = req.body;

        // 🔄 ATUALIZA STATUS PARA 'CANCELING' (UX + controle)
        await Package.findByIdAndUpdate(
            packageId,
            { status: 'canceling', cancelingAt: new Date() },
            { session: mongoSession }
        );

        await mongoSession.startTransaction();

        // ⚡ UMA QUERY: Atualiza TODAS as sessões de uma vez
        const sessionResult = await Session.updateMany(
            {
                package: packageId,
                status: { $ne: 'canceled' }
            },
            {
                $set: {
                    status: 'canceled',
                    confirmedAbsence: confirmedAbsence,
                    canceledAt: new Date()
                }
            },
            { session: mongoSession }
        );

        // ⚡ UMA QUERY: Atualiza TODOS os appointments de uma vez
        const appointmentResult = await Appointment.updateMany(
            {
                package: packageId,
                operationalStatus: { $ne: 'canceled' }
            },
            {
                $set: {
                    operationalStatus: 'canceled',
                    clinicalStatus: 'missed'
                }
            },
            { session: mongoSession }
        );

        // Ajusta sessionsDone (conta quantas eram 'completed')
        const completedCount = await Session.countDocuments({
            package: packageId,
            status: 'completed'
        }).session(mongoSession);

        if (completedCount > 0) {
            await Package.findByIdAndUpdate(
                packageId,
                { $inc: { sessionsDone: -completedCount } },
                { session: mongoSession }
            );
        }

        // Atualiza status final do pacote
        const activeCount = await Session.countDocuments({
            package: packageId,
            status: { $ne: 'canceled' }
        }).session(mongoSession);

        const finalStatus = activeCount === 0 ? 'canceled' : 'active';
        
        // 🛡️ ATUALIZA SÓ SE AINDA ESTÁ 'CANCELING' (evita race condition rara)
        await Package.findOneAndUpdate(
            { 
                _id: packageId,
                status: 'canceling'  // Só atualiza se ninguém mudou o status no meio
            },
            { 
                status: finalStatus,
                canceledAt: finalStatus === 'canceled' ? new Date() : null,
                cancelingAt: null
            },
            { session: mongoSession }
        );

        await mongoSession.commitTransaction();
        transactionCommitted = true;

        const duration = Date.now() - startTime;

        // 📝 LOG
        console.log({
            event: 'CANCEL_ALL_SUCCESS',
            packageId,
            canceledCount: sessionResult.modifiedCount,
            appointmentsUpdated: appointmentResult.modifiedCount,
            finalStatus,
            durationMs: duration,
            timestamp: new Date().toISOString()
        });

        // 📦 RESPONSE COMPLETO
        res.json({
            success: true,
            message: `${sessionResult.modifiedCount} sessão(ões) cancelada(s)`,
            packageId,
            canceledSessions: sessionResult.modifiedCount,
            canceledAppointments: appointmentResult.modifiedCount,
            finalStatus,
            durationMs: duration
        });

    } catch (error) {
        if (!transactionCommitted) {
            await mongoSession.abortTransaction();
        }

        console.error({
            event: 'CANCEL_ALL_ERROR',
            packageId,
            error: error.message,
            timestamp: new Date().toISOString()
        });

        // Em caso de erro, tenta restaurar status do pacote
        try {
            await Package.findByIdAndUpdate(packageId, { 
                status: 'active',
                cancelingAt: null 
            });
        } catch (restoreErr) {
            console.error('Falha ao restaurar status do pacote:', restoreErr.message);
        }

        res.status(500).json({
            error: 'Erro ao cancelar sessões',
            message: error.message
        });
    } finally {
        await mongoSession.endSession();
        
        // 🔓 LIBERA O LOCK (sempre, mesmo em erro)
        try {
            await redis?.del(lockKey);
        } catch (redisErr) {
            console.warn('[CANCEL-ALL] Falha ao liberar lock:', redisErr.message);
        }
    }
};

// Funções de validação
function isValidDateString(dateString) {
    const regex = /^\d{4}-\d{2}-\d{2}$/;
    if (!regex.test(dateString)) return false;

    const date = new Date(dateString);
    return !isNaN(date.getTime());
}

function isValidTimeString(timeString) {
    const regex = /^([01]?[0-9]|2[0-3]):[0-5][0-9]$/;
    return regex.test(timeString);
}