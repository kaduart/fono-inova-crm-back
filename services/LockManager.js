// services/LockManager.js
// Trava atômica anti-race condition para processamento de leads
// Usa os campos existentes: isProcessing + processingStartedAt

import Leads from '../models/Leads.js';
import Logger from './utils/Logger.js';

const logger = new Logger('LockManager');

const LOCK_TIMEOUT_MS = 30_000; // 30s — se travar, libera automaticamente
const RETRY_DELAY_MS = 300;
const MAX_RETRIES = 3;

/**
 * Adquire lock atômico no lead usando findOneAndUpdate.
 * Retorna o lead travado ou null se não conseguir.
 */
async function acquireLock(leadId) {
    const now = new Date();
    const staleThreshold = new Date(now.getTime() - LOCK_TIMEOUT_MS);

    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
        const locked = await Leads.findOneAndUpdate(
            {
                _id: leadId,
                $or: [
                    { isProcessing: false },
                    { isProcessing: { $exists: false } },
                    { processingStartedAt: { $lt: staleThreshold } } // lock expirado
                ]
            },
            {
                $set: {
                    isProcessing: true,
                    processingStartedAt: now
                }
            },
            { new: true }
        );

        if (locked) {
            logger.info('LOCK_ACQUIRED', { leadId, attempt });
            return locked;
        }

        logger.warn('LOCK_BUSY', { leadId, attempt, retrying: attempt < MAX_RETRIES - 1 });

        if (attempt < MAX_RETRIES - 1) {
            await new Promise(r => setTimeout(r, RETRY_DELAY_MS * (attempt + 1)));
        }
    }

    logger.error('LOCK_FAILED', { leadId, message: 'Não conseguiu adquirir lock após retries' });
    return null;
}

/**
 * Libera lock do lead.
 */
async function releaseLock(leadId) {
    await Leads.updateOne(
        { _id: leadId },
        { $set: { isProcessing: false, processingStartedAt: null } }
    );
    logger.info('LOCK_RELEASED', { leadId });
}

/**
 * Wrapper principal: executa fn() com lock exclusivo no lead.
 * Se não conseguir o lock, retorna { locked: false }.
 * 
 * Uso:
 *   const result = await withLeadLock(leadId, async (lead) => {
 *     // ... processar mensagem com segurança
 *     return { response: '...' };
 *   });
 */
export async function withLeadLock(leadId, fn) {
    const lead = await acquireLock(leadId);

    if (!lead) {
        return { locked: false, reason: 'LOCK_UNAVAILABLE' };
    }

    try {
        const result = await fn(lead);
        return { locked: true, ...result };
    } catch (error) {
        logger.error('LOCK_EXECUTION_ERROR', { leadId, error: error.message });
        throw error;
    } finally {
        await releaseLock(leadId);
    }
}

export default { withLeadLock };
