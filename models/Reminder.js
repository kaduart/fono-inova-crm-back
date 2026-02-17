import mongoose from 'mongoose';

const reminderSchema = new mongoose.Schema({
    text: { type: String, required: true },
    dueDate: { type: String, required: true }, // YYYY-MM-DD
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
