// services/communication/CommunicationRequestService.js
import InsuranceCommunication from '../../models/InsuranceCommunication.js';
import CommunicationPackage from '../../models/CommunicationPackage.js';
import CommunicationEmailLog from '../../models/CommunicationEmailLog.js';
import Convenio from '../../models/Convenio.js';
import { getRulesForInsuranceByConvenio } from './InsuranceRuleService.js';
import { transition, CommunicationEvents } from './CommunicationStateMachine.js';

export async function createCommunicationRequest({
  patientId,
  insuranceProvider,
  guideId,
  purpose,
  specialty,
  requestedSessions,
  notes,
  userId
}) {
  const communication = await InsuranceCommunication.create({
    patientId,
    insuranceProvider,
    guideId,
    purpose,
    specialty,
    requestedSessions,
    notes,
    createdBy: userId
  });

  return communication;
}

export async function listCommunicationRequests({
  status,
  insuranceProvider,
  patientId,
  purpose,
  month,
  page = 1,
  limit = 50
}) {
  const query = {};
  if (status) query.status = status;
  if (insuranceProvider) query.insuranceProvider = insuranceProvider.toLowerCase();
  if (patientId) query.patientId = patientId;
  if (purpose) query.purpose = purpose;

  if (month) {
    const [year, monthNum] = month.split('-').map(Number);
    const start = new Date(year, monthNum - 1, 1);
    const end = new Date(year, monthNum, 0, 23, 59, 59);
    query.createdAt = { $gte: start, $lte: end };
  }

  const skip = (page - 1) * limit;

  const [data, total] = await Promise.all([
    InsuranceCommunication.find(query)
      .populate('patientId', 'fullName')
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit)
      .lean(),
    InsuranceCommunication.countDocuments(query)
  ]);

  // Enriquecer com nome do convênio, status do pacote e último log de envio
  const providerCodes = [...new Set(data.map(r => r.insuranceProvider))];
  const convenios = await Convenio.find({ code: { $in: providerCodes } }).select('code name').lean();
  const convenioMap = new Map(convenios.map(c => [c.code, c.name]));

  const communicationIds = data.map(r => r._id.toString());
  const [packages, latestLogs] = await Promise.all([
    CommunicationPackage.find({ communicationId: { $in: communicationIds } }).lean(),
    CommunicationEmailLog.find({ communicationId: { $in: communicationIds } })
      .sort({ sentAt: -1 })
      .lean()
  ]);

  const packageByCommunication = new Map(packages.map(p => [p.communicationId.toString(), p]));
  const latestLogByCommunication = new Map();
  for (const log of latestLogs) {
    const key = log.communicationId.toString();
    if (!latestLogByCommunication.has(key)) latestLogByCommunication.set(key, log);
  }

  const enriched = data.map(r => {
    const id = r._id.toString();
    const pkg = packageByCommunication.get(id);
    const latestLog = latestLogByCommunication.get(id);
    return {
      ...r,
      patientName: r.patientId?.fullName || '',
      insuranceName: convenioMap.get(r.insuranceProvider) || r.insuranceProvider,
      patientId: r.patientId?._id || r.patientId,
      packageStatus: pkg?.status || 'draft',
      lastEmailStatus: latestLog?.status || null
    };
  });

  return {
    data: enriched,
    pagination: { total, page, limit, pages: Math.ceil(total / limit) }
  };
}

export async function getCommunicationRequest(id) {
  const communication = await InsuranceCommunication.findById(id)
    .populate('patientId', 'fullName email phoneNumber')
    .populate('guideId', 'number totalSessions usedSessions')
    .lean();

  if (!communication) throw new Error('Comunicação não encontrada');

  const convenio = await Convenio.findOne({ code: communication.insuranceProvider }).select('name communicationRules authorizationRules guidePolicy').lean();
  const purpose = communication.purpose || 'authorization';

  return {
    ...communication,
    insuranceName: convenio?.name || communication.insuranceProvider,
    communicationRules: getRulesForInsuranceByConvenio(convenio, purpose)
  };
}

export async function updateCommunicationStatus(id, event, options = {}) {
  // event deve ser um CommunicationEvents (APPROVE, DENY, etc.)
  return transition(id, event, options);
}

export async function getCommunicationsByPatient(patientId) {
  return InsuranceCommunication.find({ patientId })
    .populate('patientId', 'fullName')
    .sort({ createdAt: -1 })
    .lean();
}

export async function markCommunicationAsReady(id) {
  return transition(id, CommunicationEvents.MARK_READY);
}

export async function markCommunicationAsSending(id) {
  return transition(id, CommunicationEvents.SEND);
}

export async function markCommunicationAsSent(id) {
  return transition(id, CommunicationEvents.MARK_SENT);
}

export async function markCommunicationAsFailed(id) {
  return transition(id, CommunicationEvents.FAIL);
}

export async function approveCommunication(id, reason) {
  return transition(id, CommunicationEvents.APPROVE, { statusReason: reason });
}

export async function denyCommunication(id, reason) {
  return transition(id, CommunicationEvents.DENY, { statusReason: reason });
}
