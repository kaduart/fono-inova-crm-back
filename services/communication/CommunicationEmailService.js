// services/communication/CommunicationEmailService.js
//
// LEGADO: a lógica de envio de e-mail foi movida para
// `services/communication/delivery/EmailDeliveryProvider.js` e o orquestrador
// `services/communication/CommunicationService.js`.
//
// Este arquivo mantém apenas helpers de consulta/logs para compatibilidade com
// as rotas existentes. Novo código deve usar CommunicationService + providers.

import CommunicationEmailLog from '../../models/CommunicationEmailLog.js';
import InsuranceCommunication from '../../models/InsuranceCommunication.js';
import Convenio from '../../models/Convenio.js';

export async function getEmailLogs(communicationId) {
  return CommunicationEmailLog.find({ communicationId })
    .sort({ sentAt: -1 })
    .lean();
}

/**
 * Lista CADA tentativa de envio (1 log = 1 linha), não só a última por comunicação.
 * É o que alimenta a aba "Envios" — histórico/auditoria completo, não um resumo.
 */
export async function listCommunicationEmailLogs({
  purpose,
  insuranceProvider,
  patientId,
  page = 1,
  limit = 100
} = {}) {
  const commQuery = {};
  if (purpose) commQuery.purpose = purpose;
  if (insuranceProvider) commQuery.insuranceProvider = insuranceProvider.toLowerCase();
  if (patientId) commQuery.patientId = patientId;

  const communications = await InsuranceCommunication.find(commQuery)
    .populate('patientId', 'fullName')
    .populate('guideId', 'number')
    .lean();

  if (communications.length === 0) {
    return { data: [], pagination: { total: 0, page, limit, pages: 0 } };
  }

  const commIds = communications.map(c => c._id);
  const commById = new Map(communications.map(c => [c._id.toString(), c]));

  const convenioCodes = [...new Set(communications.map(c => c.insuranceProvider))];
  const convenios = await Convenio.find({ code: { $in: convenioCodes } }).select('code name').lean();
  const convenioMap = new Map(convenios.map(c => [c.code, c.name]));

  const skip = (page - 1) * limit;
  const [logs, total] = await Promise.all([
    CommunicationEmailLog.find({ communicationId: { $in: commIds } })
      .sort({ sentAt: -1 })
      .skip(skip)
      .limit(limit)
      .lean(),
    CommunicationEmailLog.countDocuments({ communicationId: { $in: commIds } })
  ]);

  const data = logs.map(log => {
    const comm = commById.get(log.communicationId.toString());
    return {
      ...log,
      patientId: comm?.patientId?._id || comm?.patientId,
      patientName: comm?.patientId?.fullName || '',
      insuranceProvider: comm?.insuranceProvider,
      insuranceName: convenioMap.get(comm?.insuranceProvider) || comm?.insuranceProvider,
      guideNumber: comm?.guideId?.number || null,
      purpose: comm?.purpose,
      communicationStatus: comm?.status,
      deliveryMethod: comm?.deliveryMethod || 'email'
    };
  });

  return { data, pagination: { total, page, limit, pages: Math.ceil(total / limit) } };
}

export async function getLatestEmailLog(communicationId) {
  return CommunicationEmailLog.findOne({ communicationId })
    .sort({ sentAt: -1 })
    .lean();
}
