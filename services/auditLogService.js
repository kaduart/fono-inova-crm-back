// back/services/auditLogService.js
/**
 * AuditLogService
 *
 * Serviço best-effort para registrar auditoria de entidades.
 * Nunca joga erro para cima: falhas são logadas no stdout/stderr.
 *
 * TODO TÉCNICO: Migrar para Outbox/Domain Events quando Appointment publicar
 * eventos de domínio. Atualmente o log é escrito diretamente na collection
 * `auditlogs`, o que é adequado para o MVP mas deve evoluir para garantia
 * de entrega em caso de falha de processo.
 */

import mongoose from 'mongoose';
import AuditLog from '../models/AuditLog.js';
import { FeatureFlags } from '../config/featureFlags.js';

const REFERENCE_FIELDS = new Set([
  'patient',
  'doctor',
  'insuranceGuide',
  'insurancePlan',
  'package',
  'liminarContract',
  'rescheduledFrom',
  'originalAppointmentId',
]);

const AUDITABLE_FIELDS = new Set([
  'billingType',
  'insuranceProvider',
  'insuranceValue',
  'insuranceGuide',
  'insurancePlan',
  'paymentMethod',
  'paymentAmount',
  'sessionValue',
  'operationalStatus',
  'clinicalStatus',
  'patient',
  'doctor',
  'date',
  'time',
  'startDateTime',
  'endDateTime',
  'duration',
  'serviceType',
  'sessionType',
  'package',
  'payment',
  'session',
  'liminarContract',
  'canceledReason',
  'cancelReason',
  'notes',
  'rescheduledFrom',
  'originalAppointmentId',
]);

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function normalizeValue(value) {
  if (value instanceof mongoose.Types.ObjectId || (value && typeof value.toHexString === 'function')) {
    return value.toString();
  }
  if (value instanceof Date) {
    return value.toISOString();
  }
  if (isPlainObject(value)) {
    const normalized = {};
    for (const key of Object.keys(value)) {
      normalized[key] = normalizeValue(value[key]);
    }
    return normalized;
  }
  if (Array.isArray(value)) {
    return value.map(normalizeValue);
  }
  return value;
}

function deepClone(value) {
  if (value === undefined) return null;
  if (value === null) return null;
  if (value instanceof mongoose.Types.ObjectId) return value;
  if (value instanceof Date) return new Date(value);
  if (Array.isArray(value)) return value.map(deepClone);
  if (isPlainObject(value)) {
    const cloned = {};
    for (const key of Object.keys(value)) {
      cloned[key] = deepClone(value[key]);
    }
    return cloned;
  }
  return value;
}

export function pickAuditableFields(appointment) {
  if (!appointment) return null;

  const rawSource = appointment.toObject
    ? appointment.toObject({ virtuals: false, getters: false })
    : appointment;
  const source = deepClone(rawSource);

  const picked = {};
  for (const field of AUDITABLE_FIELDS) {
    let value = source[field];

    // Campos de referência: se estiverem populados, extrair apenas o _id
    if (REFERENCE_FIELDS.has(field)) {
      if (isPlainObject(value) && value._id !== undefined) {
        value = value._id;
      } else if (Array.isArray(value)) {
        value = value.map((v) => (isPlainObject(v) && v._id !== undefined ? v._id : v));
      }
    }

    picked[field] = normalizeValue(value === undefined ? null : value);
  }

  return picked;
}

export const buildAuditDiff = computeDiff;

export function computeDiff(before, after) {
  const diff = {};
  const keys = new Set([
    ...(before ? Object.keys(before) : []),
    ...(after ? Object.keys(after) : []),
  ]);

  for (const key of keys) {
    const from = before ? before[key] : undefined;
    const to = after ? after[key] : undefined;

    // Trata objetos aninhados (ex: insurance) recursivamente
    if (isPlainObject(from) && isPlainObject(to)) {
      const nested = computeDiff(from, to);
      if (Object.keys(nested).length > 0) {
        diff[key] = nested;
      }
      continue;
    }

    const serializedFrom = JSON.stringify(from);
    const serializedTo = JSON.stringify(to);

    if (serializedFrom !== serializedTo) {
      diff[key] = { from, to };
    }
  }

  return diff;
}

function inferSeverity(diff, action) {
  if (!diff) return 'INFO';

  // Criação e eventos de sistema não devem herdar severidade de campos críticos,
  // pois o registro está apenas sendo inicializado.
  if (action === 'appointment_created' || action.includes('_system_') || action.endsWith('_recalc')) {
    return 'INFO';
  }

  const criticalFields = ['billingType', 'insuranceGuide', 'insurancePlan', 'insuranceProvider'];
  const warningFields = ['insuranceValue', 'paymentMethod', 'paymentAmount', 'sessionValue', 'operationalStatus', 'clinicalStatus', 'date', 'time', 'doctor', 'patient'];

  const changedFields = Object.keys(diff);
  if (action === 'appointment_deleted') return 'CRITICAL';
  if (changedFields.some((f) => criticalFields.includes(f))) return 'CRITICAL';
  if (changedFields.some((f) => warningFields.includes(f))) return 'WARNING';
  return 'INFO';
}

export async function recordAudit({
  user,
  action,
  entityType,
  entityId,
  before,
  after,
  source,
  correlationId,
  metadata,
}) {
  if (!FeatureFlags.AUDIT.ENABLED) {
    return;
  }

  try {
    const normalizedBefore = before ? pickAuditableFields(before) : null;
    const normalizedAfter = after ? pickAuditableFields(after) : null;
    const diff = computeDiff(normalizedBefore, normalizedAfter);
    const severity = inferSeverity(diff, action);

    const isSystemActor = !user || !user._id;
    const audit = new AuditLog({
      userId: isSystemActor ? null : user._id,
      actorRole: isSystemActor ? 'SYSTEM' : (user.role || null),
      action,
      entityType,
      entityId,
      before: normalizedBefore,
      after: normalizedAfter,
      diff: Object.keys(diff).length > 0 ? diff : null,
      source,
      correlationId: correlationId || null,
      severity,
      metadata: metadata || null,
    });

    await audit.save();
  } catch (error) {
    // Fallback estruturado: garante visibilidade mesmo se o MongoDB falhar
    console.error('AUDIT_FAIL', JSON.stringify({
      action,
      entityType,
      entityId: entityId?.toString?.() || entityId,
      correlationId,
      source,
      userId: user?._id?.toString?.() || null,
      error: error.message,
      stack: error.stack,
      before: normalizedBefore,
      after: normalizedAfter,
    }));
  }
}

export async function getAppointmentAuditTrail(appointmentId, options = {}) {
  const { limit = 100, skip = 0, actions = [] } = options;
  const filter = { entityType: 'Appointment', entityId: appointmentId };
  if (actions.length > 0) {
    filter.action = { $in: actions };
  }

  return AuditLog.find(filter)
    .sort({ createdAt: -1 })
    .skip(skip)
    .limit(limit)
    .lean();
}

export default { recordAudit, pickAuditableFields, computeDiff, buildAuditDiff, getAppointmentAuditTrail };
