import mongoose from 'mongoose';
import Appointment from '../models/Appointment.js';
import MedicalEvent from '../models/MedicalEvent.js';
import Package from '../models/Package.js'; // Adicione esta importação
import Patient from '../models/Patient.js'; // Adicione esta importação
import Session from '../models/Session.js'; // Adicione esta importação

const DEFAULT_SPECIALTY_VALUES = {
    fonoaudiologia: 200,
    psicologia: 200,
    'terapia_ocupacional': 200,
    fisioterapia: 200,
    pediatria: 220,
    neuroped: 250,
    avaliacao: 250,
    unknown: 200
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
        return await withSyncRetry(async (retrySession) => {
            const specialty = await getSpecialty(originalDoc, type);
            const value = calculateValue(originalDoc, specialty);
            const confirmedAbsence = originalDoc.confirmedAbsence || false;

            let finalDate = originalDoc.date;

            if ((type === 'appointment' || type === 'session') && originalDoc.time) {
                const [hour, minute] = originalDoc.time.split(':').map(Number);
                const dateCopy = new Date(originalDoc.date);
                dateCopy.setHours(hour, minute, 0, 0);
                finalDate = dateCopy;
            }

            const updateData = {
                date: finalDate,
                time: originalDoc.time,
                doctor: safeObjectId(originalDoc.doctor),
                patient: safeObjectId(originalDoc.patient),
                specialty,
                value,
                operationalStatus: getOperationalStatus(originalDoc.operationalStatus || originalDoc.status),
                clinicalStatus: getClinicalStatus(originalDoc.clinicalStatus || originalDoc.status, confirmedAbsence),
                type,
                package: safeObjectId(originalDoc.package),  // ✅ Já retorna null se não existir
                relatedAppointment:
                    type === 'session' && originalDoc.appointmentId
                        ? safeObjectId(originalDoc.appointmentId)
                        : null
            };

            // ✅ REMOVER CAMPOS INVÁLIDOS (false, undefined)
            Object.keys(updateData).forEach(key => {
                if (updateData[key] === false || updateData[key] === undefined) {
                    delete updateData[key];
                }
            });

            if (type === 'appointment' &&
                originalDoc.serviceType === 'package_session' &&
                originalDoc.session) {

                const relatedSession = await Session.findById(originalDoc.session);
                if (relatedSession) {
                    await syncEvent(relatedSession, 'session', retrySession);
                }
            }

            // ✅ DESABILITAR runValidators TEMPORARIAMENTE (DEBUG)
            await MedicalEvent.findOneAndUpdate(
                { originalId: originalDoc._id, type },
                updateData,
                {
                    upsert: true,
                    session: retrySession,
                    new: true,
                    runValidators: false  // ✅ Desabilita validação por enquanto
                }
            );

            return true;
        }, originalDoc, type, session);

    } catch (error) {
        console.error('Erro na sincronização:', {
            error: error.message,
            docId: originalDoc._id,
            type,
            specialty: originalDoc.specialty || 'não definida',
            stack: error.stack
        });
        // ✅ NÃO propaga erro (não crítico)
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

