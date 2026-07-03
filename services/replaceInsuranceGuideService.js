import mongoose from 'mongoose';
import InsuranceGuide from '../models/InsuranceGuide.js';
import InsurancePlan from '../models/InsurancePlan.js';
import Appointment from '../models/Appointment.js';
import Session from '../models/Session.js';
import Payment from '../models/Payment.js';
import { recordAudit } from './auditLogService.js';
import { GuideLifecycleService } from '../services/guideLifecycle/GuideLifecycleService.js';
import { generateInsurancePlanSessions } from './schedule/generateInsurancePlanSessions.js';
import { executeWithSession as bulkCancelAppointments } from './appointment/commands/bulkCancelAppointmentsCommand.js';

// Regra de negócio: appointment ainda depende da guia (não encerrado nem faturado)
function isAppointmentGuideReassignable(appointment) {
  const terminal = ['completed', 'cancelled', 'canceled', 'force_cancelled'];
  return !terminal.includes(appointment.operationalStatus);
}

// Regra de negócio: session elegível = sem efeitos financeiros ainda
function isSessionGuideReassignable(session) {
  if (!session) return false;
  if (session.guideConsumed) return false;
  if (session.insuranceBillingProcessed) return false;
  const settled = ['paid', 'recognized'];
  if (settled.includes(session.paymentStatus)) return false;
  return true;
}

function buildError(message, code, status = 422) {
  const err = new Error(message);
  err.code = code;
  err.statusCode = status;
  return err;
}

// ============================================================
// validateReplacement — idempotência + consistência de domínio
// ============================================================
async function validateReplacement(oldGuide, newGuideData) {
  if (!oldGuide) throw buildError('Guia não encontrada', 'GUIDE_NOT_FOUND', 404);

  if (oldGuide.status === 'superseded') {
    throw buildError('Esta guia já foi substituída', 'GUIDE_ALREADY_SUPERSEDED');
  }
  if (oldGuide.supersededBy) {
    throw buildError('Esta guia já possui uma substituta', 'GUIDE_ALREADY_SUPERSEDED');
  }

  const patientMatch = newGuideData.patientId?.toString() === oldGuide.patientId?.toString();
  const insuranceMatch = newGuideData.insurance?.toLowerCase() === oldGuide.insurance?.toLowerCase();
  const specialtyMatch = newGuideData.specialty?.toLowerCase() === oldGuide.specialty?.toLowerCase();

  if (!patientMatch) throw buildError('Paciente da nova guia não corresponde à original', 'GUIDE_PATIENT_MISMATCH');
  if (!insuranceMatch) throw buildError('Convênio da nova guia não corresponde ao original', 'GUIDE_INSURANCE_MISMATCH');
  if (!specialtyMatch) throw buildError('Especialidade da nova guia não corresponde à original', 'GUIDE_SPECIALTY_MISMATCH');
}

// ============================================================
// findEligibleAppointments
// ============================================================
async function findEligibleAppointments(oldGuideId, appointmentIds, migrationStrategy, mongoSession) {
  if (migrationStrategy === 'none') return [];

  if (migrationStrategy === 'manual') {
    if (!appointmentIds?.length) return [];
    const appts = await Appointment.find({ _id: { $in: appointmentIds }, insuranceGuide: oldGuideId })
      .session(mongoSession).lean();
    return appts.filter(isAppointmentGuideReassignable);
  }

  // 'eligible': regra de negócio — ainda depende da guia
  const candidates = await Appointment.find({ insuranceGuide: oldGuideId }).session(mongoSession).lean();
  return candidates.filter(isAppointmentGuideReassignable);
}

// ============================================================
// replaceInsuranceGuideService
// ============================================================
export async function replaceInsuranceGuideService({
  oldGuideId,
  newGuideData,
  migrationStrategy = 'eligible',
  appointmentIds = [],
  replacementTrigger,
  replacementNotes = null,
  performedBy,
}) {
  const mongoSession = await mongoose.startSession();

  try {
    await mongoSession.startTransaction();

    // 1. Carregar e validar guia antiga + plano terapêutico vinculado
    const oldGuide = await InsuranceGuide.findById(oldGuideId).session(mongoSession);
    await validateReplacement(oldGuide, newGuideData);

    const oldGuideSnapshot = oldGuide.toObject();
    const oldPlan = await InsurancePlan.findOne({ guide: oldGuide._id }).session(mongoSession).lean();
    const oldPlanAppointmentIds = new Set((oldPlan?.generatedAppointments || []).map(id => id.toString()));

    // 2. Criar nova guia
    const [newGuide] = await InsuranceGuide.create([{
      ...newGuideData,
      supersedes: oldGuide._id,
      status: 'active',
      usedSessions: 0,
      createdBy: performedBy,
    }], { session: mongoSession });

    // 3. Marcar guia antiga como superseded
    oldGuide.status = 'superseded';
    oldGuide.supersededBy = newGuide._id;
    oldGuide.supersededAt = new Date();
    oldGuide.replacementTrigger = replacementTrigger;
    oldGuide.replacementMethod = migrationStrategy; // como a migração foi feita
    oldGuide.replacementNotes = replacementNotes;
    await oldGuide.save({ session: mongoSession, validateBeforeSave: false });

    // 4. Se houver plano terapêutico na guia antiga, cancela seus appointments futuros
    // para evitar duplicação com os novos appointments gerados pelo plano clonado.
    let planAppointmentsCanceledCount = 0;
    if (oldPlan && oldPlanAppointmentIds.size > 0) {
      const todayStr = new Date().toISOString().split('T')[0];
      const planAppointmentsToCancel = await Appointment.find({
        _id: { $in: Array.from(oldPlanAppointmentIds).map(id => new mongoose.Types.ObjectId(id)) },
        insuranceGuide: oldGuide._id,
        // 'confirmed' faltava aqui — agendamento já confirmado do plano antigo não era
        // cancelado nem migrado (fora dos dois filtros), ficando duplicado quando o
        // plano novo gerava sessão pro mesmo horário recorrente.
        operationalStatus: { $in: ['scheduled', 'pre_agendado', 'confirmed'] },
        date: { $gte: todayStr }
      }).session(mongoSession).select('_id').lean();

      if (planAppointmentsToCancel.length > 0) {
        const cancelResult = await bulkCancelAppointments(
          planAppointmentsToCancel.map(a => a._id),
          { reason: 'guide_renewal_plan_reset' },
          { _id: performedBy },
          mongoSession
        );
        planAppointmentsCanceledCount = cancelResult.canceled;
      }
    }

    // 5. Migrar appointments elegíveis que NÃO pertencem ao plano antigo
    const eligibleAppointments = (await findEligibleAppointments(
      oldGuide._id, appointmentIds, migrationStrategy, mongoSession
    )).filter(appt => !oldPlanAppointmentIds.has(appt._id.toString()));

    let appointmentsMigratedCount = 0;
    let sessionsMigratedCount = 0;

    for (const appt of eligibleAppointments) {
      await Appointment.findByIdAndUpdate(
        appt._id,
        { $set: { insuranceGuide: newGuide._id } },
        { session: mongoSession }
      );
      appointmentsMigratedCount++;

      // 6. Migrar session vinculada se elegível
      if (appt.session) {
        const sess = await Session.findById(appt.session).session(mongoSession).lean();
        if (isSessionGuideReassignable(sess)) {
          await Session.findByIdAndUpdate(
            appt.session,
            { $set: { insuranceGuide: newGuide._id } },
            { session: mongoSession }
          );
          sessionsMigratedCount++;
        }
      }

      // 7. Migrar Payment.insuranceGuide vinculado ao appointment (Trinca:
      // Appointment+Session+Payment devem apontar pra mesma guia). Sem isso,
      // faturamento/auditoria por guia resolvia pra guia superseded (morta).
      await Payment.updateMany(
        { appointment: appt._id, insuranceGuide: oldGuide._id },
        { $set: { insuranceGuide: newGuide._id } },
        { session: mongoSession }
      );
    }

    // 7. Copiar plano terapêutico da guia antiga para a nova (se existir)
    let planCloned = false;
    let planGeneratedAppointmentsCount = 0;
    if (oldPlan) {
      const remaining = newGuide.totalSessions - newGuide.usedSessions;
      const today = new Date();
      today.setHours(0, 0, 0, 0);

      const [newPlan] = await InsurancePlan.create([{
        patient: oldPlan.patient,
        guide: newGuide._id,
        doctor: oldPlan.doctor,
        specialty: oldPlan.specialty,
        totalSessions: remaining,
        sessionsPerWeek: oldPlan.sessionsPerWeek,
        startDate: today,
        slots: oldPlan.slots,
        sessionValue: newGuide.sessionValue || oldPlan.sessionValue || 0,
        status: 'active',
        notes: oldPlan.notes,
        createdBy: performedBy
      }], { session: mongoSession });

      const generated = await generateInsurancePlanSessions({
        planId: newPlan._id,
        guideId: newGuide._id,
        sessionValue: newGuide.sessionValue || oldPlan.sessionValue || 0,
        mongoSession,
        skipHolidays: true
      });

      planCloned = true;
      planGeneratedAppointmentsCount = generated.count || 0;
    }

    await mongoSession.commitTransaction();

    // 6. Auditoria pós-commit (best-effort, não crítico)
    try {
      await recordAudit({
        user: { _id: performedBy },
        action: 'GUIDE_SUPERSEDED',
        entityType: 'InsuranceGuide',
        entityId: oldGuide._id,
        before: oldGuideSnapshot,
        after: { status: 'superseded', supersededBy: newGuide._id },
        source: 'replaceInsuranceGuideService',
        metadata: {
          newGuideId: newGuide._id,
          replacementTrigger,
          replacementMethod: migrationStrategy,
          replacementNotes,
          migrationStrategy,
          appointmentsMigratedCount,
          sessionsMigratedCount,
          planCloned,
          planGeneratedAppointmentsCount,
          planAppointmentsCanceledCount,
        },
      });
    } catch (auditErr) {
      console.warn('[replaceInsuranceGuideService] Auditoria falhou (não crítico):', auditErr.message);
    }

    return {
      newGuide,
      migrated: { appointmentsMigratedCount, sessionsMigratedCount },
      planCloned,
      planGeneratedAppointmentsCount,
      planAppointmentsCanceledCount,
    };

  } catch (error) {
    if (mongoSession.inTransaction()) await mongoSession.abortTransaction();
    throw error;
  } finally {
    await mongoSession.endSession();
  }
}
