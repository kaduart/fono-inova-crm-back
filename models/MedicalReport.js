// models/MedicalReport.js
import mongoose from 'mongoose';

const medicalReportSchema = new mongoose.Schema({
    // Identificação básica
    type: {
        type: String,
        required: true,
        enum: ['medical', 'progress', 'evolution', 'assessment'],
        default: 'medical'
    },
    title: {
        type: String,
        required: true,
        trim: true
    },
    summary: {
        type: String,
        trim: true
    },

    // Relacionamento com paciente
    patientId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Patient',
        required: true
    },
    patientName: {
        type: String,
        required: true,
        trim: true
    },
    patientAge: {
        type: Number
    },

    // Dados do relatório
    date: {
        type: Date,
        required: true,
        default: Date.now
    },
    content: {
        // Estrutura flexível para diferentes tipos de relatório
        diagnosis: String,
        observations: String,
        progress: String,
        goals: String,
        recommendations: String,
        nextSteps: String,
        // Campos dinâmicos
        customFields: mongoose.Schema.Types.Mixed
    },

    // Metadados
    createdBy: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
        required: true
    },
    createdByName: {
        type: String,
        required: true
    },
    status: {
        type: String,
        enum: ['draft', 'completed', 'archived'],
        default: 'completed'
    },

    // Controle de versão se necessário
    version: {
        type: Number,
        default: 1
    },
    previousVersion: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'MedicalReport'
    }
}, {
    timestamps: true // Cria createdAt e updatedAt automaticamente
});

// Índices para performance
medicalReportSchema.index({ patientId: 1, date: -1 });
medicalReportSchema.index({ type: 1, status: 1 });
medicalReportSchema.index({ createdAt: -1 });

// Método estático para buscar relatórios por paciente com paginação
medicalReportSchema.statics.findByPatient = function(patientId, options = {}) {
    const { page = 1, limit = 10, type } = options;
    const skip = (page - 1) * limit;
    
    let query = { patientId };
    if (type && type !== 'all') {
        query.type = type;
    }
    
    return this.find(query)
        .sort({ date: -1 })
        .skip(skip)
        .limit(limit)
        .populate('patientId', 'fullName dateOfBirth gender')
        .populate('createdBy', 'name email')
        .exec();
};

// Método para calcular estatísticas do paciente
medicalReportSchema.statics.getPatientStats = function(patientId) {
    return this.aggregate([
        { $match: { patientId: new mongoose.Types.ObjectId(patientId) } },
        {
            $group: {
                _id: '$type',
                count: { $sum: 1 },
                lastReport: { $max: '$date' },
                firstReport: { $min: '$date' }
            }
        }
    ]);
};

// Middleware para atualizar updatedAt antes de salvar
medicalReportSchema.pre('save', function(next) {
    this.updatedAt = Date.now();
    next();
});

// Virtual para idade do paciente na data do relatório (se necessário)
medicalReportSchema.virtual('patientAgeAtReport').get(function() {
    if (!this.patientId?.dateOfBirth || !this.date) return null;
    
    const birthDate = new Date(this.patientId.dateOfBirth);
    const reportDate = new Date(this.date);
    let age = reportDate.getFullYear() - birthDate.getFullYear();
    
    const monthDiff = reportDate.getMonth() - birthDate.getMonth();
    if (monthDiff < 0 || (monthDiff === 0 && reportDate.getDate() < birthDate.getDate())) {
        age--;
    }
    
    return age;
});

export default mongoose.model('MedicalReport', medicalReportSchema);