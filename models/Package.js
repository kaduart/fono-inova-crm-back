import mongoose from 'mongoose';
import { syncEvent } from '../services/syncService.js';
import MedicalEvent from './MedicalEvent.js';
//delete mongoose.connection.models['Package'];
const packageSchema = new mongoose.Schema({
    version: { type: Number, default: 0 },
    durationMonths: { // Novo campo (1-12)
        type: Number,
        required: true,
        min: 1,
        max: 12
    },
    sessionsPerWeek: { // Novo campo (1-5)
        type: Number,
        required: true,
        min: 1,
        max: 5
    },
    patient: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Patient',
        required: true
    },
    doctor: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Doctor',
        required: [true, 'Profissional é obrigatório'],
        validate: {
            validator: async (value) => {
                const doctor = await mongoose.model('Doctor').findById(value);
                return !!doctor;
            },
            message: 'Profissional inválido ou não encontrado'
        }
    },
    paymentMethod: {
        type: String,
        required: false,
    },
    paymentType: {
        type: String,
        required: false,
    },
    sessionType: {
        type: String,
        enum: ['fonoaudiologia', 'terapeuta ocupacional', 'psicologia', 'fisioterapia'],
        required: true
    },
    sessionValue: {
        type: Number,
        required: false,
        default: 200,
        min: [0.01, 'O valor deve ser maior que zero']
    },
    totalSessions: {
        type: Number,
        required: false,
        default: 1,
        min: [1, 'Deve ter pelo menos 1 sessão']
    },
    sessions: [{
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Session'
    }],
    date: {
        type: Date,
        required: [true, 'Data é obrigatória']
    },
    time: {
        type: String,
    },
    sessionsDone: {
        type: Number,
        default: 0
    },
    payments: [{
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Payment'
    }],
    status: {
        type: String,
        enum: ['active', 'in-progress', 'completed'],
        default: 'active'
    },
    totalPaid: { type: Number, default: 0 },
    balance: { type: Number, default: 0 },
    credit: {
        type: Number,
        default: 0
    },
    specialty: {
        type: String,
        required: true,
        enum: ['fonoaudiologia', 'terapeuta ocupacional', 'psicologia', 'fisioterapia', 'pediatria', 'neuroped'],

    },
});

packageSchema.pre('save', function (next) {

    // Calcular total de sessões (4 semanas ≈ 1 mês)
    this.totalSessions = this.durationMonths * 4 * this.sessionsPerWeek;

    // Definir valor por sessão
    // this.sessionValue = this.durationMonths > 2 ? 180 : 200;

    // Calcular valor total do pacote
    this.balance = (this.totalSessions * this.sessionValue) - this.totalPaid;

    next();
});

// package.model.js
packageSchema.post('save', async function (doc) {
    try {
        // Passo 1: Vincular pacote ao paciente
        const patient = await mongoose.model('Patient').findById(doc.patient);

        if (patient && !patient.packages.includes(doc._id)) {
            await mongoose.model('Patient').updateOne(
                { _id: doc.patient },
                { $addToSet: { packages: doc._id } }
            );
        }

        // Passo 2: Criar sessões automaticamente (se necessário)
        if (doc.isNew) {
            const sessions = [];
            for (let i = 0; i < doc.totalSessions; i++) {
                const session = await mongoose.model('Session').create({
                    package: doc._id,
                    status: 'pending',
                    sessionValue: doc.sessionValue,
                    specialty: doc.specialty
                });
                sessions.push(session._id);
            }

            // Atualizar pacote com IDs das sessões
            await mongoose.model('Package').updateOne(
                { _id: doc._id },
                { $set: { sessions } }
            );
        }

        // Passo 3: Chamar seu sistema de eventos existente
        await syncEvent(doc, 'package');

    } catch (error) {
        console.error(`[Package Post-Save Error] ${error.message}`);
        // Adicione aqui sua lógica de tratamento de erros
    }
});

packageSchema.pre('findOneAndUpdate', function (next) {
    const update = this.getUpdate();

    // Incrementar versão em operações de atualização
    if (update && !update.$inc) {
        update.$inc = { version: 1 };
    } else if (update.$inc && !update.$inc.version) {
        update.$inc.version = 1;
    } else if (update.$inc && update.$inc.version) {
        update.$inc.version += 1;
    }

    next();
});

packageSchema.post('findOneAndUpdate', async function (doc) {
    if (doc) {
        // Obter a versão atualizada
        const updatedDoc = await this.model.findOne(this.getQuery());
        await syncEvent(updatedDoc, 'package');
    }
});


packageSchema.post('findOneAndDelete', async function (doc) {
    if (doc) {
        await MedicalEvent.deleteOne({
            originalId: doc._id,
            type: 'package'
        });
    }
});

packageSchema.virtual('remainingSessions').get(function () {
    return this.totalSessions - this.sessionsDone;
});


packageSchema.set('toJSON', { virtuals: true });
packageSchema.set('toObject', { virtuals: true });

packageSchema.set('strict', 'throw');

packageSchema.set('strict', 'throw');
const Package = mongoose.model('Package', packageSchema);
export default Package;
