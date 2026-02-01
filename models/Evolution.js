import mongoose from 'mongoose';

const evolutionSchema = new mongoose.Schema({
    // ========== CAMPOS EXISTENTES (MANTIDOS) ==========
    patient: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Patient',
        required: true,
        index: true
    },
    doctor: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Doctor',
        required: true,
        index: true
    },
    date: {
        type: Date,
        required: true,
        index: true
    },
    time: {
        type: String
    },
    valuePaid: {
        type: String
    },
    sessionType: {
        type: String
    },
    paymentType: {
        type: String
    },
    appointmentId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Appointment'
    },
    plan: {
        type: String,
        default: ""
    },
    pdfUrl: {
        type: String
    },
    evaluationTypes: [{
        type: String,
        trim: true
    }],
    metrics: [{
        name: String,
        value: Number,
        unit: String,
        notes: String
    }],
    evaluationAreas: [{
        id: String,
        name: String,
        score: {
            type: Number,
            min: 0,
            max: 10
        }
    }],
    specialty: {
        type: String,
        required: true
    },
    createdBy: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
        required: true
    },
    content: {
        type: mongoose.Schema.Types.Mixed
    },
    observations: String,
    treatmentStatus: {
        type: String,
        enum: ['initial_evaluation', 'in_progress', 'improving', 'stable', 'regressing', 'completed'],
        default: 'in_progress'
    },

    // ========== NOVOS CAMPOS (PLANO TERAPÊUTICO) ==========
    therapeuticPlan: {
        protocol: {
            code: {
                type: String,
                uppercase: true,
                trim: true
            },
            name: String,
            customNotes: String
        },
        objectives: [{
            area: {
                type: String,
                required: true,
                trim: true
            },
            description: {
                type: String,
                required: true,
                trim: true
            },
            targetScore: {
                type: Number,
                min: 0,
                max: 10
            },
            currentScore: {
                type: Number,
                min: 0,
                max: 10
            },
            targetDate: Date,
            achieved: {
                type: Boolean,
                default: false
            },
            achievedDate: Date,
            progress: {
                type: Number,
                min: 0,
                max: 100,
                default: 0
            },
            notes: String
        }],
        interventions: [{
            description: {
                type: String,
                required: true,
                trim: true
            },
            frequency: String,
            responsible: {
                type: String,
                enum: ['therapist', 'family', 'school', 'combined'],
                default: 'therapist'
            },
            status: {
                type: String,
                enum: ['active', 'completed', 'paused', 'cancelled'],
                default: 'active'
            },
            startDate: Date,
            endDate: Date,
            notes: String
        }],
        reviewDate: Date,
        lastReviewDate: Date,
        planVersion: {
            type: Number,
            default: 1,
            min: 1
        },
        versionHistory: [{
            version: Number,
            changedAt: Date,
            changedBy: {
                type: mongoose.Schema.Types.ObjectId,
                ref: 'User'
            },
            changes: String,
            previousData: mongoose.Schema.Types.Mixed
        }]
    },

    // Facilita queries por protocolo
    activeProtocols: [{
        type: String
    }]

}, {
    timestamps: true
});

// ========== ÍNDICES ==========
evolutionSchema.index({ patient: 1, date: -1 });
evolutionSchema.index({ doctor: 1, date: -1 });
evolutionSchema.index({ specialty: 1 });
evolutionSchema.index({ treatmentStatus: 1 });
evolutionSchema.index({ 'therapeuticPlan.protocol.code': 1 });
evolutionSchema.index({ activeProtocols: 1 });
evolutionSchema.index({ createdAt: -1 });

// ========== MÉTODOS ==========

// Calcula progresso dos objetivos automaticamente
evolutionSchema.methods.calculateObjectivesProgress = function () {
    if (!this.therapeuticPlan?.objectives) return this;

    this.therapeuticPlan.objectives.forEach(obj => {
        if (obj.targetScore && obj.currentScore !== undefined) {
            obj.progress = Math.round((obj.currentScore / obj.targetScore) * 100);

            // Marca como atingido se chegou na meta
            if (obj.currentScore >= obj.targetScore && !obj.achieved) {
                obj.achieved = true;
                obj.achievedDate = new Date();
            }
        }
    });

    return this;
};

// Incrementa versão do plano quando houver mudanças significativas
evolutionSchema.methods.incrementPlanVersion = function (userId, changes) {
    if (!this.therapeuticPlan) {
        this.therapeuticPlan = { planVersion: 1, versionHistory: [] };
    }

    const previousData = {
        protocol: this.therapeuticPlan.protocol,
        objectives: this.therapeuticPlan.objectives,
        interventions: this.therapeuticPlan.interventions
    };

    this.therapeuticPlan.planVersion += 1;
    this.therapeuticPlan.versionHistory.push({
        version: this.therapeuticPlan.planVersion,
        changedAt: new Date(),
        changedBy: userId,
        changes: changes,
        previousData: previousData
    });

    return this;
};

// Pre-save hook para atualizar activeProtocols
evolutionSchema.pre('save', function (next) {
    if (this.therapeuticPlan?.protocol?.code) {
        this.activeProtocols = [this.therapeuticPlan.protocol.code];
    }
    next();
});

const Evolution = mongoose.model('Evolution', evolutionSchema);
export default Evolution;