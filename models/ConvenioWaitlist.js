// models/ConvenioWaitlist.js
import mongoose from 'mongoose';
import { CONVENIOS_WAITLIST, WAITLIST_STATUS } from '../constants/convenioWaitlist.js';

const submissionSchema = new mongoose.Schema({
    especialidade: { type: String, default: null },
    idadeCrianca: { type: Number, default: null },
    periodo: { type: String, default: null },
    consentVersion: { type: String, default: null },
    at: { type: Date, default: Date.now },
}, { _id: false });

const convenioWaitlistSchema = new mongoose.Schema({
    name: { type: String, required: true, trim: true },
    phone: { type: String, required: true, trim: true }, // E.164 BR (ex.: 5562992013573)
    email: { type: String, trim: true, lowercase: true, default: null }, // opcional

    convenio: { type: String, enum: CONVENIOS_WAITLIST, required: true },
    especialidade: { type: String, trim: true, default: null },
    idadeCrianca: { type: Number, min: 0, max: 18, default: null },
    periodo: { type: String, trim: true, default: null },

    status: { type: String, enum: WAITLIST_STATUS, default: 'aguardando' },
    // Preenchido SOMENTE enquanto o status é ativo (aguardando/contatado): `${phone}:${convenio}`.
    // O índice único parcial abaixo garante, no banco, um cadastro ativo por telefone + convênio.
    activeKey: { type: String, default: undefined },
    notifiedAt: { type: Date, default: null }, // quando a equipe entrou em contato
    notes: { type: String, default: '' },

    // Consentimento de contato + privacidade (obrigatório no cadastro). Data é a do servidor.
    consent: {
        accepted: { type: Boolean, default: false },
        acceptedAt: { type: Date, default: null },
        version: { type: String, default: null },
    },

    // Cada reenvio (mesmo convênio) atualiza o registro ativo e o histórico fica aqui
    requestCount: { type: Number, default: 1 },
    submissions: { type: [submissionSchema], default: [] },

    source: {
        pagePath: { type: String, default: null },
        utmSource: { type: String, default: null },
        utmMedium: { type: String, default: null },
        utmCampaign: { type: String, default: null },
        referrer: { type: String, default: null },
        deviceType: { type: String, default: null },
        ga4ClientId: { type: String, default: null },
    },
}, { timestamps: true });

convenioWaitlistSchema.index({ phone: 1, convenio: 1 });
convenioWaitlistSchema.index({ convenio: 1, status: 1, createdAt: -1 });
convenioWaitlistSchema.index(
    { activeKey: 1 },
    { unique: true, partialFilterExpression: { activeKey: { $type: 'string' } }, name: 'uniq_active_phone_convenio' },
);

const ConvenioWaitlist = mongoose.models.ConvenioWaitlist
    || mongoose.model('ConvenioWaitlist', convenioWaitlistSchema, 'convenio_waitlist');

/**
 * Em produção o server.js conecta com autoIndex desligado, então o índice único NÃO seria criado
 * sozinho. Chamar depois de conectar ao Mongo (ver server.js).
 */
export const ensureConvenioWaitlistIndexes = () => ConvenioWaitlist.createIndexes();

export default ConvenioWaitlist;
