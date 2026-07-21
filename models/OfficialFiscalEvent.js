// models/OfficialFiscalEvent.js
// Evento OFICIAL vindo da prefeitura/Sefin (Anexo II) — nunca confundir com Domain Event interno
// do CRM (ex. FiscalInvoiceAuthorized, ver Fase 2 v3 Seção 5). Append-only: nenhum método de
// update/delete é exposto pelo repository correspondente (invariante #5) — só create e find*.
import mongoose from 'mongoose';
import { FiscalEventCategoria, FiscalEventAutor } from '../constants/fiscalEvents.js';
import { OfficialFiscalEventSource } from '../constants/fiscalEnums.js';

const officialFiscalEventSchema = new mongoose.Schema({
  fiscalInvoice: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'FiscalInvoice',
    required: true,
    index: true
  },
  // Código numérico oficial (Anexo II) — ver constants/fiscalEvents.js TipoEvento
  tipoEvento: { type: Number, required: true, index: true },
  categoria: {
    type: Number,
    enum: Object.values(FiscalEventCategoria)
  },
  autor: {
    type: String,
    enum: Object.values(FiscalEventAutor)
  },
  payload: { type: mongoose.Schema.Types.Mixed },
  // Só preenchido para Bloqueio/Desbloqueio por Ofício (tipoEvento 305102/305103) — indica qual
  // tipoEvento fica temporariamente inaceitável (campo oficial `codEvento`, event_matrix.md Seção 2)
  targetTipoEvento: { type: Number },
  source: {
    type: String,
    enum: Object.values(OfficialFiscalEventSource),
    required: true
  },
  occurredAt: { type: Date, required: true, default: Date.now },
  correlationId: { type: String, index: true }
}, { timestamps: true });

officialFiscalEventSchema.index({ fiscalInvoice: 1, occurredAt: 1 });

const OfficialFiscalEvent = mongoose.models.OfficialFiscalEvent || mongoose.model('OfficialFiscalEvent', officialFiscalEventSchema);
export default OfficialFiscalEvent;
