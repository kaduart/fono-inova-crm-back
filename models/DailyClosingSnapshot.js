import mongoose from 'mongoose';

const DailyClosingSnapshotSchema = new mongoose.Schema({
    date: { 
        type: Date, 
        required: true, 
        index: true,
        set: function(v) {
            if (typeof v === 'string' && v.match(/^\d{4}-\d{2}-\d{2}$/)) {
                const [ano, mes, dia] = v.split('-').map(Number);
                return new Date(Date.UTC(ano, mes - 1, dia, 12, 0, 0));
            }
            return v;
        }
    },
    clinicId: { type: String, required: true, index: true, default: 'default' },
    report: {
        date: String,
        summary: {
            appointments: {
                total: Number,
                attended: Number,
                canceled: Number,
                pending: Number,
                expectedValue: Number,
                novos: Number,
                recorrentes: Number
            },
            financial: {
                totalReceived: Number,
                totalExpected: Number,
                totalRevenue: Number,
                byMethod: {
                    dinheiro: Number,
                    pix: Number,
                    cartão: Number
                }
            },
            insurance: {
                production: Number,
                received: Number,
                pending: Number,
                sessionsCount: Number
            }
        },
        timelines: {
            appointments: [mongoose.Schema.Types.Mixed],
            payments: [mongoose.Schema.Types.Mixed],
            insuranceSessions: [mongoose.Schema.Types.Mixed]
        },
        professionals: [mongoose.Schema.Types.Mixed],
        timeSlots: [mongoose.Schema.Types.Mixed]
    },
    calculatedAt: { type: Date, default: Date.now },
    calculatedBy: { type: String, default: 'daily_closing_worker' }
}, {
    timestamps: true
});

// Índice composto único
DailyClosingSnapshotSchema.index({ date: 1, clinicId: 1 }, { unique: true });

// TTL: manter por 2 anos
DailyClosingSnapshotSchema.index({ createdAt: 1 }, { expireAfterSeconds: 63072000 });

const DailyClosingSnapshot = mongoose.model('DailyClosingSnapshot', DailyClosingSnapshotSchema);

export default DailyClosingSnapshot;
