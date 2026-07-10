// back/services/billing/commands/updatePackageCommand.js
/**
 * Update Package Command
 *
 * Responsabilidade: atualizar um pacote de forma atômica e emitir
 * o evento de domínio canônico PACKAGE_UPDATED via Outbox.
 *
 * Regras:
 * - Recebe apenas campos permitidos para edição administrativa/cadastral.
 * - Não altera campos imutáveis (_id, createdAt, patient, totalValue etc.).
 * - Emite PACKAGE_UPDATED apenas se houver mudança real no documento.
 * - O evento é salvo na mesma transação MongoDB da mutação.
 */

import mongoose from 'mongoose';
import Package from '../../../models/Package.js';
import { runTransactionWithRetry } from '../../../utils/transactionRetry.js';
import { saveToOutbox } from '../../../infrastructure/outbox/outboxPattern.js';
import { EventTypes } from '../../../infrastructure/events/eventPublisher.js';

function buildError(message, status = 500, code = 'INTERNAL_ERROR') {
  const err = new Error(message);
  err.status = status;
  err.code = code;
  return err;
}

/**
 * Remove campos que não devem ser alterados por update administrativo.
 */
function sanitizeUpdates(updates) {
  const {
    _id,
    id,
    __v,
    createdAt,
    createdBy,
    patient,
    doctor,
    totalValue,
    payments,
    sessions,
    appointments,
    metadata,
    updatedAt,
    updatedBy,
    ...safe
  } = updates || {};

  return safe;
}

/**
 * Verifica se houve mudança real no documento, ignorando metadados de auditoria.
 */
function hasMeaningfulChange(original, updated, updates) {
  const ignoredFields = new Set(['updatedAt', 'updatedBy', '__v']);
  const changedFields = Object.keys(updates).filter(
    (key) => !ignoredFields.has(key) && String(original[key]) !== String(updated[key])
  );
  return changedFields.length > 0;
}

export async function execute(packageId, updates, user, correlationId = null) {
  if (!packageId) {
    throw buildError('ID do pacote é obrigatório', 400, 'MISSING_PACKAGE_ID');
  }

  if (!mongoose.Types.ObjectId.isValid(packageId)) {
    throw buildError('ID do pacote inválido', 400, 'INVALID_PACKAGE_ID');
  }

  const safeUpdates = sanitizeUpdates(updates);
  const changedFieldNames = Object.keys(safeUpdates);

  if (changedFieldNames.length === 0) {
    throw buildError('Nenhum campo válido para atualização', 400, 'NO_VALID_FIELDS');
  }

  const cid = correlationId || `pkg_update_${packageId}_${Date.now()}`;

  const result = await runTransactionWithRetry(async (mongoSession) => {
    const originalPackage = await Package.findById(packageId).session(mongoSession).lean();

    if (!originalPackage) {
      throw buildError('Pacote não encontrado', 404, 'PACKAGE_NOT_FOUND');
    }

    const updateData = {
      ...safeUpdates,
      updatedBy: user?._id,
      updatedAt: new Date(),
    };

    const updatedPackage = await Package.findByIdAndUpdate(
      packageId,
      { $set: updateData },
      {
        new: true,
        session: mongoSession,
        runValidators: true,
      }
    );

    if (!updatedPackage) {
      throw buildError('Pacote não encontrado após atualização', 404, 'PACKAGE_NOT_FOUND');
    }

    const shouldEmitEvent = hasMeaningfulChange(originalPackage, updatedPackage.toObject(), safeUpdates);

    if (shouldEmitEvent) {
      await saveToOutbox({
        eventType: EventTypes.PACKAGE_UPDATED,
        aggregateType: 'package',
        aggregateId: updatedPackage._id.toString(),
        payload: {
          packageId: updatedPackage._id.toString(),
          patientId: updatedPackage.patient?.toString?.() || null,
          doctorId: updatedPackage.doctor?.toString?.() || null,
          updatedFields: changedFieldNames,
          updatedBy: user?._id?.toString?.() || null,
        },
        correlationId: cid,
      }, mongoSession);
    }

    return { package: updatedPackage, eventEmitted: shouldEmitEvent };
  });

  return {
    data: result.package.toObject(),
    eventEmitted: result.eventEmitted,
    correlationId: cid,
    message: 'Pacote atualizado com sucesso',
  };
}

export default { execute };
