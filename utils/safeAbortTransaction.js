// utils/safeAbortTransaction.js
// Evita "MongoTransactionError: Cannot call abortTransaction after calling commitTransaction"
// quando código pós-commit (publish de evento, sync de view, res.json) lança erro
// dentro do mesmo try/catch de uma transação já comitada.
export async function safeAbortTransaction(session) {
    if (!session) return;
    if (!session.inTransaction()) return;
    await session.abortTransaction();
}
