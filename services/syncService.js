import mongoose from 'mongoose';
import Appointment from '../models/Appointment.js';
import MedicalEvent from '../models/MedicalEvent.js';
import Package from '../models/Package.js'; // Adicione esta importação
import Patient from '../models/Patient.js'; // Adicione esta importação
import Session from '../models/Session.js'; // Adicione esta importação
import { THERAPY_PRICING, PRICING } from '../config/pricing.js';

// Valores de repasse para profissionais (baseados nos preços de venda)
const DEFAULT_SPECIALTY_VALUES = {
    fonoaudiologia: THERAPY_PRICING.fonoaudiologia?.sessaoPacote || 180,
    psicologia: THERAPY_PRICING.psicologia?.sessaoPacote || 160,
    'terapia_ocupacional': THERAPY_PRICING.terapia_ocupacional?.sessaoPacote || 160,
    fisioterapia: THERAPY_PRICING.fisioterapia?.sessaoPacote || 160,
    pediatria: 220,
    neuroped: 250,
    avaliacao: PRICING.AVALIACAO_INICIAL || 200,
    unknown: PRICING.AVALIACAO_INICIAL || 200
};


// Configuração de retry
const MAX_SYNC_RETRIES = 5;
const RETRY_BASE_DELAY = 100; // ms

// ✅ Retry com backoff + reload do doc
async function withSyncRetry(operation, doc, type) {
    let lastError;

    for (let attempt = 1; attempt <= MAX_SYNC_RETRIES; attempt++) {
        const retrySession = await mongoose.startSession();
        try {
            await retrySession.startTransaction();
            const result = await operation(retrySession);
            await retrySession.commitTransaction();
            return result;
        } catch (error) {
            if (retrySession.inTransaction()) {
                await retrySession.abortTransaction();
            }

            lastError = error;

            // Só conflitos típicos do Mongo/txn
            if (![112, 251].includes(error.code)) throw error;

            console.warn(
                `[SYNC-RETRY] Tentativa ${attempt}/${MAX_SYNC_RETRIES} para ${doc?._id} (${type}) → ${error.message}`
            );

            const delay = RETRY_BASE_DELAY * Math.pow(2, attempt) + Math.random() * 100;
            await new Promise(r => setTimeout(r, delay));

            // Recarrega doc pra próxima tentativa
            if (type === 'appointment') {
                doc = await Appointment.findById(doc._id).lean();
            } else if (type === 'session') {
                doc = await Session.findById(doc._id).populate('package appointmentId').lean();
            } else if (type === 'package') {
                doc = await Package.findById(doc._id).lean();
            }
        } finally {
            retrySession.endSession();
        }
    }

    throw lastError;
}

const safeObjectId = (id) => {
    if (!id) return null;
    if (typeof id === 'string') return id;
    if (id instanceof mongoose.Types.ObjectId) return id.toString();  // ✅ converte pra string
    if (id._id) {
        if (typeof id._id === 'string') return id._id;
        if (id._id instanceof mongoose.Types.ObjectId) return id._id.toString();
    }
    return null;  // ✅ NUNCA retorna false
};

const getSpecialty = async (doc, type) => {
    // 1. Se já tiver specialty definida e válida
    if (doc.specialty && doc.specialty !== 'unknown') {
        return doc.specialty;
    }

    // 2. Para pagamentos, buscar specialty do appointment
    if (type === 'payment' && doc.appointment) {
        try {
            const appointment = await Appointment.findById(doc.appointment).lean();
            if (appointment?.specialty) return appointment.specialty;

            if (appointment?.patient) {
                const patient = await Patient.findById(appointment.patient).lean();
                return patient?.specialty || 'fonoaudiologia';
            }
        } catch (error) {
            console.error('Erro ao buscar specialty:', error);
        }
    }

    // 3. Tentar outras propriedades
    return doc.sessionType || doc.package?.sessionType || 'fonoaudiologia';
};

const calculateValue = (doc, specialty) => {
    if (typeof doc.sessionValue === 'number') return doc.sessionValue;
    if (typeof doc.value === 'number') return doc.value;
    if (doc.package?.sessionValue) return doc.package.sessionValue;
    return DEFAULT_SPECIALTY_VALUES[specialty] || DEFAULT_SPECIALTY_VALUES.unknown;
};

const getOperationalStatus = (status) => {
    if (!status) return 'scheduled';

    const normalized = status.toLowerCase();
    const statusMap = {
        // inglês → inglês (mantém)
        'completed': 'completed',
        'canceled': 'canceled',
        'scheduled': 'scheduled',
        'confirmed': 'confirmed',
        'paid': 'paid',
        'pending': 'pending',
        'missed': 'missed',

        // português → inglês (corrige dados existentes)
        'agendado': 'scheduled',
        'confirmed': 'confirmed',
        'canceled': 'canceled',
        'completed': 'completed',
        'missed': 'missed',
        'paid': 'paid',
        'pending': 'pending',
    };

    return statusMap[normalized] || 'scheduled';
};

// 🧠 Normaliza status clínico - MANTÉM INGLÊS
const getClinicalStatus = (status, confirmedAbsence = false) => {
    if (!status) return 'pending';

    const normalized = status.toLowerCase();

    const statusMap = {
        // inglês → inglês (mantém)
        'completed': 'completed',
        'in_progress': 'in_progress',
        'pending': 'pending',
        'missed': 'missed',
        'canceled': 'canceled',

        // português → inglês (corrige dados existentes)
        'completed': 'completed',
        'em_andamento': 'in_progress',
        'pending': 'pending',
        'faltou': 'missed',
        'canceled': 'canceled',
    };

    let result = statusMap[normalized] || 'pending';

    // Se a ausência foi confirmada, vira "missed" (inglês)
    if (confirmedAbsence && result === 'canceled') {
        result = 'missed';
    }

    return result;
};

// Função principal de sincronização refatorada
export const syncEvent = async (originalDoc, type, session = null) => {
    if (['payment', 'financial'].includes(type)) {
        return true;
    }

    try {
        // ✅ Sanitização profunda antes de tudo
        const cleanDoc = JSON.parse(JSON.stringify(originalDoc, (key, value) => {
            if (value === false) return null;
            return value;
        }));

        return await withSyncRetry(async (retrySession) => {
            const specialty = await getSpecialty(cleanDoc, type);
            const value = calculateValue(cleanDoc, specialty);
            const confirmedAbsence = cleanDoc.confirmedAbsence || false;

            let finalDate = cleanDoc.date;

            if ((type === 'appointment' || type === 'session') && cleanDoc.time) {
                const [hour, minute] = cleanDoc.time.split(':').map(Number);
                const dateCopy = new Date(cleanDoc.date);
                dateCopy.setHours(hour, minute, 0, 0);
                finalDate = dateCopy;
            }

            const updateData = {
                date: finalDate,
                time: cleanDoc.time,
                doctor: safeObjectId(cleanDoc.doctor),
                patient: safeObjectId(cleanDoc.patient),
                specialty,
                value,
                operationalStatus: getOperationalStatus(cleanDoc.operationalStatus || cleanDoc.status),
                clinicalStatus: getClinicalStatus(cleanDoc.clinicalStatus || cleanDoc.status, confirmedAbsence),
                type,
                package: safeObjectId(cleanDoc.package),
                relatedAppointment:
                    type === 'session' && cleanDoc.appointmentId
                        ? safeObjectId(cleanDoc.appointmentId)
                        : null
            };

            // ✅ Segunda camada de limpeza
            Object.keys(updateData).forEach(key => {
                if (updateData[key] === false || updateData[key] === undefined) {
                    delete updateData[key];
                }
            });

            await MedicalEvent.findOneAndUpdate(
                { originalId: cleanDoc._id, type },
                updateData,
                {
                    upsert: true,
                    session: retrySession,
                    new: true,
                    runValidators: false
                }
            );

            return true;
        }, cleanDoc, type, session);

    } catch (error) {
        console.error('Erro na sincronização:', {
            error: error.message,
            docId: originalDoc._id,
            type,
            specialty: originalDoc.specialty || 'não definida',
            stack: error.stack
        });
        return false;
    }
};



export const handlePackageSessionUpdate = async (appointment, action, user, details = {}) => {
    const session = await mongoose.startSession();

    try {
        await session.startTransaction();

        // 1. Atualizar a sessão relacionada com tratamento para history
        const sessionDoc = await Session.findById(appointment.session).session(session);
        if (!sessionDoc) throw new Error('Sessão não encontrada');

        // Inicializa history se não existir
        if (!sessionDoc.history) {
            sessionDoc.history = [];
        }

        // Cria entrada de histórico padrão
        const historyEntry = {
            action,
            changedBy: user._id,
            timestamp: new Date(),
            details: details.changes || {}
        };

        // 2. Lógica específica por ação
        switch (action) {
            case 'cancel':
                sessionDoc.status = 'canceled';
                sessionDoc.confirmedAbsence = details.changes?.confirmedAbsence || false;

                // Adiciona entrada específica de cancelamento
                sessionDoc.history.push({
                    ...historyEntry,
                    action: 'cancelamento',
                    details: {
                        reason: details.changes?.reason,
                        confirmedAbsence: details.changes?.confirmedAbsence
                    }
                });

                if (appointment.package) {
                    await adjustPackageSession(
                        appointment.package,
                        appointment._id,
                        'remove',
                        session
                    );
                }
                break;

            case 'change_package':
                if (details.previousData?.package) {
                    await adjustPackageSession(
                        details.previousData.package,
                        appointment._id,
                        'remove',
                        session
                    );
                }
                await adjustPackageSession(
                    details.changes.packageId,
                    appointment._id,
                    'add',
                    session
                );
                sessionDoc.history.push(historyEntry);
                break;

            case 'reschedule':
                if (details.changes?.date) sessionDoc.date = details.changes.date;
                if (details.changes?.time) sessionDoc.time = details.changes.time;
                sessionDoc.history.push(historyEntry);
                break;

            case 'update':
                if (details.changes?.status) sessionDoc.status = details.changes.status;
                sessionDoc.history.push(historyEntry);
                break;
        }

        await sessionDoc.save({ session });
        await syncEvent(sessionDoc, 'session');
        await session.commitTransaction();

    } catch (error) {
        await session.abortTransaction();
        console.error('Erro no handlePackageSessionUpdate:', {
            error: error.message,
            appointmentId: appointment?._id,
            sessionId: appointment?.session,
            action,
            stack: error.stack
        });
        throw error;
    } finally {
        await session.endSession();
    }
};

async function adjustPackageSession(packageId, appointmentId, operation, session) {
    const update = operation === 'add'
        ? { $inc: { remainingSessions: -1 }, $push: { sessions: appointmentId } }
        : { $inc: { remainingSessions: 1 }, $pull: { sessions: appointmentId } };

    const result = await Package.findByIdAndUpdate(packageId, update, { session });

    if (!result) throw new Error(`Pacote ${packageId} não encontrado`);
    if (operation === 'add' && result.remainingSessions <= 0) {
        throw new Error('Pacote sem sessões disponíveis');
    }
}

