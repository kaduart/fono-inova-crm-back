// models/WhatsAppScanRun.js
// Execuções da varredura do WhatsApp Web para a lista de interesse em convênio (fila whatsapp-scan).
// Serve só para a tela mostrar "buscando…" / resultado. Ver docs/flows/convenio_interest_whatsapp.md.
import mongoose from 'mongoose';

const whatsAppScanRunSchema = new mongoose.Schema({
    // convenio_interest = busca rápida de 1 convênio; convenio_interest_deep = conversa por conversa, os 4 de uma vez
    kind: { type: String, enum: ['convenio_interest', 'convenio_interest_deep'], default: 'convenio_interest' },
    convenio: { type: String, required: true }, // 'todos' na profunda
    status: { type: String, enum: ['queued', 'running', 'done', 'failed'], default: 'queued' },
    requestedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    startedAt: { type: Date, default: null },
    finishedAt: { type: Date, default: null },
    attempts: { type: Number, default: 0 },
    stats: { type: mongoose.Schema.Types.Mixed, default: null },
    progress: { nextIndex: { type: Number, default: 0 } }, // profunda: próxima conversa a varrer
    error: { type: String, default: null },
}, { timestamps: true });

whatsAppScanRunSchema.index({ kind: 1, convenio: 1, createdAt: -1 });

export default mongoose.models.WhatsAppScanRun
    || mongoose.model('WhatsAppScanRun', whatsAppScanRunSchema, 'whatsapp_scan_runs');
