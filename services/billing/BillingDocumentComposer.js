// services/billing/BillingDocumentComposer.js
import InsuranceGuide from '../../models/InsuranceGuide.js';
import Session from '../../models/Session.js';
import Patient from '../../models/Patient.js';
import Doctor from '../../models/Doctor.js';
import Convenio from '../../models/Convenio.js';
import PatientDocument from '../../models/PatientDocument.js';
import { createPatientDocument } from '../communication/PatientDocumentService.js';
import { generateAttendanceListPdf } from './generators/AttendanceListPdfGenerator.js';
import { generateGuidePdf } from './generators/GuidePdfGenerator.js';
import { generateBillingStatementPdf } from './generators/BillingStatementPdfGenerator.js';

function formatDate(date) {
  if (!date) return '-';
  const d = new Date(date);
  if (isNaN(d.getTime())) return '-';
  return d.toLocaleDateString('pt-BR');
}

function formatDateTime(date) {
  if (!date) return '-';
  const d = new Date(date);
  if (isNaN(d.getTime())) return '-';
  return d.toLocaleString('pt-BR');
}

function formatCurrency(value) {
  if (value === null || value === undefined || isNaN(value)) return '-';
  return new Intl.NumberFormat('pt-BR', {
    style: 'currency',
    currency: 'BRL'
  }).format(value);
}

function buildPeriodLabel(sessions) {
  if (!sessions.length) return '-';
  const dates = sessions.map(s => new Date(s.date)).filter(d => !isNaN(d.getTime())).sort((a, b) => a - b);
  if (!dates.length) return '-';
  const start = dates[0].toLocaleDateString('pt-BR');
  const end = dates[dates.length - 1].toLocaleDateString('pt-BR');
  return start === end ? start : `${start} a ${end}`;
}

async function fetchExistingDocuments({ patientId, types }) {
  return PatientDocument.find({
    patientId,
    type: { $in: types }
  })
    .sort({ createdAt: -1 })
    .lean();
}

async function buildSessionRows(sessions, populated = false) {
  const rows = [];

  for (const session of sessions) {
    let doc = session;
    if (!populated && session.doctor) {
      doc = await Session.findById(session._id)
        .populate('doctor', 'fullName specialty')
        .populate('patient', 'fullName')
        .lean();
    }

    rows.push({
      _id: doc._id?.toString(),
      date: formatDate(doc.date),
      time: doc.time || '-',
      professionalName: doc.doctor?.fullName || doc.doctor?.name || '-',
      specialty: doc.specialty || doc.doctor?.specialty || '-',
      serviceType: doc.serviceType || doc.sessionType || '-',
      sessionValue: doc.sessionValue,
      grossAmount: doc.sessionValue,
      netAmount: doc.sessionValue
    });
  }

  return rows;
}

export async function composeBillingDocuments({
  patientId,
  guideId,
  sessionIds = [],
  generatedBy,
  persist = true
}) {
  if (!patientId) throw new Error('patientId é obrigatório');
  if (!guideId) throw new Error('guideId é obrigatório');
  if (!generatedBy) throw new Error('generatedBy é obrigatório');

  const guide = await InsuranceGuide.findById(guideId).lean();
  if (!guide) throw new Error('Guia não encontrada');

  const patient = await Patient.findById(patientId).lean();
  if (!patient) throw new Error('Paciente não encontrado');

  const convenio = await Convenio.findOne({ code: guide.insurance }).select('name code').lean();

  // Buscar sessões vinculadas à guia
  const sessionQuery = {
    insuranceGuide: guideId,
    status: 'completed',
    patient: patientId
  };
  if (sessionIds.length > 0) {
    sessionQuery._id = { $in: sessionIds };
  }

  const sessions = await Session.find(sessionQuery)
    .populate('doctor', 'fullName specialty')
    .populate('patient', 'fullName')
    .sort({ date: 1 })
    .lean();

  if (!sessions.length) throw new Error('Nenhuma sessão completada encontrada para a guia');

  const sessionRows = await buildSessionRows(sessions, true);
  const periodLabel = buildPeriodLabel(sessions);
  const totalGross = sessions.reduce((sum, s) => sum + (s.sessionValue || 0), 0);
  const totalNet = totalGross;

  const remainingSessions = Math.max(0, (guide.totalSessions || 0) - (guide.usedSessions || 0));

  const baseData = {
    patientName: patient.fullName || 'Paciente',
    insuranceProvider: guide.insurance,
    insuranceName: convenio?.name || guide.insurance,
    policyNumber: patient.healthPlan?.policyNumber || patient.carteirinha || '-'
  };

  // Gerar PDFs
  const generatedResults = [];

  const attendanceResult = await generateAttendanceListPdf({
    ...baseData,
    sessions: sessionRows,
    periodLabel
  });
  generatedResults.push(attendanceResult);

  const guideResult = await generateGuidePdf({
    ...baseData,
    guideNumber: guide.number,
    specialty: guide.specialty,
    issuedAt: formatDate(guide.issuedAt),
    expiresAt: formatDate(guide.expiresAt),
    status: guide.status,
    totalSessions: guide.totalSessions,
    usedSessions: guide.usedSessions,
    remainingSessions,
    sessionValue: formatCurrency(guide.sessionValue),
    totalAuthorizedValue: formatCurrency(guide.totalAuthorizedValue || guide.sessionValue * guide.totalSessions)
  });
  generatedResults.push(guideResult);

  const statementResult = await generateBillingStatementPdf({
    ...baseData,
    guideNumber: guide.number,
    sessions: sessionRows,
    periodLabel,
    totalGross: formatCurrency(totalGross),
    totalNet: formatCurrency(totalNet)
  });
  generatedResults.push(statementResult);

  // Persistir se solicitado
  let persistedDocs = [];
  if (persist) {
    for (const result of generatedResults) {
      const doc = await createPatientDocument({
        patientId,
        type: result.type,
        name: result.filename,
        originalName: result.filename,
        buffer: result.buffer,
        mimeType: result.mimeType,
        size: result.buffer.length,
        extension: 'pdf',
        source: 'generated',
        tags: ['billing', 'generated'],
        uploadedBy: generatedBy,
        metadata: {
          ...result.metadata,
          guideId: guideId.toString(),
          generatedAt: new Date().toISOString()
        }
      });

      persistedDocs.push({
        patientDocumentId: doc._id.toString(),
        type: result.type,
        filename: result.filename,
        url: doc.url,
        metadata: result.metadata
      });
    }
  }

  // Buscar documentos existentes relevantes
  const existingTypes = ['report', 'invoice', 'attendance_list', 'guide'];
  const existingDocs = await fetchExistingDocuments({ patientId, types: existingTypes });

  const existing = existingDocs.map(doc => ({
    patientDocumentId: doc._id.toString(),
    type: doc.type,
    filename: doc.originalName || doc.name,
    url: doc.url,
    createdAt: doc.createdAt
  }));

  // Mapear documentos gerados (persistidos ou não)
  const generated = persist
    ? persistedDocs
    : generatedResults.map(r => ({
        type: r.type,
        filename: r.filename,
        size: r.buffer.length,
        metadata: r.metadata
      }));

  // Determinar documentos faltantes com base nas regras do convênio
  const generatedTypes = new Set(generatedResults.map(r => r.type));
  const existingTypesSet = new Set(existing.map(d => d.type));
  const allAvailableTypes = new Set([...generatedTypes, ...existingTypesSet]);

  const requiredByRules = convenio?.communicationRules?.billing?.requiredDocuments || [];
  const missing = requiredByRules
    .filter(req => req.required && !allAvailableTypes.has(req.type))
    .map(req => ({
      type: req.type,
      label: req.label,
      required: true,
      reason: 'Documento não encontrado'
    }));

  return {
    patientId: patientId.toString(),
    guideId: guideId.toString(),
    insuranceProvider: guide.insurance,
    patientName: patient.fullName,
    generated,
    existing,
    missing,
    periodLabel,
    sessionCount: sessions.length,
    totalGross,
    totalNet
  };
}

export default composeBillingDocuments;
