// utils/txnConflict.js
// Conflito de escrita entre transações (WriteConflict, código 112, ou rótulo
// TransientTransactionError). Acontece quando duas requisições tentam mudar o
// MESMO documento ao mesmo tempo: o MongoDB aborta uma delas inteira, então
// nada dela foi gravado. A resposta certa é 409 "em andamento, repita" (o
// cliente repete com a mesma chave e recebe o resultado gravado), nunca 500.

export const IN_PROGRESS_CODE = 'PAYMENT_IN_PROGRESS';

export function isTransactionConflict(err) {
    if (!err) return false;
    if (err.code === 112 || err.codeName === 'WriteConflict') return true;
    const labels = err.errorLabels || err.errorLabelSet;
    if (labels && (labels.includes?.('TransientTransactionError') || labels.has?.('TransientTransactionError'))) return true;
    if (typeof err.hasErrorLabel === 'function' && err.hasErrorLabel('TransientTransactionError')) return true;
    return /Write conflict/i.test(String(err.message || ''));
}
