/* import mongoose from 'mongoose';

const sessionSchema = new mongoose.Schema({
    date: {
        type: Date,
        required: true,
        validate: {
            validator: (v) => v <= new Date(),
            message: 'Data não pode ser futura'
        }
    },
    professional: {
        type: String,
        required: true,
        minlength: 5
    },
    sessionType: {
        type: String,
        enum: ['fonoaudiologia', 'terapeuta ocupacional', 'psicologia', 'fisioterapia', 'psicomotricidade', 'musicoterapia', 'psicopedagogia'],
        required: true
    },
    notes: {
        type: String,
        maxlength: 500
    },
    isPaid: {
        type: Boolean,
        default: false
    }
});

const paymentSchema = new mongoose.Schema({
    amount: {
        type: Number,
        required: true,
        min: 0.01
    },
    date: {
        type: Date,
        default: Date.now,
        immutable: true
    },
    paymentMethod: {
        type: String,
        enum: ['dinheiro', 'pix', 'cartão'],
        required: true
    },
    coveredSessions: [{
        type: mongoose.Schema.Types.ObjectId,
        required: true,
        validate: {
            validator: function (v) {
                return this.parent().sessions.some(s => s._id.equals(v));
            },
            message: 'Sessão não existe no pacote'
        }
    }],
    notes: {
        type: String,
        maxlength: 200
    }
});

// Adicione validação de referência circular nos pagamentos
paymentSchema.pre('validate', function (next) {
    if (this.coveredSessions.some(s => !mongoose.isValidObjectId(s))) {
        return next(new Error('ID de sessão inválido'));
    }
    next();
});

const therapyPackageSchema = new mongoose.Schema({
    patientId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Patient',
        required: true,
        validate: {
            validator: (v) => mongoose.isValidObjectId(v),
            message: 'ID do paciente inválido'
        }
    },
    totalSessions: {
        type: Number,
        required: true,
        min: 1,
        validate: {
            validator: function (v) {
                return v >= this.sessions.length;
            },
            message: 'Total de sessões não pode ser menor que as já realizadas'
        }
    },
    sessions: [sessionSchema],
    payments: [paymentSchema],
    sessionValue: {
        type: Number,
        required: true,
        min: 0.01
    },
    status: {
        type: String,
        enum: ['active', 'finished', 'canceled'],
        default: 'active'
    },
    paymentType: {
        type: String,
        enum: ['full', 'per-session', 'partial'],
        required: true
    }
}, {
    timestamps: true,
    toJSON: { virtuals: true },
    toObject: { virtuals: true }
});

// Índices para performance
therapyPackageSchema.index({ 'sessions._id': 1 });
therapyPackageSchema.index({ 'payments.coveredSessions': 1 });

// Virtuals
therapyPackageSchema.virtual('sessionsDone').get(function () {
    return this.sessions.length;
});

therapyPackageSchema.virtual('totalPaid').get(function () {
    return parseFloat(this.payments.reduce((sum, p) => sum + p.amount, 0).toFixed(2));
});

therapyPackageSchema.virtual('balance').get(function () {
    return (this.sessionValue * this.totalSessions) - this.totalPaid;
});

// Middleware de atualização automática
therapyPackageSchema.post('save', async function (doc) {
    try {
        const paidSessions = [...new Set(doc.payments.flatMap(p => p.coveredSessions))];

        await TherapyPackage.updateOne(
            { _id: doc._id },
            {
                $set: {
                    "sessions.$[elem].isPaid": true
                }
            },
            {
                arrayFilters: [{ "elem._id": { $in: paidSessions } }],
                session: doc.$session() // Mantém a transação ativa
            }
        );

        if (doc.balance <= 0 && doc.status !== 'finished') {
            await TherapyPackage.updateOne(
                { _id: doc._id },
                { $set: { status: 'finished' } }
            );
        }
    } catch (error) {
        console.error('Erro pós-save:', error);
    }
});

export default mongoose.model('TherapyPackage', therapyPackageSchema); */