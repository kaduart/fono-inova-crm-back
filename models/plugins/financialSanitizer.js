/**
 * 💰 Financial Sanitizer Plugin (Mongoose)
 *
 * Bloqueia writes V1 na origem (CREATE):
 * - Remove isPaid / paymentStatus de documentos novos
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
        stack: new Error().stack.split('\n').slice(3, 8).join('\n')
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
        console.warn('⚠️  [FINANCIAL SANITIZER] REMOVED:', JSON.stringify(meta, null, 2));
      }
    }

    return doc;
  }

  // Pre-save: intercepta doc.save(), Model.create(), new Model()
  schema.pre('save', function(next) {
    if (this.isNew) {
      sanitize(this.toObject(), 'save');
      // Re-aplicar no documento mongoose (toObject() retorna cópia)
      for (const field of LEGACY_FIELDS) {
        if (this[field] !== undefined) {
          this[field] = undefined;
          this.markModified(field);
        }
      }
    }
    next();
  });

  // Pre-insertMany: intercepta Model.insertMany()
  schema.pre('insertMany', function(next, docs) {
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
          stack: new Error().stack.split('\n').slice(3, 8).join('\n')
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
