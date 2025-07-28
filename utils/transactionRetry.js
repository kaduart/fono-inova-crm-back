// utils/transactionRetry.js
export async function runTransactionWithRetry(transactionOperation, session, maxRetries = 3) {
    let retryCount = 0;
    let lastError = null;

    while (retryCount <= maxRetries) {
        try {
            // Executar a operação dentro da transação
            const result = await transactionOperation(session);
            return result;

        } catch (error) {
            lastError = error;

            // Verificar se é um erro transitório
            const isTransientError = error.errorLabels?.includes('TransientTransactionError');

            if (isTransientError && retryCount < maxRetries) {
                retryCount++;
                const delay = 50 * Math.pow(2, retryCount);
                await new Promise(resolve => setTimeout(resolve, delay));
                continue;
            }

            // Se não for transitório ou excedeu as tentativas, abortar
            await session.abortTransaction();
            throw error;

        } finally {
            // Não fechar a sessão aqui, será fechada pelo chamador
        }
    }

    throw lastError;
}