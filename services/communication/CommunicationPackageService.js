// services/communication/CommunicationPackageService.js
import CommunicationPackage, { PackageStatus } from '../../models/CommunicationPackage.js';
import PatientDocument from '../../models/PatientDocument.js';
import crypto from 'crypto';
import { transition, CommunicationEvents } from './CommunicationStateMachine.js';

function computeDocumentHash(doc) {
  const payload = `${doc.url || ''}|${doc.publicId || ''}|${doc.name || ''}|${doc.size || 0}|${doc.mimeType || ''}`;
  return crypto.createHash('sha256').update(payload).digest('hex');
}

export async function findOrCreatePackage({ communicationId, userId }) {
  let pkg = await CommunicationPackage.findOne({ communicationId }).sort({ createdAt: -1 });

  if (!pkg) {
    pkg = await CommunicationPackage.create({
      communicationId,
      attachments: [],
      status: PackageStatus.DRAFT,
      createdBy: userId
    });
  }

  return pkg;
}

export async function setPackageDocuments({ communicationId, documentIds, userId }) {
  const documents = await PatientDocument.find({ _id: { $in: documentIds } }).lean();
  const attachments = documents.map((d, index) => {
    const baseName = d.originalName || d.name || 'documento';
    const extMatch = baseName.match(/\.[^.]+$/);
    const ext = extMatch ? extMatch[0] : '';
    const nameWithoutExt = ext ? baseName.slice(0, -ext.length) : baseName;
    const uniqueSuffix = documents.filter(doc => (doc.originalName || doc.name) === baseName).length > 1
      ? `_${String(index + 1).padStart(2, '0')}`
      : '';
    const filename = `${nameWithoutExt}${uniqueSuffix}${ext}`;
    return {
      documentId: d._id,
      type: d.type,
      filename,
      url: d.url,
      hash: computeDocumentHash(d),
      mimeType: d.mimeType || '',
      size: d.size || 0,
      includedAt: new Date()
    };
  });

  const pkg = await CommunicationPackage.findOneAndUpdate(
    { communicationId },
    {
      $set: {
        attachments,
        createdBy: userId
      }
    },
    { new: true, upsert: true }
  );

  // Quando documentos são definidos, a comunicação está pronta para envio
  await transition(communicationId, CommunicationEvents.MARK_READY).catch(() => {
    // Ignora se já estiver em outro estado (ex.: reenvio)
  });

  return pkg;
}

export async function getPackageByCommunicationId(communicationId) {
  const pkg = await CommunicationPackage.findOne({ communicationId })
    .populate('attachments.documentId')
    .lean();

  return pkg;
}

export async function markPackageAsSending(communicationId) {
  const now = new Date();
  const pkg = await CommunicationPackage.findOneAndUpdate(
    { communicationId },
    {
      $set: { status: PackageStatus.DRAFT, lastAttemptAt: now },
      $inc: { attempt: 1 }
    },
    { new: true, upsert: true }
  );
  return pkg;
}

export async function markPackageAsSent(communicationId) {
  const now = new Date();
  const pkg = await CommunicationPackage.findOneAndUpdate(
    { communicationId },
    {
      $set: {
        status: PackageStatus.SENT,
        sentAt: now
      }
    },
    { new: true }
  );
  return pkg;
}

export async function markPackageAsResent(communicationId) {
  const now = new Date();
  const pkg = await CommunicationPackage.findOneAndUpdate(
    { communicationId },
    {
      $set: {
        status: PackageStatus.RESENT,
        resentAt: now
      }
    },
    { new: true }
  );
  return pkg;
}

export async function markPackageAsFailed(communicationId) {
  const pkg = await CommunicationPackage.findOneAndUpdate(
    { communicationId },
    {
      $set: {
        status: PackageStatus.FAILED
      }
    },
    { new: true }
  );
  return pkg;
}

export async function validatePackageDocuments(communicationId, requiredDocumentTypes = []) {
  const pkg = await CommunicationPackage.findOne({ communicationId }).lean();
  if (!pkg) return { valid: false, missing: requiredDocumentTypes };

  const includedTypes = new Set(pkg.attachments.map(a => a.type));
  const missing = requiredDocumentTypes.filter(t => !includedTypes.has(t));

  return { valid: missing.length === 0, missing };
}
