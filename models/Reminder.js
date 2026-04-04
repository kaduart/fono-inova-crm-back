import mongoose from 'mongoose';

const reminderSchema = new mongoose.Schema({
    text: { type: String, required: true },
    dueDate: { 
        type: Date, 
        required: true, // Date
        set: function(v) {
            if (typeof v === 'string' && v.match(/^\d{4}-\d{2}-\d{2}$/)) {
                const [ano, mes, dia] = v.split('-').map(Number);
                return new Date(Date.UTC(ano, mes - 1, dia, 12, 0, 0));
            }
            return v;
        }
    },
    dueTime: { type: String, default: "" }, // HH:mm
    appointmentId: { type: String, default: null }, // Referência externa ou interna
    patient: { type: String, default: "" },
    professional: { type: String, default: "" },
    status: {
        type: String,
        enum: ['pending', 'done', 'canceled'],
        default: 'pending'
    },
    doneAt: { type: Date },
    canceledAt: { type: Date },
    snoozedAt: { type: Date }
}, {
    timestamps: true
});

const Reminder = mongoose.model('Reminder', reminderSchema);
export default Reminder;
