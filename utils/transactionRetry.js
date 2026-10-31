import mongoose from 'mongoose';
import { enableAfterCommit, discardAfterCommit, flushAfterCommit } from './afterCommit.js';

export async function runTransactionWithRetry(transactionOperation, maxRetries = 3) {
    let retryCount = 0;
    let lastError = null;

    while (retryCount <= maxRetries) {
        const session = await mongoose.startSession();

        try {
            await session.startTransaction();
            enableAfterCommit(session);

            // Executar a operação dentro da transação
            const result = await transactionOperation(session);

            await session.commitTransaction();
            flushAfterCommit(session);
            return result;

        } catch (error) {
            discardAfterCommit(session);
            await session.abortTransaction();
            lastError = error;

            // ✅ Verificar se é um erro transitório OU write conflict (code 112)
            const isRetryableError =
                error.errorLabels?.includes('TransientTransactionError') ||
                error.code === 112; // Write conflict durante execução

            if (isRetryableError && retryCount < maxRetries) {
                retryCount++;
                const delay = 50 * Math.pow(2, retryCount); // backoff exponencial
                console.warn(`[retry] Tentativa ${retryCount}/${maxRetries} após ${delay}ms (erro: ${error.code || error.name})`);
                await new Promise(resolve => setTimeout(resolve, delay));
                continue;
            }

            // Se não for retryable ou excedeu tentativas, lançar erro
            throw error;

        } finally {
            await session.endSession();
        }
    }

    throw lastError;
}