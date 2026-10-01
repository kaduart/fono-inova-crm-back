# Checklist de deploy — backend

> O deploy do WhatsAppOrchestrator tem doc próprio: [DEPLOY.md](./DEPLOY.md).
> Este checklist cobre passos de **banco/índices** que NÃO acontecem sozinhos em produção.

## Índices (autoIndex é DESLIGADO em produção)

`server.js` conecta com `autoIndex: process.env.NODE_ENV !== 'production'`. Índice declarado no
schema não é criado no Render — precisa de passo explícito.

| Quando | Script | Por quê |
|--------|--------|---------|
| Antes de usar **Despesas fixas** pela 1ª vez (e em qualquer banco novo) | `node scripts/ensureFixedExpenseIndex.js --dry-run` → depois sem `--dry-run` | Índice único parcial `{fixedExpenseId, competenceMonth}` em `expenses`: impede 2 gerações concorrentes de criarem a mesma fixa no mês |

Regras dos scripts de índice:
- sempre rodar `--dry-run` primeiro e conferir a saída;
- idempotentes (rodar de novo é seguro); abortam se o índice existir com definição diferente ou se houver duplicata;
- não derrubam índice existente.

Obs.: o índice da lista de interesse de convênios é garantido no boot (`ensureConvenioWaitlistIndexes`);
o de despesas fixas é por script (passo manual acima).

## Geração automática de despesas fixas (cron)

- Cron `fixedExpenseGeneration` (registrado em `config/cronManager.js` → `startAllCrons()`), roda no **crm-backend**
  (não no crm-worker — a janela 07:30–19:10 do ADR-022 / invariante #30 não se aplica).
- Agenda: a cada 6h (00:20, 06:20, 12:20, 18:20 BRT) + catch-up ~90 s após o boot. Completa só o **mês corrente**;
  nunca gera meses passados.
- Sem variável de ambiente nova. Desligar: `ENABLE_CRONS=false` desliga TODOS os crons do processo (não só este).
- ⚠️ **Ordem de deploy:** o cron cria as fixas do mês como `pending` logo após o boot. Só pode ir ao ar junto
  com a regra de caixa da H2 ("caixa = só pagas por `financialDate`") — hoje o cashflow/dashboard contam despesa
  pendente. Não habilitar isolado.
- Ordem: (1) índice — ver seção "Índices" acima (rodar `--dry-run` antes), (2) deploy, (3) conferir os itens abaixo.
  (Pendente: trocar o script para "padrão dry-run; escrever exige `--apply` + `CONFIRM_PROD=1`" — decisão do PO ainda não implementada.)

## Verificação pós-deploy (despesas fixas)

- [ ] `GET /api/v2/fixed-expenses` responde 200 (autenticado)
- [ ] log `[CronManager] ✅ Iniciando cron: fixedExpenseGeneration` no boot do crm-backend
- [ ] ~90 s depois: log `[FixedExpenseCron] ... concluído` (ou "nenhum modelo a gerar") sem alerta `fixed_expense_generation_failed`
- [ ] "Gerar fixas" duas vezes seguidas: a 2ª retorna `created: []`
