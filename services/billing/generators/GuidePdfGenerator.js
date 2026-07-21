// services/billing/generators/GuidePdfGenerator.js
import { generatePdfFromTemplate } from '../../generatePDF.js';

export async function generateGuidePdf({
  guideNumber,
  patientName,
  policyNumber,
  insuranceProvider,
  insuranceName,
  specialty,
  issuedAt,
  expiresAt,
  status,
  totalSessions,
  usedSessions,
  remainingSessions,
  sessionValue,
  totalAuthorizedValue
}) {
  const data = {
    guideNumber,
    patientName,
    policyNumber,
    insuranceProvider,
    insuranceName,
    specialty,
    issuedAt,
    expiresAt,
    status,
    totalSessions,
    usedSessions,
    remainingSessions,
    sessionValue,
    totalAuthorizedValue
  };

  const buffer = await generatePdfFromTemplate(data, 'billing/guideTemplate');

  return {
    buffer,
    type: 'guide',
    filename: `Guia_${guideNumber}.pdf`,
    mimeType: 'application/pdf',
    metadata: {
      generatedFrom: 'guide',
      guideNumber
    }
  };
}
