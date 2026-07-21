// services/billing/generators/BillingStatementPdfGenerator.js
import { generatePdfFromTemplate } from '../../generatePDF.js';

export async function generateBillingStatementPdf({
  patientName,
  insuranceProvider,
  insuranceName,
  guideNumber,
  sessions = [],
  periodLabel = '',
  totalGross = 0,
  totalNet = 0,
  clinicName = 'Clínica Fono Inova'
}) {
  const data = {
    patientName,
    insuranceProvider,
    insuranceName,
    guideNumber,
    sessions,
    periodLabel,
    totalGross,
    totalNet,
    clinicName
  };

  const buffer = await generatePdfFromTemplate(data, 'billing/billingStatementTemplate');

  return {
    buffer,
    type: 'billing_statement',
    filename: `Demonstrativo_${patientName.replace(/\s+/g, '_')}.pdf`,
    mimeType: 'application/pdf',
    metadata: {
      generatedFrom: 'billing_statement',
      sessionCount: sessions.length,
      totalGross,
      totalNet
    }
  };
}
