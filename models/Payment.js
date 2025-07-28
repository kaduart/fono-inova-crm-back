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
        enum: ['evaluation', 'session', 'package_session', 'individual_session'],
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
        /*   required: function () {
              return this.serviceType === 'session' || this.serviceType === 'individual_session;
          } */
    },
    paymentMethod: {
        type: String,
        enum: ['dinheiro', 'pix', 'cartão'],
        required: true
    },
    status: {
        type: String,
        enum: ['pending', 'paid', 'canceled'],
        default: 'pending'
    },
    notes: {
        type: String,
    },
    createdAt: {
        type: Date,
        default: Date.now,
        index: true
    },
    appointment: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Appointment',
        required: function () {
            // Só obrigatório para pagamentos individuais
            return this.serviceType !== 'package_session';
        }
    },
    sessionType: {
        type: String,
        enum: ['current', 'current_plus_future'],
        default: 'current'
    },
    sessions: [{
        session: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'Session'
        },
        appointment: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'Appointment'
        },
        status: {
            type: String,
            enum: ['scheduled', 'completed', 'canceled'],
            default: 'scheduled'
        },
        sessionDate: Date,
        usedAt: Date
    }],   // coveredSessions e isAdvance para sessoes avulsas pagas adiantadaamete apra uso posterior
    isAdvance: Boolean,
    advanceSessions: [{
        session: { type: mongoose.Schema.Types.ObjectId, ref: 'Session' },
        appointment: { type: mongoose.Schema.Types.ObjectId, ref: 'Appointment' },
        used: Boolean,
        usedAt: Date,
        scheduledDate: Date
    }]
}, {
    timestamps: true,
    toObject: { virtuals: true },
    toJSON: { virtuals: true }
});

// Middleware para pagamentos de pacote
paymentSchema.post('save', async function (doc) {
    try {
        // Atualizar appointment associado apenas se o pagamento for marcado como pago
        if (doc.status === 'paid' && doc.appointment) {
            await mongoose.model('Appointment').findByIdAndUpdate(
                doc.appointment,
                { paymentStatus: 'paid' }
            );
        }

        // Lógica específica para pacotes
        if (doc.serviceType === 'package_session' && doc.package && doc.status === 'paid') {
            const Package = mongoose.model('Package');
            const pkg = await Package.findById(doc.package);

            if (pkg) {
                // Atualizar o pacote com o valor pago
                const updatedPkg = await Package.findByIdAndUpdate(
                    doc.package,
                    {
                        $inc: { totalPaid: doc.amount },
                        $push: { payments: doc._id }
                    },
                    { new: true }
                );

                // Cálculo de sessões que podem ser marcadas como pagas
                const sessionsPaidCount = Math.floor(updatedPkg.totalPaid / updatedPkg.sessionValue);
                const previouslyPaidCount = updatedPkg.payments.length - 1;
                const newSessionsToPay = sessionsPaidCount - previouslyPaidCount;

                if (newSessionsToPay > 0) {
                    const Session = mongoose.model('Session');
                    const sessionsToAutoPay = await Session.find({
                        package: pkg._id,
                        status: { $ne: 'paid' }
                    })
                        .sort({ createdAt: 1 })
                        .limit(newSessionsToPay)
                        .select('_id');

                    if (sessionsToAutoPay.length > 0) {
                        await Session.updateMany(
                            { _id: { $in: sessionsToAutoPay.map(s => s._id) } },
                            {
                                isPaid: true,
                                paymentMethod: doc.paymentMethod,
                                status: 'paid'
                            }
                        );
                    }
                }
            }
        }
    } catch (error) {
        console.error('Erro no pós-save do pagamento:', error);
        // Implementar lógica de retentativa ou log de erro aqui
    }
});

paymentSchema.pre('save', async function (next) {
    // Pular associação automática para pacotes e pagamentos adiantados
    if (this.serviceType === 'package_session' || this.isAdvancePayment) {
        return next();
    }

    // Só processar se não tiver appointment associado
    if (!this.appointment) {
        try {
            // Buscar appointment correspondente
            const filter = {
                patient: this.patient,
                doctor: this.doctor,
                date: {
                    $gte: new Date(this.createdAt.getTime() - 3 * 24 * 60 * 60 * 1000),
                    $lte: new Date(this.createdAt.getTime() + 3 * 24 * 60 * 60 * 1000)
                },
                payment: { $exists: false } // Só appointments sem pagamento
            };

            // Critérios adicionais por tipo de serviço
            if (this.serviceType === 'evaluation') {
                filter.specialty = { $exists: true };
                filter.operationalStatus = 'confirmado';
            } else if (this.serviceType === 'session') {
                filter.clinicalStatus = { $in: ['pendente', 'concluído'] };
            }

            const appointment = await mongoose.model('Appointment').findOne(filter);

            if (appointment) {
                this.appointment = appointment._id;

                // Atualização segura do appointment
                await mongoose.model('Appointment').findOneAndUpdate(
                    { _id: appointment._id },
                    {
                        $set: {
                            payment: this._id,
                            // Atualiza status apenas para sessões avulsas
                            ...(this.serviceType === 'session' && { operationalStatus: 'pago' })
                        }
                    }
                );
            }
        } catch (error) {
            // Logar erro sem interromper o fluxo
            console.error('Erro na associação automática:', {
                paymentId: this._id,
                error: error.message
            });
        }
    }
    next();
});

const Payment = mongoose.model('Payment', paymentSchema);
export default Payment;