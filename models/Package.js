import mongoose from 'mongoose';

const packageSchema = new mongoose.Schema({
    version: { type: Number, default: 0 },
    durationMonths: { type: Number, required: true, min: 1, max: 12 },
    sessionsPerWeek: { type: Number, required: true, min: 1, max: 5 },
    patient: { type: mongoose.Schema.Types.ObjectId, ref: 'Patient', required: true },
    doctor: { type: mongoose.Schema.Types.ObjectId, ref: 'Doctor', required: true },
    paymentMethod: { type: String },
    paymentType: { type: String },
    sessionType: {
        type: String,
        enum: ['fonoaudiologia', 'terapia_ocupacional', 'psicologia', 'fisioterapia'],
        required: true
    },
    sessionValue: { type: Number, default: 200, min: 0.01 },
    totalSessions: { type: Number, default: 1, min: 1 },
    sessions: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Session' }],
    appointments: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Appointment' }],
    date: { type: Date, required: true },
    time: { type: String },
    sessionsDone: { type: Number, default: 0 },
    payments: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Payment' }],
    status: { type: String, enum: ['active', 'in-progress', 'completed'], default: 'active' },
    totalPaid: { type: Number, default: 0 },
    balance: { type: Number, default: 0 },
    credit: { type: Number, default: 0 },
    specialty: {
        type: String,
        required: true,
        enum: ['fonoaudiologia', 'terapia_ocupacional', 'psicologia', 'fisioterapia', 'pediatria', 'neuroped']
    },
    firstAppointment: { type: mongoose.Schema.Types.ObjectId, ref: 'Appointment' }
});

packageSchema.virtual('remainingSessions').get(function () {
    return this.totalSessions - this.sessionsDone;
});

packageSchema.set('toJSON', { virtuals: true });
packageSchema.set('toObject', { virtuals: true });

packageSchema.pre('save', function (next) {
    this.totalSessions = this.durationMonths * 4 * this.sessionsPerWeek;
    this.balance = (this.totalSessions * this.sessionValue) - this.totalPaid;
    next();
});


packageSchema.pre('save', function (next) {
    next();
});


const Package = mongoose.model('Package', packageSchema);
export default Package;
