// back/services/billing/commands/updatePackageCommand.js
/**
 * Update Package Command
 *
 * Responsabilidade: atualizar um pacote de forma atômica e emitir
 * o evento de domínio canônico PACKAGE_UPDATED via Outbox.
 *
 * Regras:
 * - Edição cadastral apenas. A política de campos vive em packageUpdatePolicy.js.
 * - Tentativa de alterar campo protegido devolve 422 explicando o caminho certo,
 *   nunca 200 com a mudança descartada em silêncio pelo strict do Mongoose.
 * - Emite PACKAGE_UPDATED apenas se houver mudança real no documento.
 * - O evento é salvo na mesma transação MongoDB da mutação.
 */

import mongoose from 'mongoose';
import Package from '../../../models/Package.js';
import { runTransactionWithRetry } from '../../../utils/transactionRetry.js';
import { saveToOutbox } from '../../../infrastructure/outbox/outboxPattern.js';
import { EventTypes } from '../../../infrastructure/events/eventPublisher.js';
import { classifyUpdates, buildBlockedMessage } from './packageUpdatePolicy.js';

function buildError(message, status = 500, code = 'INTERNAL_ERROR', extra = {}) {
  const err = new Error(message);
  err.status = status;
  err.code = code;
  Object.assign(err, extra);
  return err;
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

  const cid = correlationId || `pkg_update_${packageId}_${Date.now()}`;

  // Política aplicada ANTES da transação: precisa do estado atual para
  // distinguir "campo protegido reenviado igual" de "tentativa de alteração".
  const currentPackage = await Package.findById(packageId).lean();
  if (!currentPackage) {
    throw buildError('Pacote não encontrado', 404, 'PACKAGE_NOT_FOUND');
  }

  const { allowed, blocked, ignored } = classifyUpdates(updates, currentPackage);

  if (blocked.length > 0) {
    throw buildError(
      buildBlockedMessage(blocked, currentPackage),
      422,
      'PACKAGE_FIELD_NOT_EDITABLE',
      { fields: blocked }
    );
  }

  const changedFieldNames = Object.keys(allowed);

  // Sem mudança real não é erro: o cliente pode ter reenviado o mesmo estado.
  if (changedFieldNames.length === 0) {
    return {
      data: currentPackage,
      changed: false,
      ignoredFields: ignored,
      eventEmitted: false,
      correlationId: cid,
      message: 'Nenhuma alteração aplicada — os dados enviados já são os atuais.',
    };
  }

  const safeUpdates = allowed;

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

    let updatedPackage;
    try {
      updatedPackage = await Package.findByIdAndUpdate(
        packageId,
        { $set: updateData },
        {
          new: true,
          session: mongoSession,
          runValidators: true,
        }
      );
    } catch (err) {
      // ValidationError é erro do cliente (400), não falha do servidor (500).
      // Antes desta conversão o modal recebia "Request failed with status code 500".
      if (err?.name === 'ValidationError') {
        const fields = Object.values(err.errors || {}).map((e) => ({
          field: e.path,
          reason: e.message,
        }));
        throw buildError(
          fields[0]?.reason || 'Dados inválidos para atualização do pacote',
          400,
          'VALIDATION_ERROR',
          { fields }
        );
      }
      throw err;
    }

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
    changed: true,
    changedFields: changedFieldNames,
    ignoredFields: ignored,
    eventEmitted: result.eventEmitted,
    correlationId: cid,
    message: 'Pacote atualizado com sucesso',
  };
}

export default { execute };
