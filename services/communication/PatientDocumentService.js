// services/communication/PatientDocumentService.js
import PatientDocument from '../../models/PatientDocument.js';
import { uploadDocumentToCloudinary } from '../media/mediaUploadService.js';

export async function createPatientDocument({
  patientId,
  type,
  name,
  originalName,
  buffer,
  mimeType,
  size,
  extension,
  source = 'upload',
  tags = [],
  uploadedBy,
  metadata = {}
}) {
  const folder = `patient-documents/${patientId}`;
  const uploadResult = await uploadDocumentToCloudinary(buffer, originalName, mimeType, folder);

  const doc = await PatientDocument.create({
    patientId,
    type,
    name,
    originalName,
    url: uploadResult.url,
    publicId: uploadResult.publicId,
    mimeType,
    size,
    extension,
    source,
    tags,
    uploadedBy,
    metadata
  });

  return doc;
}

export async function createPatientDocumentFromBase64({
  patientId,
  type,
  name,
  base64Image,
  mimeType = 'image/png',
  source = 'paste',
  tags = [],
  uploadedBy,
  metadata = {}
}) {
  const buffer = Buffer.from(base64Image.replace(/^data:image\/\w+;base64,/, ''), 'base64');
  const extension = mimeType.split('/')[1] || 'png';
  const originalName = `${name}.${extension}`;

  return createPatientDocument({
    patientId,
    type,
    name,
    originalName,
    buffer,
    mimeType,
    size: buffer.length,
    extension,
    source,
    tags,
    uploadedBy,
    metadata
  });
}

export async function listPatientDocuments({
  patientId,
  type,
  page = 1,
  limit = 100
}) {
  const query = { patientId };
  if (type) query.type = type;

  const skip = (page - 1) * limit;

  const [data, total] = await Promise.all([
    PatientDocument.find(query)
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit)
      .lean(),
    PatientDocument.countDocuments(query)
  ]);

  return {
    data,
    pagination: { total, page, limit, pages: Math.ceil(total / limit) }
  };
}

export async function getPatientDocument(id) {
  return PatientDocument.findById(id).lean();
}

export async function deletePatientDocument(id, uploadedBy) {
  const doc = await PatientDocument.findById(id);
  if (!doc) throw new Error('Documento não encontrado');
  // TODO: deletar do Cloudinary se necessário (usar publicId)
  await doc.deleteOne();
  return { deleted: true };
}
