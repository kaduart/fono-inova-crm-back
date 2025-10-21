import mongoose from 'mongoose';

const paymentSchema = new mongoose.Schema({
    patient: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Patient',
        required: true,
    },
    doctor: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Doctor',
        required: true,
    },
    serviceType: {
        type: String,
        enum: [
            'evaluation',
            'session',
            'package_session',
            'individual_session',
            'meet',
            'alignment'
        ],
        required: true,
        default: 'session'
    },
    amount: {
        type: Number,
        required: true,
        min: 0.01
    },
    package: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Package',
        required: function () {
            return this.serviceType === 'package_session';
        },
        default: null
    },
    session: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Session',
    },
    appointment: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Appointment',
    },

    // 🔹 NOVOS CAMPOS
    kind: {
        type: String,
        enum: ['package_receipt', 'session_payment', 'manual', 'auto'],
        default: 'manual',
        description: 'Tipo de pagamento para rastreabilidade (ex: recibo do pacote ou pagamento unitário)'
    },
    parentPayment: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Payment',
        default: null,
        description: 'Se este pagamento foi gerado automaticamente a partir de outro'
    },

    paymentMethod: {
        type: String,
        enum: ['dinheiro', 'pix', 'cartao_credito', 'cartao_debito', 'transferencia_bancaria', 'outro'],
        required: true
    },
    status: {
        type: String,
        enum: ['pending', 'paid', 'partial', 'canceled', 'advanced', 'package_paid'],
        default: 'pending'
    },
    notes: {
        type: String,
    },
    sessionType: {
        type: String,
        enum: ['fonoaudiologia', 'terapia_ocupacional', 'psicologia', 'fisioterapia'],
    },
    serviceDate: {
        type: String,
        required: function () {
            return this.appointment;
        }
    },
    paymentDate: {
        type: String,
        required: true,
        default: () => new Date().toISOString().split('T')[0],
    },
    isAdvance: Boolean,

    sessions: [{
        session: { type: mongoose.Schema.Types.ObjectId, ref: 'Session' },
        appointment: { type: mongoose.Schema.Types.ObjectId, ref: 'Appointment' },
        status: {
            type: String,
            enum: ['scheduled', 'completed', 'canceled'],
            default: 'scheduled'
        },
        sessionDate: Date,
        usedAt: Date
    }],
    advanceSessions: [{
        session: { type: mongoose.Schema.Types.ObjectId, ref: 'Session' },
        appointment: { type: mongoose.Schema.Types.ObjectId, ref: 'Appointment' },
        used: Boolean,
        usedAt: Date,
        scheduledDate: Date
    }],

    createdAt: { type: Date, default: Date.now, index: true },
}, {
    timestamps: true,
    toObject: { virtuals: true },
    toJSON: { virtuals: true }
});


paymentSchema.pre('save', async function (next) {
    // 🚫 Ignora pagamentos do novo fluxo de pacotes
    if (['package_receipt', 'session_payment'].includes(this.kind)) {
        return next();
    }

    // 🔹 Continua o comportamento antigo para sessões avulsas
    if (!this.appointment && !this.package) {
        try {
            const filter = {
                patient: this.patient,
                doctor: this.doctor,
                date: {
                    $gte: new Date(this.createdAt.getTime() - 3 * 24 * 60 * 60 * 1000),
                    $lte: new Date(this.createdAt.getTime() + 3 * 24 * 60 * 60 * 1000)
                },
                payment: { $exists: false }
            };
            const appointment = await mongoose.model('Appointment').findOne(filter);
            if (appointment) {
                this.appointment = appointment._id;
                await mongoose.model('Appointment').findByIdAndUpdate(appointment._id, {
                    $set: { payment: this._id, operationalStatus: 'paid' }
                });
            }
        } catch (error) {
            console.error('Erro no pre-save Payment:', error.message);
        }
    }

    next();
});

paymentSchema.post('save', async function (doc) {
    try {
        const Appointment = mongoose.model('Appointment');
        const Session = mongoose.model('Session');
        const Package = mongoose.model('Package');

        // 🩵 Caso 1: Pagamento de sessão ou avaliação (avulso)
        if (doc.appointment) {
            const appointment = await Appointment.findById(doc.appointment);
            if (appointment) {
                if (appointment.operationalStatus === 'canceled') {
                    // 🚫 Não marcar como pago se o agendamento foi cancelado
                    await Appointment.findByIdAndUpdate(appointment._id, {
                        paymentStatus: 'canceled'
                    });
                    return;
                }

                const statusMap = { paid: 'paid', pending: 'pending', canceled: 'canceled' };
                await Appointment.findByIdAndUpdate(
                    doc.appointment,
                    { paymentStatus: statusMap[doc.status] || 'pending' },
                    { new: true }
                );
            }
        }

        // 💰 Caso 2: Pagamento distribuído via pacote (novo fluxo)
        if (['package_receipt', 'session_payment'].includes(doc.kind)) {
            if (doc.session) {
                const session = await Session.findById(doc.session);
                if (session) {
                    // 🔹 Sessões canceladas não podem ficar pagas
                    if (session.status === 'canceled' || session.operationalStatus === 'canceled') {
                        session.isPaid = false;
                        session.paymentStatus = 'canceled';
                        session.visualFlag = 'blocked';
                        await session.save();
                        return;
                    }

                    // 🔹 Atualiza sessão normalmente
                    session.paymentStatus = doc.status === 'paid' ? 'paid' : 'partial';
                    session.isPaid = doc.status === 'paid';
                    await session.save();

                    // 🔹 Atualiza o agendamento vinculado, se houver
                    if (session.appointmentId) {
                        await Appointment.findByIdAndUpdate(
                            session.appointmentId,
                            { paymentStatus: session.paymentStatus },
                            { new: true }
                        );
                    }
                }
            }

            // 🔹 Atualiza o pacote como um todo
            if (doc.package) {
                const pkg = await Package.findById(doc.package);
                if (pkg) {
                    const expectedTotal = pkg.totalSessions * pkg.sessionValue;
                    pkg.financialStatus =
                        pkg.totalPaid >= expectedTotal
                            ? 'paid'
                            : pkg.totalPaid > 0
                                ? 'partially_paid'
                                : 'unpaid';
                    await pkg.save();
                }
            }
        }
    } catch (error) {
        console.error('❌ Erro no post-save Payment:', error.message);
    }
});



const Payment = mongoose.model('Payment', paymentSchema);
export default Payment;
