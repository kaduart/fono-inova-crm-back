// utils/afterCommit.js
// Efeitos colaterais (projeções/read-models, cache) que só podem rodar DEPOIS
// do commit da transação.
//
// Achado real (2026-10-30, guia 15809471): PaymentLifecycleService.cancelPayment
// atualizava PaymentsView + cache DENTRO da transação da cascata de guia, fora
// da session (outra conexão do pool, ~400ms por Payment). Com 20 agendamentos a
// transação passou de 14s no Render free, estourou o timeout do front e, quando
// abortava por WriteConflict, a PaymentsView já tinha sido marcada cancelada
// com o Payment ainda pendente.
//
// Uso: registerAfterCommit(session, fn). Se a session veio de
// runTransactionWithRetry, fn roda após o commit (em background, sequencial,
// erros só logados) e é descartada se a transação abortar. Sem registro
// (session de outro helper ou sem session) devolve false — o chamador mantém o
// comportamento antigo e roda inline.

const TASKS_KEY = '__afterCommitTasks';

export function enableAfterCommit(session) {
  if (session) session[TASKS_KEY] = [];
}

export function registerAfterCommit(session, fn) {
  if (!session || !Array.isArray(session[TASKS_KEY])) return false;
  session[TASKS_KEY].push(fn);
  return true;
}

export function discardAfterCommit(session) {
  if (session && Array.isArray(session[TASKS_KEY])) session[TASKS_KEY] = [];
}

export function flushAfterCommit(session) {
  const tasks = (session && session[TASKS_KEY]) || [];
  if (session) session[TASKS_KEY] = [];
  if (tasks.length === 0) return;
  // Sequencial e sem await do chamador: não segura a resposta HTTP nem
  // dispara N leituras paralelas no pool.
  (async () => {
    for (const task of tasks) {
      try {
        await task();
      } catch (err) {
        console.error('[afterCommit] Falha em efeito pós-commit (non-fatal):', err?.message || err);
      }
    }
  })();
}
