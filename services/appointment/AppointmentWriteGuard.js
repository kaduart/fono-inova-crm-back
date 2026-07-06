// back/services/appointment/AppointmentWriteGuard.js
/**
 * 🛡️ AppointmentWriteGuard
 *
 * Interceptor de writes raw (driver nativo / mongoose updateMany / bulkWrite)
 * nos modelos Appointment, Session e Payment.
 *
 * Objetivo: eliminar gradualmente "backdoors de estado" que bypassam
 * commands, hooks e FSM.
 *
 * Modos (env APPOINTMENT_WRITE_GUARD_MODE):
 * - 'warn'  (padrão): loga warning, permite write
 * - 'strict': loga erro, bloqueia write
 * - 'noop':   loga warning, ignora write (use apenas em testes isolados)
 *
 * Writes autorizados devem carregar uma das flags no $set:
 * - _fromCompleteService  → completeSessionService
 * - _fromCancelService    → cancelAppointmentCommand/workers
 * - _fromWriteGateway     → AppointmentWriteGateway (uso temporário, documentado)
 */

const MODE = process.env.APPOINTMENT_WRITE_GUARD_MODE || 'warn';

const AUTHORIZED_FLAGS = [
  '_fromCompleteService',
  '_fromCancelService',
  '_fromWriteGateway',
  '_fromInsuranceOrchestrator',
];

/**
 * Verifica se um objeto de update (geralmente $set ou update direto)
 * toca em campos protegidos.
 */
function touchesProtectedField(update, protectedFields) {
  if (!update || typeof update !== 'object') return false;

  const $set = update.$set || update;
  const $unset = update.$unset || {};

  return protectedFields.some(
    (field) =>
      Object.prototype.hasOwnProperty.call($set, field) ||
      Object.prototype.hasOwnProperty.call($unset, field)
  );
}

/**
 * Verifica se o update contém uma flag de autorização.
 */
function hasAuthorizedFlag(update) {
  if (!update || typeof update !== 'object') return false;
  const $set = update.$set || update;
  return AUTHORIZED_FLAGS.some((flag) => $set[flag] === true);
}

/**
 * Extrai o nome do campo protegido que está sendo alterado, para log.
 */
function getTouchedFields(update, protectedFields) {
  if (!update || typeof update !== 'object') return [];
  const $set = update.$set || update;
  const $unset = update.$unset || {};
  return protectedFields.filter(
    (field) =>
      Object.prototype.hasOwnProperty.call($set, field) ||
      Object.prototype.hasOwnProperty.call($unset, field)
  );
}

/**
 * Constrói a entrada de log padronizada.
 */
function buildLogEntry(modelName, operation, filter, update, protectedFields, stack) {
  const touched = getTouchedFields(update, protectedFields);
  return {
    timestamp: new Date().toISOString(),
    guard: 'AppointmentWriteGuard',
    model: modelName,
    operation,
    touchedFields: touched,
    hasAuthorizedFlag: hasAuthorizedFlag(update),
    mode: MODE,
    filter: safeStringify(filter),
    update: safeStringify(update),
    stack: stack?.split('\n')?.slice(3, 10) || 'unknown',
  };
}

function safeStringify(obj) {
  try {
    return JSON.stringify(obj, (key, value) => {
      if (key === 'password' || key === 'token' || key === 'secret') return '[REDACTED]';
      return value;
    });
  } catch {
    return '[unserializable]';
  }
}

class AppointmentWriteGuard {
  /**
   * Instala interceptores em um model Mongoose.
   *
   * @param {string} modelName - Nome do model (ex: 'Appointment')
   * @param {mongoose.Model} Model - Model Mongoose
   * @param {string[]} protectedFields - Lista de campos protegidos
   */
  static install(modelName, Model, protectedFields) {
    if (!Model || !Model.collection) {
      console.warn(`[AppointmentWriteGuard] Model ${modelName} não possui collection. Ignorando.`);
      return;
    }

    const collection = Model.collection;

    // Guardar métodos originais
    const originalCollectionUpdateOne = collection.updateOne.bind(collection);
    const originalCollectionUpdateMany = collection.updateMany.bind(collection);
    const originalCollectionBulkWrite = collection.bulkWrite.bind(collection);
    const originalModelUpdateMany = Model.updateMany.bind(Model);
    const originalModelBulkWrite = Model.bulkWrite.bind(Model);

    // ── collection.updateOne ──
    collection.updateOne = function guardedUpdateOne(filter, update, ...rest) {
      if (touchesProtectedField(update, protectedFields) && !hasAuthorizedFlag(update)) {
        const entry = buildLogEntry(modelName, 'collection.updateOne', filter, update, protectedFields, new Error().stack);
        AppointmentWriteGuard.handleViolation(entry);
      }
      return originalCollectionUpdateOne(filter, update, ...rest);
    };

    // ── collection.updateMany ──
    collection.updateMany = function guardedUpdateMany(filter, update, ...rest) {
      if (touchesProtectedField(update, protectedFields) && !hasAuthorizedFlag(update)) {
        const entry = buildLogEntry(modelName, 'collection.updateMany', filter, update, protectedFields, new Error().stack);
        AppointmentWriteGuard.handleViolation(entry);
      }
      return originalCollectionUpdateMany(filter, update, ...rest);
    };

    // ── collection.bulkWrite ──
    collection.bulkWrite = function guardedBulkWrite(operations, ...rest) {
      const offending = (operations || []).filter((op) => {
        const update = op.updateOne?.update || op.updateMany?.update || op.replaceOne?.replacement;
        return touchesProtectedField(update, protectedFields) && !hasAuthorizedFlag(update);
      });

      if (offending.length > 0) {
        const entry = buildLogEntry(
          modelName,
          'collection.bulkWrite',
          null,
          { operations: offending },
          protectedFields,
          new Error().stack
        );
        AppointmentWriteGuard.handleViolation(entry);
      }

      return originalCollectionBulkWrite(operations, ...rest);
    };

    // ── Model.updateMany (mongoose query hook, mas sem document hooks) ──
    Model.updateMany = function guardedModelUpdateMany(filter, update, ...rest) {
      if (touchesProtectedField(update, protectedFields) && !hasAuthorizedFlag(update)) {
        const entry = buildLogEntry(modelName, 'Model.updateMany', filter, update, protectedFields, new Error().stack);
        AppointmentWriteGuard.handleViolation(entry);
      }
      return originalModelUpdateMany(filter, update, ...rest);
    };

    // ── Model.bulkWrite (mongoose bulkWrite, não dispara document hooks) ──
    Model.bulkWrite = function guardedModelBulkWrite(operations, ...rest) {
      const offending = (operations || []).filter((op) => {
        const update = op.updateOne?.update || op.updateMany?.update || op.replaceOne?.replacement;
        return touchesProtectedField(update, protectedFields) && !hasAuthorizedFlag(update);
      });

      if (offending.length > 0) {
        const entry = buildLogEntry(
          modelName,
          'Model.bulkWrite',
          null,
          { operations: offending },
          protectedFields,
          new Error().stack
        );
        AppointmentWriteGuard.handleViolation(entry);
      }

      return originalModelBulkWrite(operations, ...rest);
    };

    console.log(`[AppointmentWriteGuard] Interceptores instalados para ${modelName} (modo: ${MODE})`);
  }

  /**
   * Decide o que fazer quando detecta um write não autorizado.
   */
  static handleViolation(entry) {
    if (MODE === 'strict') {
      console.error('🚨 [AppointmentWriteGuard] BLOCKED:', JSON.stringify(entry, null, 2));
      throw new Error(
        `APPOINTMENT_WRITE_BLOCKED: Tentativa de alterar ${entry.touchedFields?.join(', ')} em ${entry.model} ` +
          `via ${entry.operation} sem flag autorizada. Use um command ou set _fromWriteGateway: true.`
      );
    }

    if (MODE === 'noop') {
      console.warn('🚨 [AppointmentWriteGuard] NOOP:', JSON.stringify(entry, null, 2));
      return;
    }

    console.warn('⚠️  [AppointmentWriteGuard] WARN:', JSON.stringify(entry, null, 2));
  }

  /**
   * Gateway explícito para writes autorizados em massa.
   * Use apenas enquanto o fluxo não for migrado para um command.
   */
  static async updateMany(Model, filter, update, options = {}) {
    const guardedUpdate = {
      ...update,
      $set: {
        ...(update.$set || {}),
        _fromWriteGateway: true,
      },
    };

    if (!update.$set) {
      // update é um objeto plano (sem $set)
      guardedUpdate._fromWriteGateway = true;
    }

    return Model.updateMany(filter, guardedUpdate, options);
  }

  static getMode() {
    return MODE;
  }
}

export default AppointmentWriteGuard;
