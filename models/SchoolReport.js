// models/SchoolReport.js
import mongoose from 'mongoose';

const schoolReportSchema = new mongoose.Schema({
    // Identificação
    type: {
        type: String,
        default: 'school'
    },
    title: {
        type: String,
        required: true,
        trim: true
    },
    schoolYear: {
        type: String, // Ex: "2024", "2024/2025"
        required: true
    },
    semester: {
        type: String,
        enum: ['1º', '2º', '3º', '4º', 'annual'],
        default: 'annual'
    },

    // Relacionamento com paciente
    patientId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Patient',
        required: true
    },
    patientName: {
        type: String,
        required: true
    },

    // Informações Escolares
    schoolInfo: {
        schoolName: {
            type: String,
            required: true
        },
        grade: {
            type: String,
            required: true // Ex: "2º ano", "3ª série"
        },
        teacher: String,
        schoolPhone: String,
        schoolEmail: String
    },

    // Desempenho Acadêmico
    academicPerformance: {
        portuguese: {
            performance: {
                type: String,
                enum: ['excellent', 'good', 'regular', 'poor', 'not_evaluated'],
                default: 'not_evaluated'
            },
            observations: String,
            specificSkills: {
                reading: String,
                writing: String,
                interpretation: String,
                oralExpression: String
            }
        },
        mathematics: {
            performance: {
                type: String,
                enum: ['excellent', 'good', 'regular', 'poor', 'not_evaluated'],
                default: 'not_evaluated'
            },
            observations: String,
            specificSkills: {
                calculations: String,
                problemSolving: String,
                logicalReasoning: String
            }
        },
        sciences: {
            performance: {
                type: String,
                enum: ['excellent', 'good', 'regular', 'poor', 'not_evaluated'],
                default: 'not_evaluated'
            },
            observations: String
        },
        history: {
            performance: {
                type: String,
                enum: ['excellent', 'good', 'regular', 'poor', 'not_evaluated'],
                default: 'not_evaluated'
            },
            observations: String
        },
        geography: {
            performance: {
                type: String,
                enum: ['excellent', 'good', 'regular', 'poor', 'not_evaluated'],
                default: 'not_evaluated'
            },
            observations: String
        },
        overallObservations: String
    },

    // Habilidades e Competências
    skills: {
        cognitive: {
            attention: String,
            memory: String,
            reasoning: String,
            concentration: String
        },
        social: {
            interactionPeers: String,
            interactionAdults: String,
            teamwork: String,
            conflictResolution: String
        },
        emotional: {
            selfControl: String,
            frustrationTolerance: String,
            selfEsteem: String,
            motivation: String
        }
    },

    // Comportamento e Adaptação
    behavior: {
        classroomParticipation: String,
        homeworkCompletion: String,
        organization: String,
        punctuality: String,
        followingRules: String
    },

    // Apoios e Adaptações
    support: {
        currentAdaptations: [String],
        neededAdaptations: [String],
        specializedSupport: String,
        familySupport: String,
        observations: String
    },

    // Recomendações e Metas
    recommendations: {
        strengths: [String],
        difficulties: [String],
        goals: [String],
        strategies: [String],
        familyGuidance: String,
        schoolGuidance: String
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
        enum: ['draft', 'completed', 'sent_to_school', 'reviewed'],
        default: 'completed'
    },

    // Controle de envio
    sentTo: {
        school: {
            sent: Boolean,
            sentAt: Date,
            sentTo: String, // Nome do responsável
            method: String // email, presencial, etc.
        },
        family: {
            sent: Boolean,
            sentAt: Date,
            receivedBy: String
        }
    },

    // Anexos (boletins, trabalhos, etc.)
    attachments: [{
        filename: String,
        originalName: String,
        mimetype: String,
        size: Number,
        url: String,
        uploadedAt: {
            type: Date,
            default: Date.now
        }
    }]
}, {
    timestamps: true
});

// Índices
schoolReportSchema.index({ patientId: 1, schoolYear: -1 });
schoolReportSchema.index({ 'schoolInfo.schoolName': 1 });
schoolReportSchema.index({ createdAt: -1 });

// Método para buscar relatórios escolares por paciente
schoolReportSchema.statics.findByPatient = function(patientId, options = {}) {
    const { page = 1, limit = 10, schoolYear } = options;
    const skip = (page - 1) * limit;
    
    let query = { patientId };
    if (schoolYear) {
        query.schoolYear = schoolYear;
    }
    
    return this.find(query)
        .sort({ schoolYear: -1, semester: -1 })
        .skip(skip)
        .limit(limit)
        .populate('patientId', 'fullName dateOfBirth gender')
        .populate('createdBy', 'name email')
        .exec();
};

// Método para buscar por escola
schoolReportSchema.statics.findBySchool = function(schoolName, options = {}) {
    const { page = 1, limit = 10 } = options;
    const skip = (page - 1) * limit;
    
    return this.find({ 'schoolInfo.schoolName': new RegExp(schoolName, 'i') })
        .sort({ schoolYear: -1 })
        .skip(skip)
        .limit(limit)
        .populate('patientId', 'fullName dateOfBirth')
        .exec();
};

// Virtual para calcular desempenho geral
schoolReportSchema.virtual('overallPerformance').get(function() {
    const performances = [];
    
    if (this.academicPerformance.portuguese.performance !== 'not_evaluated') {
        performances.push(this.academicPerformance.portuguese.performance);
    }
    if (this.academicPerformance.mathematics.performance !== 'not_evaluated') {
        performances.push(this.academicPerformance.mathematics.performance);
    }
    // Adicione outras matérias conforme necessário
    
    if (performances.length === 0) return 'not_evaluated';
    
    // Lógica simples para calcular média (pode ser refinada)
    const scoreMap = {
        'excellent': 4,
        'good': 3,
        'regular': 2,
        'poor': 1
    };
    
    const totalScore = performances.reduce((sum, perf) => sum + (scoreMap[perf] || 0), 0);
    const average = totalScore / performances.length;
    
    if (average >= 3.5) return 'excellent';
    if (average >= 2.5) return 'good';
    if (average >= 1.5) return 'regular';
    return 'poor';
});

// Middleware para gerar título se não fornecido
schoolReportSchema.pre('save', function(next) {
    if (!this.title) {
        this.title = `Relatório Escolar - ${this.patientName} - ${this.schoolInfo.grade} - ${this.schoolYear}`;
    }
    next();
});

// Método para marcar como enviado para escola
schoolReportSchema.methods.markAsSentToSchool = function(contactPerson, method = 'email') {
    this.sentTo.school = {
        sent: true,
        sentAt: new Date(),
        sentTo: contactPerson,
        method: method
    };
    this.status = 'sent_to_school';
    return this.save();
};

export default mongoose.model('SchoolReport', schoolReportSchema);