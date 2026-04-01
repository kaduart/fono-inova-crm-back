// tests/helpers/waitFor.js
// Helper profissional para aguardar condições em sistemas assíncronos

/**
 * Aguarda uma condição ser satisfeita com timeout e retry
 * 
 * @param {Function} fn - Função que retorna truthy quando a condição é satisfeita
 * @param {Object} options - Opções de configuração
 * @param {number} options.timeout - Tempo máximo de espera (ms) - padrão: 10000
 * @param {number} options.interval - Intervalo entre tentativas (ms) - padrão: 200
 * @param {string} options.debugLabel - Label para debug
 * @returns {Promise<any>} - Retorna o resultado da função quando satisfeita
 */
export async function waitFor(fn, options = {}) {
  const {
    timeout = 10000,
    interval = 200,
    debugLabel = 'waitFor'
  } = options;

  const start = Date.now();
  let lastError;
  let attempts = 0;

  while (Date.now() - start < timeout) {
    attempts++;
    try {
      const result = await fn();

      if (result) {
        const duration = Date.now() - start;
        console.log(`✅ ${debugLabel}: satisfeito em ${duration}ms (${attempts} tentativas)`);
        return result;
      }
    } catch (err) {
      lastError = err;
    }

    await new Promise(r => setTimeout(r, interval));
  }

  const duration = Date.now() - start;
  const errorMsg = `⏱️ ${debugLabel}: TIMEOUT após ${duration}ms (${attempts} tentativas)` +
    (lastError ? ` - Último erro: ${lastError.message}` : '');
  
  throw new Error(errorMsg);
}

/**
 * Aguarda um documento existir no MongoDB
 */
export async function waitForDocument(db, collection, filter, options = {}) {
  return waitFor(async () => {
    const doc = await db.collection(collection).findOne(filter);
    return doc;
  }, {
    debugLabel: `${collection}-exists`,
    ...options
  });
}

/**
 * Aguarda uma fila BullMQ esvaziar
 */
export async function waitForQueueEmpty(queue, options = {}) {
  return waitFor(async () => {
    const [waiting, active, delayed] = await Promise.all([
      queue.getWaitingCount(),
      queue.getActiveCount(),
      queue.getDelayedCount()
    ]);
    return waiting === 0 && active === 0 && delayed === 0;
  }, {
    debugLabel: `queue-${queue.name}-empty`,
    ...options
  });
}
