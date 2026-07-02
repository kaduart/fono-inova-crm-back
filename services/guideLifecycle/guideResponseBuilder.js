// services/guideLifecycle/guideResponseBuilder.js
import { GuideLifecycleService } from './GuideLifecycleService.js';

/**
 * Constrói o objeto de resposta padrão { guide, lifecycle }.
 *
 * Usado pelos endpoints de insurance-guides para transformar um documento
 * de guia em um contrato de domínio público.
 *
 * @param {Object} rawGuide - guia vinda do MongoDB (lean ou doc)
 * @param {Object|null} convenio - documento do convênio com guidePolicy/defaultSessions
 * @param {Date} [today]
 * @returns {Object} { guide, lifecycle }
 */
export async function buildGuideResponse(rawGuide, convenio = null, today = new Date()) {
  const guidePolicy = convenio?.guidePolicy || null;
  const defaultSessions = convenio?.defaultSessions || null;

  const guide = {
    _id: rawGuide._id.toString(),
    number: rawGuide.number,
    patientId: rawGuide.patientId?._id?.toString?.() || rawGuide.patientId?.toString?.() || rawGuide.patientId,
    insurance: rawGuide.insurance,
    specialty: rawGuide.specialty,
    totalSessions: rawGuide.totalSessions,
    usedSessions: rawGuide.usedSessions || 0,
    remaining: Math.max(0, (rawGuide.totalSessions || 0) - (rawGuide.usedSessions || 0)),
    status: rawGuide.status,
    expiresAt: rawGuide.expiresAt,
    sessionValue: rawGuide.sessionValue ?? null,
    evaluationAmount: rawGuide.evaluationAmount ?? null,
    generateEvaluationBilling: rawGuide.generateEvaluationBilling ?? true,
    evaluationSessionId: rawGuide.evaluationSessionId?.toString?.() || null,
    totalValue: (rawGuide.sessionValue != null && rawGuide.totalSessions) ? rawGuide.sessionValue * rawGuide.totalSessions : null,
    doctor: rawGuide.doctorId ? { _id: rawGuide.doctorId._id?.toString(), fullName: rawGuide.doctorId.fullName } : null,
    issuedAt: rawGuide.issuedAt || null,
    notes: rawGuide.notes || null,
    createdAt: rawGuide.createdAt,
    supersededBy: rawGuide.supersededBy?.toString() || null,
    supersedes: rawGuide.supersedes?.toString() || null,
    supersededAt: rawGuide.supersededAt || null,
    replacementTrigger: rawGuide.replacementTrigger || null,
    replacementMethod: rawGuide.replacementMethod || null,
    replacementNotes: rawGuide.replacementNotes || null,
    guidePolicy,
    defaultSessions,
  };

  const lifecycle = guidePolicy
    ? GuideLifecycleService.evaluateWithPolicy(guide, guidePolicy, today)
    : await GuideLifecycleService.evaluate(guide, today);

  return { guide, lifecycle };
}
