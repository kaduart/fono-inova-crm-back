// services/billing/generators/AttendanceListPdfGenerator.js
import { generatePdfFromTemplate } from '../../generatePDF.js';

export async function generateAttendanceListPdf({
  patientName,
  insuranceProvider,
  insuranceName,
  sessions = [],
  periodLabel = '',
  clinicName = 'Clínica Fono Inova',
  generatedAt = new Date().toLocaleString('pt-BR')
}) {
  const data = {
    patientName,
    insuranceProvider,
    insuranceName,
    sessions,
    periodLabel,
    clinicName,
    generatedAt
  };

  const buffer = await generatePdfFromTemplate(data, 'billing/attendanceListTemplate');

  return {
    buffer,
    type: 'attendance_list',
    filename: `Lista_Presenca_${patientName.replace(/\s+/g, '_')}.pdf`,
    mimeType: 'application/pdf',
    metadata: {
      generatedFrom: 'attendance_list',
      sessionCount: sessions.length
    }
  };
}
