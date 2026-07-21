// services/communication/CommunicationStateMachine.js
import mongoose from 'mongoose';
import InsuranceCommunication, { CommunicationStatus } from '../../models/InsuranceCommunication.js';

export { CommunicationStatus };

export const CommunicationEvents = {
  CREATE: 'CREATE',
  MARK_READY: 'MARK_READY',
  SEND: 'SEND',
  MARK_SENT: 'MARK_SENT',
  APPROVE: 'APPROVE',
  DENY: 'DENY',
  FAIL: 'FAIL'
};

const TRANSITIONS = {
  [CommunicationStatus.DRAFT]: {
    [CommunicationEvents.MARK_READY]: CommunicationStatus.READY,
    [CommunicationEvents.DENY]: CommunicationStatus.DENIED
  },
  [CommunicationStatus.READY]: {
    [CommunicationEvents.SEND]: CommunicationStatus.SENDING,
    [CommunicationEvents.DENY]: CommunicationStatus.DENIED
  },
  [CommunicationStatus.SENDING]: {
    [CommunicationEvents.MARK_SENT]: CommunicationStatus.SENT,
    [CommunicationEvents.FAIL]: CommunicationStatus.READY,
    [CommunicationEvents.DENY]: CommunicationStatus.DENIED
  },
  [CommunicationStatus.SENT]: {
    [CommunicationEvents.APPROVE]: CommunicationStatus.APPROVED,
    [CommunicationEvents.DENY]: CommunicationStatus.DENIED
  },
  [CommunicationStatus.APPROVED]: {
    [CommunicationEvents.DENY]: CommunicationStatus.DENIED
  },
  [CommunicationStatus.DENIED]: {}
};

/**
 * Transiciona o status de uma InsuranceCommunication de forma controlada.
 * @param {InsuranceCommunication | string} communicationOrId — documento ou _id
 * @param {string} event — um dos CommunicationEvents
 * @param {{ statusReason?: string }} [options]
 * @returns {Promise<InsuranceCommunication>}
 */
export async function transition(communicationOrId, event, options = {}) {
  const communication = await resolveCommunication(communicationOrId);
  if (!communication) throw new Error('Comunicação não encontrada');

  const currentStatus = communication.status;
  const allowed = TRANSITIONS[currentStatus];
  if (!allowed || !allowed[event]) {
    throw new Error(`Transição inválida: ${currentStatus} → ${event}`);
  }

  const nextStatus = allowed[event];
  const update = { status: nextStatus };
  if (options.statusReason !== undefined) update.statusReason = options.statusReason;

  return InsuranceCommunication.findByIdAndUpdate(
    communication._id,
    { $set: update },
    { new: true, runValidators: true }
  );
}

async function resolveCommunication(communicationOrId) {
  if (typeof communicationOrId === 'string' || communicationOrId instanceof mongoose.Types.ObjectId) {
    return InsuranceCommunication.findById(communicationOrId);
  }
  return communicationOrId;
}

export function isValidTransition(fromStatus, event) {
  const allowed = TRANSITIONS[fromStatus];
  return !!allowed?.[event];
}

export function getNextStatus(fromStatus, event) {
  return TRANSITIONS[fromStatus]?.[event] || null;
}

export function getAllowedEvents(fromStatus) {
  return Object.keys(TRANSITIONS[fromStatus] || {});
}
