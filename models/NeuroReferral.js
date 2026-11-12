// models/NeuroReferral.js
// Indicação de paciente da casa para a consulta com neuropediatra (laudo TEA/TDAH). Ver constants/neuroReferral.js.
import mongoose from 'mongoose';
import {
    NEURO_REFERRAL_REASONS,
    NEURO_REFERRAL_SOURCES,
    NEURO_REFERRAL_STATUS,
} from '../constants/neuroReferral.js';

const actorSchema = new mongoose.Schema({
    id: { type: mongoose.Schema.Types.ObjectId, default: null },
    role: { type: String, default: null },
}, { _id: false });

const historySchema = new mongoose.Schema({
    status: { type: String, enum: NEURO_REFERRAL_STATUS, required: true },
    at: { type: Date, default: Date.now },
    by: { type: actorSchema, default: () => ({}) },
    note: { type: String, default: null },
}, { _id: false });

const neuroReferralSchema = new mongoose.Schema({
    patient: { type: mongoose.Schema.Types.ObjectId, ref: 'Patient', required: true, index: true },
    status: { type: String, enum: NEURO_REFERRAL_STATUS, default: 'indicado' },
    reasons: { type: [{ type: String, enum: NEURO_REFERRAL_REASONS }], default: [] },
    source: { type: String, enum: NEURO_REFERRAL_SOURCES, required: true },

    // Sugestão automática: o que foi encontrado e onde (queixa do paciente, do agendamento ou anamnese)
    matchedTerms: { type: [String], default: [] },
    matchedIn: { type: [String], default: [] },

    // Especialidades da casa em que o paciente é atendido (snapshot na criação, para filtrar a lista)
    homeSpecialties: { type: [String], default: [] },

    requestedBy: { type: actorSchema, default: () => ({}) },
    note: { type: String, trim: true, maxlength: 1000, default: null },

    offeredAt: { type: Date, default: null },
    scheduledAt: { type: Date, default: null },
    appointment: { type: mongoose.Schema.Types.ObjectId, ref: 'Appointment', default: null },
    closedAt: { type: Date, default: null },
    declineReason: { type: String, trim: true, maxlength: 500, default: null },

    // Preenchido SOMENTE enquanto o status é ativo (a_confirmar/indicado/oferecido) = id do paciente.
    // O índice único parcial garante, no banco, uma indicação ativa por paciente.
    activeKey: { type: String, default: undefined },

    history: { type: [historySchema], default: [] },
}, { timestamps: true });

neuroReferralSchema.index({ status: 1, updatedAt: -1 });
neuroReferralSchema.index(
    { activeKey: 1 },
    { unique: true, partialFilterExpression: { activeKey: { $type: 'string' } }, name: 'uniq_active_patient_neuro_referral' },
);

const NeuroReferral = mongoose.models.NeuroReferral
    || mongoose.model('NeuroReferral', neuroReferralSchema, 'neuro_referrals');

/** Em produção o autoIndex é off: chamar depois de conectar ao Mongo (ver server.js). */
export const ensureNeuroReferralIndexes = () => NeuroReferral.createIndexes();

export default NeuroReferral;
