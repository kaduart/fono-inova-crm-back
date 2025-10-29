// models/AnamnesisReport.js
import mongoose from 'mongoose';

const anamnesisReportSchema = new mongoose.Schema({
    // Identificação
    type: {
        type: String,
        default: 'anamnesis'
    },
    title: {
        type: String,
        default: 'Ficha de Anamnese'
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

    // Dados da Anamnese - Seção 1: Identificação e Queixa Principal
    identification: {
        interviewDate: {
            type: Date,
            default: Date.now
        },
        interviewer: String,
        mainComplaint: String,
        complaintDuration: String,
        complaintEvolution: String
    },

    // Seção 2: Histórico Médico
    medicalHistory: {
        pregnancy: String,
        birth: String,
        birthWeight: String,
        birthHeight: String,
        motorDevelopment: String,
        languageDevelopment: String,
        medicalConditions: String,
        hospitalizations: String,
        surgeries: String,
        allergies: String,
        medications: String,
        complementaryExams: String
    },

    // Seção 3: Histórico Familiar
    familyHistory: {
        parents: {
            mother: {
                age: Number,
                education: String,
                occupation: String,
                health: String
            },
            father: {
                age: Number,
                education: String,
                occupation: String,
                health: String
            }
        },
        siblings: [{
            age: Number,
            gender: String,
            health: String,
            development: String
        }],
        familyDiseases: String,
        geneticConditions: String
    },

    // Seção 4: Desenvolvimento
    development: {
        gestationalAge: String,
        prenatalCare: String,
        deliveryType: String, // normal, cesárea, etc.
        apgarScore: String,
        firstWordsAge: String,
        phraseFormationAge: String,
        currentSpeech: String,
        socialInteraction: String,
        playHabits: String
    },

    // Seção 5: Hábitos
    habits: {
        feeding: String,
        sleep: String,
        elimination: String, // Controle esfíncteres
        oralHabits: String, // Chupeta, dedo, etc.
        screenTime: String
    },

    // Seção 6: Escolar
    school: {
        attendsSchool: Boolean,
        schoolName: String,
        grade: String,
        teacher: String,
        performance: String,
        difficulties: String,
        relationshipPeers: String,
        relationshipTeachers: String,
        adaptations: String
    },

    // Seção 7: Observações Comportamentais
    behavior: {
        generalAppearance: String,
        attention: String,
        concentration: String,
        behaviorDuringAssessment: String,
        cooperation: String,
        emotionalState: String
    },

    // Seção 8: Hipóteses e Encaminhamentos
    conclusions: {
        diagnosticHypotheses: String,
        recommendations: String,
        referrals: String,
        observations: String,
        nextAppointment: Date
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
        enum: ['draft', 'completed', 'reviewed'],
        default: 'completed'
    },

    // Assinaturas (se necessário)
    signatures: {
        professional: {
            name: String,
            license: String,
            signature: String, // URL ou base64
            date: Date
        },
        guardian: {
            name: String,
            relationship: String,
            signature: String,
            date: Date
        }
    }
}, {
    timestamps: true
});

// Índices
anamnesisReportSchema.index({ patientId: 1, createdAt: -1 });
anamnesisReportSchema.index({ 'identification.interviewDate': -1 });

// Método para buscar anamneses por paciente
anamnesisReportSchema.statics.findByPatient = function(patientId, options = {}) {
    const { page = 1, limit = 10 } = options;
    const skip = (page - 1) * limit;
    
    return this.find({ patientId })
        .sort({ 'identification.interviewDate': -1 })
        .skip(skip)
        .limit(limit)
        .populate('patientId', 'fullName dateOfBirth gender phone email')
        .populate('createdBy', 'name email specialization')
        .exec();
};

// Virtual para idade do paciente na data da entrevista
anamnesisReportSchema.virtual('patientAgeAtInterview').get(function() {
    if (!this.patientId?.dateOfBirth || !this.identification?.interviewDate) return null;
    
    const birthDate = new Date(this.patientId.dateOfBirth);
    const interviewDate = new Date(this.identification.interviewDate);
    let age = interviewDate.getFullYear() - birthDate.getFullYear();
    
    const monthDiff = interviewDate.getMonth() - birthDate.getMonth();
    if (monthDiff < 0 || (monthDiff === 0 && interviewDate.getDate() < birthDate.getDate())) {
        age--;
    }
    
    return age;
});

// Método para gerar resumo automático
anamnesisReportSchema.methods.generateSummary = function() {
    const complaint = this.identification?.mainComplaint || 'Queixa não especificada';
    const age = this.patientAgeAtInterview;
    
    return `Anamnese - ${this.patientName} (${age} anos): ${complaint.substring(0, 100)}${complaint.length > 100 ? '...' : ''}`;
};

// Middleware para preencher automaticamente o título
anamnesisReportSchema.pre('save', function(next) {
    if (!this.title || this.title === 'Ficha de Anamnese') {
        this.title = `Anamnese - ${this.patientName} - ${new Date(this.identification?.interviewDate || Date.now()).toLocaleDateString('pt-BR')}`;
    }
    next();
});

export default mongoose.model('AnamnesisReport', anamnesisReportSchema);