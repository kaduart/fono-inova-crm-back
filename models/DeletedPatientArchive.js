// back/models/DeletedPatientArchive.js
/**
 * DeletedPatientArchive
 *
 * Cópia integral de tudo que deletePatientCommand apaga (paciente, pagamentos,
 * sessões, agendamentos, pacotes, saldo e view), gravada NA MESMA transação da
 * exclusão. Serve de trilha de auditoria (quem, quando, por quê) e permite
 * reconstruir o paciente se a exclusão tiver sido um engano.
 *
 * - Sem TTL: a exclusão é definitiva nas coleções canônicas, o arquivo não.
 * - Só escrita por deletePatientCommand; nenhum fluxo lê daqui.
 * - Auditoria 360° do Dashboard admin (31/10/2026), achado B1.
 */

import mongoose from 'mongoose';

const deletedPatientArchiveSchema = new mongoose.Schema({
  patientId: { type: mongoose.Schema.Types.ObjectId, required: true, index: true },
  patientName: { type: String, default: null },
  deletedAt: { type: Date, required: true, default: Date.now, index: true },
  deletedBy: { type: String, default: null },
  deletedByRole: { type: String, default: null },
  reason: { type: String, default: null },
  counts: { type: mongoose.Schema.Types.Mixed, default: {} },
  data: {
    patient: { type: mongoose.Schema.Types.Mixed, default: null },
    payments: { type: [mongoose.Schema.Types.Mixed], default: [] },
    sessions: { type: [mongoose.Schema.Types.Mixed], default: [] },
    appointments: { type: [mongoose.Schema.Types.Mixed], default: [] },
    packages: { type: [mongoose.Schema.Types.Mixed], default: [] },
    patientBalances: { type: [mongoose.Schema.Types.Mixed], default: [] },
    patientsView: { type: [mongoose.Schema.Types.Mixed], default: [] },
  },
}, { minimize: false, strict: true, collection: 'deletedpatientarchives' });

export default mongoose.models.DeletedPatientArchive
  || mongoose.model('DeletedPatientArchive', deletedPatientArchiveSchema);
