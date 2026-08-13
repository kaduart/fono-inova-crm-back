/**
 * 💰 Financial Sanitizer Plugin (Mongoose)
 *
 * Bloqueia writes V1 na origem (CREATE):
 * - Reseta isPaid / paymentStatus para o default do schema quando escritos
 *   explicitamente sem bypass; preserva o default quando o campo não foi tocado.
 * - Loga warning com stack trace
 * - Em modo STRICT: lança erro
 *
 * Uso:
 *   import financialSanitizer from './plugins/financialSanitizer.js';
 *   sessionSchema.plugin(financialSanitizer, { entity: 'Session' });
 */

const MODE = process.env.FINANCIAL_SANITIZER_MODE || 'warn';

// Deduplicação de logs: evita flood em produção
// Loga cada stack único no máximo 1x por hora
const _loggedHashes = new Map();
const LOG_TTL_MS = 60 * 60 * 1000;

function shouldLog(stackKey) {
  const now = Date.now();
  const last = _loggedHashes.get(stackKey);
  if (last && now - last < LOG_TTL_MS) return false;
  _loggedHashes.set(stackKey, now);
  return true;
}

function captureRelevantStack() {
  return new Error().stack
    .split('\n')
    .filter(line =>
      line.includes('    at ') &&
      !line.includes('node_modules') &&
      !line.includes('models/plugins/financialSanitizer.js')
    )
    .slice(0, 5)
    .join('\n');
}

export default function financialSanitizer(schema, options = {}) {
  const entityName = options.entity || 'Document';

  // Lista de campos financeiros legados que não devem ser persistidos
  const LEGACY_FIELDS = ['isPaid', 'paymentStatus'];

  function sanitize(doc, operation) {
    let modified = false;
    const removed = {};

    for (const field of LEGACY_FIELDS) {
      if (doc[field] !== undefined) {
        removed[field] = doc[field];
        delete doc[field];
        modified = true;
      }
    }

    if (modified) {
      const meta = {
        operation,
        entity: entityName,
        removedFields: removed,
        mode: MODE,
        stack: captureRelevantStack()
      };

      if (MODE === 'strict') {
        console.error('🚨 [FINANCIAL SANITIZER] BLOCKED CREATE:', JSON.stringify(meta, null, 2));
        throw new Error(
          `FINANCIAL_SANITIZER_BLOCKED: ${entityName} não pode receber ${Object.keys(removed).join(', ')} no CREATE. ` +
          `Use o ledger (Payment) como fonte de verdade.`
        );
      }

      const stackKey = `${entityName}:${operation}:${meta.stack}`;
      if (shouldLog(stackKey)) {
        console.warn('⚠️  [FINANCIAL SANITIZER] RESET_TO_DEFAULT:', JSON.stringify(meta, null, 2));
      }
    }

    return doc;
  }

  // Pre-save: intercepta doc.save(), Model.create(), new Model()
  schema.pre('save', function(next, options) {
    const opts =
      (options && options.__fromFinancialGuard === true && options.__guardContext === 'FINANCIAL')
        ? options
        : (this.$locals || {});
    if (
      opts.__fromFinancialGuard === true &&
      opts.__guardContext === 'FINANCIAL'
    ) return next();

    if (this.isNew) {
      const removed = {};
      let modified = false;

      for (const field of LEGACY_FIELDS) {
        if (this.isDirectModified(field)) {
          removed[field] = this[field];
          modified = true;

          const path = this.schema.path(field);
          const defaultValue = path ? path.getDefault(this) : undefined;
          this.set(field, defaultValue);
        }
      }

      if (modified) {
        const meta = {
          operation: 'save',
          entity: entityName,
          removedFields: removed,
          mode: MODE,
          stack: captureRelevantStack()
        };

        if (MODE === 'strict') {
          console.error('🚨 [FINANCIAL SANITIZER] BLOCKED CREATE:', JSON.stringify(meta, null, 2));
          throw new Error(
            `FINANCIAL_SANITIZER_BLOCKED: ${entityName} não pode receber ${Object.keys(removed).join(', ')} no CREATE. ` +
            `Use o ledger (Payment) como fonte de verdade.`
          );
        }

        const stackKey = `${entityName}:save:${meta.stack}`;
        if (shouldLog(stackKey)) {
          console.warn('⚠️  [FINANCIAL SANITIZER] RESET_TO_DEFAULT:', JSON.stringify(meta, null, 2));
        }
      }
    }

    next();
  });

  // Pre-insertMany: intercepta Model.insertMany()
  schema.pre('insertMany', function(next, docs) {
    const opts = this.$locals || {};
    if (
      opts.__fromFinancialGuard === true &&
      opts.__guardContext === 'FINANCIAL'
    ) return next();
    if (Array.isArray(docs)) {
      for (const doc of docs) {
        sanitize(doc, 'insertMany');
      }
    } else if (docs) {
      sanitize(docs, 'insertMany');
    }
    next();
  });

  // Pre-updateOne / pre-updateMany: intercepta updates que tentam setar V1
  schema.pre(['updateOne', 'updateMany', 'findOneAndUpdate'], function(next) {
    const opts = this.getOptions ? this.getOptions() : this.options || {};
    if (
      opts.__fromFinancialGuard === true &&
      opts.__guardContext === 'FINANCIAL'
    ) return next();
    const update = this.getUpdate();
    if (update) {
      const $set = update.$set || update;
      const removed = {};
      let modified = false;

      for (const field of LEGACY_FIELDS) {
        if ($set[field] !== undefined) {
          removed[field] = $set[field];
          delete $set[field];
          modified = true;
        }
      }

      if (modified) {
        const meta = {
          operation: this.op || 'update',
          entity: entityName,
          removedFields: removed,
          mode: MODE,
          stack: captureRelevantStack()
        };

        if (MODE === 'strict') {
          console.error('🚨 [FINANCIAL SANITIZER] BLOCKED UPDATE:', JSON.stringify(meta, null, 2));
          throw new Error(
            `FINANCIAL_SANITIZER_BLOCKED: ${entityName} não pode receber ${Object.keys(removed).join(', ')} no UPDATE.`
          );
        }

        const stackKey = `${entityName}:${meta.operation}:${meta.stack}`;
        if (shouldLog(stackKey)) {
          console.warn('⚠️  [FINANCIAL SANITIZER] REMOVED UPDATE:', JSON.stringify(meta, null, 2));
        }
      }
    }
    next();
  });
}
