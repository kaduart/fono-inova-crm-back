import mongoose from 'mongoose';

const therapyProtocolSchema = new mongoose.Schema({
    code: {
        type: String,
        unique: true,
        required: true,
        uppercase: true,
        trim: true,
        index: true
    },
    name: {
        type: String,
        required: true,
        trim: true
    },
    specialty: {
        type: String,
        required: true,
        enum: ['Psicologia', 'Fonoaudiologia', 'Terapia Ocupacional', 'Fisioterapia']
    },
    applicableAreas: [{
        type: String,
        enum: ['language', 'motor', 'cognitive', 'behavior', 'social']
    }],
    description: {
        type: String,
        trim: true
    },
    typicalDuration: {
        type: String,
        default: '12-16 sessões'
    },
    keyTechniques: [{
        type: String,
        trim: true
    }],
    measurableGoals: [{
        type: String,
        trim: true
    }],
    references: [{
        title: String,
        url: String,
        type: { type: String, enum: ['article', 'book', 'video'] }
    }],
    usageCount: {
        type: Number,
        default: 0,
        min: 0
    },
    successRate: {
        type: Number,
        default: 0,
        min: 0,
        max: 100
    },
    averageSessionsToGoal: {
        type: Number,
        default: 0
    },
    active: {
        type: Boolean,
        default: true
    },
    createdBy: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User'
    }
}, {
    timestamps: true
});

// ✅ Índices declarados nos campos acima (code já tem index: true)
therapyProtocolSchema.index({ specialty: 1, active: 1 });
therapyProtocolSchema.index({ applicableAreas: 1 });

// Middleware para incrementar usageCount
therapyProtocolSchema.methods.incrementUsage = function () {
    this.usageCount += 1;
    return this.save();
};

const TherapyProtocol = mongoose.model('TherapyProtocol', therapyProtocolSchema);
export default TherapyProtocol;