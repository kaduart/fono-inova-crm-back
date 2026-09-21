// models/ConvenioWaitlist.js
import mongoose from 'mongoose';
import { CONVENIOS_WAITLIST, WAITLIST_STATUS } from '../constants/convenioWaitlist.js';

const submissionSchema = new mongoose.Schema({
    especialidade: { type: String, default: null },
    idadeCrianca: { type: Number, default: null },
    periodo: { type: String, default: null },
    at: { type: Date, default: Date.now },
}, { _id: false });

const convenioWaitlistSchema = new mongoose.Schema({
    name: { type: String, required: true, trim: true },
    phone: { type: String, required: true, trim: true }, // E.164 BR (ex.: 5562992013573)
    email: { type: String, trim: true, lowercase: true, default: null },

    convenio: { type: String, enum: CONVENIOS_WAITLIST, required: true },
    especialidade: { type: String, trim: true, default: null },
    idadeCrianca: { type: Number, min: 0, max: 18, default: null },
    periodo: { type: String, trim: true, default: null },

    status: { type: String, enum: WAITLIST_STATUS, default: 'aguardando' },
    notifiedAt: { type: Date, default: null }, // quando a equipe avisou/contatou a pessoa
    notes: { type: String, default: '' },

    // Cada vez que a pessoa reenvia o formulário (mesmo convênio) o registro é atualizado e o histórico fica aqui
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

export default mongoose.models.ConvenioWaitlist
    || mongoose.model('ConvenioWaitlist', convenioWaitlistSchema, 'convenio_waitlist');
