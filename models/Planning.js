// models/Planning.js
import mongoose from 'mongoose';

const planningSchema = new mongoose.Schema({
    type: {
        type: String,
        enum: ['daily', 'weekly', 'monthly'],
        required: true,
        index: true
    },

    // Período de referência
    period: {
        start: { type: String, required: true }, // 'YYYY-MM-DD'
        end: { type: String, required: true },   // 'YYYY-MM-DD'
    },

    // 🔹 Metas operacionais
    targets: {
        totalSessions: { type: Number, default: 0 },      // ex: 120 sessões/mês
        workHours: { type: Number, default: 0 },          // ex: 160h/mês
        availableSlots: { type: Number, default: 0 },     // ex: 40 vagas/semana
        expectedRevenue: { type: Number, default: 0 },    // ex: R$ 20.000/mês
    },

    // 🔹 Execução real (preenchido automaticamente)
    actual: {
        completedSessions: { type: Number, default: 0 },
        workedHours: { type: Number, default: 0 },
        usedSlots: { type: Number, default: 0 },
        actualRevenue: { type: Number, default: 0 },
    },

    // 🔹 Progresso calculado
    progress: {
        sessionsPercentage: { type: Number, default: 0 },    // (actual / target) * 100
        hoursPercentage: { type: Number, default: 0 },
        slotsPercentage: { type: Number, default: 0 },
        revenuePercentage: { type: Number, default: 0 },
        overallStatus: {
            type: String,
            enum: ['on_track', 'at_risk', 'behind', 'achieved'],
            default: 'on_track'
        }
    },

    // 🔹 Distribuição por profissional (opcional)
    byDoctor: [{
        doctor: { type: mongoose.Schema.Types.ObjectId, ref: 'Doctor' },
        targetSessions: { type: Number, default: 0 },
        completedSessions: { type: Number, default: 0 },
        targetHours: { type: Number, default: 0 },
        workedHours: { type: Number, default: 0 }
    }],

    // 🔹 Distribuição por especialidade
    bySpecialty: [{
        specialty: { type: String },
        targetSessions: { type: Number, default: 0 },
        completedSessions: { type: Number, default: 0 }
    }],

    notes: { type: String, maxlength: 500 },

    createdBy: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
        required: true
    },

    createdAt: { type: Date, default: Date.now },
    updatedAt: { type: Date, default: Date.now }
}, {
    timestamps: true
});

// Índices compostos
planningSchema.index({ type: 1, 'period.start': 1, 'period.end': 1 });
planningSchema.index({ 'progress.overallStatus': 1 });

// Middleware: calcular progresso antes de salvar
planningSchema.pre('save', function (next) {
    const { targets, actual } = this;

    this.progress.sessionsPercentage = targets.totalSessions > 0
        ? Math.round((actual.completedSessions / targets.totalSessions) * 100)
        : 0;

    this.progress.hoursPercentage = targets.workHours > 0
        ? Math.round((actual.workedHours / targets.workHours) * 100)
        : 0;

    this.progress.slotsPercentage = targets.availableSlots > 0
        ? Math.round((actual.usedSlots / targets.availableSlots) * 100)
        : 0;

    this.progress.revenuePercentage = targets.expectedRevenue > 0
        ? Math.round((actual.actualRevenue / targets.expectedRevenue) * 100)
        : 0;

    // Status geral (média das 4 métricas)
    const avgProgress = (
        this.progress.sessionsPercentage +
        this.progress.hoursPercentage +
        this.progress.revenuePercentage
    ) / 3;

    if (avgProgress >= 100) this.progress.overallStatus = 'achieved';
    else if (avgProgress >= 80) this.progress.overallStatus = 'on_track';
    else if (avgProgress >= 60) this.progress.overallStatus = 'at_risk';
    else this.progress.overallStatus = 'behind';

    this.updatedAt = new Date();
    next();
});

const Planning = mongoose.model('Planning', planningSchema);
export default Planning;