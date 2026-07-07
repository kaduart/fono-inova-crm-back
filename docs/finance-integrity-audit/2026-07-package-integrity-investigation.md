# Investigação de integridade financeira de pacotes — 2026-07-07

## Contexto

A investigação começou com um pedido pontual: analisar o débito da paciente **Isis Caldas
Rebelatto** (`685b0cfaaec14c7163585b5b`). No processo, apareceram divergências entre o
que o dashboard mostrava (`sessionDebt`, `/pending-payments`) e o que a clínica sabia por
fichas físicas de atendimento. Investigar essas divergências uma a uma revelou padrões que
se repetiam em outros pacientes — a decisão foi então generalizar a investigação pra toda
a base, em vez de corrigir só a Isis.

## Escopo analisado

- 836 `Appointment` com `operationalStatus: completed`, `billingType: particular` (ou vazio),
  vinculados a algum `Package`.
- Após excluir `Package.model in [liminar, convenio]` (fora do escopo desta análise — têm
  regra financeira própria, ver `classification-rules.md`): **790 analisados**.

## Metodologia

- **Payment é a fonte de verdade financeira**, não `Appointment.paymentStatus` nem
  `Package.balance`/`totalPaid` (esses últimos têm campos que ficam desatualizados —
  confirmado durante a investigação: vários pacotes tinham `balance` que não batia com
  `totalValue - totalPaid`).
- `Package.model` (não `paymentType` sozinho) define o comportamento financeiro esperado —
  ver `classification-rules.md` pra detalhe. Esse foi o ponto que gerou o falso positivo
  do caso Enthony (ver `evidence/enthony-case.md`).
- Toda comparação de valor usa tolerância de R$1 (arredondamento).

## Linha do tempo dos achados

1. **Isis — débito não reconciliado**: `/summary.sessionDebt` (R$2.440) divergia de
   `/pending-payments` (R$1.990). Causa: 3 sessões completed sem nenhum `Payment`
   associado (nem pago, nem pendente).
2. **Isis — sessão de TO sumida**: ficha física mostrava sessão de Terapia Ocupacional em
   29/05/2026 que não existe em nenhuma coleção (`Appointment`, `Session` ou `Payment`).
   Continua sem solução — precisa ser criada pelo fluxo oficial.
3. **Isis — par contaminado (22/05 e 25/05)**: dois `Appointment` com campos de
   especialidade/médico/pacote incompatíveis entre si, `paymentOrigin: manual_recovery`,
   sem `createdAt`, sem `history`, sem `Session` — assinatura de escrita manual direta no
   MongoDB (não passou por nenhum código do repositório), feita em **2026-05-29 23:33:29**.
   Payment vinculado tem `status: consumed`, inválido pra pacote per-session.
4. **Bug ativo identificado (já corrigido)**: rota de fallback V1
   (`routes/appointment.v2.js`, endpoint `PATCH /:id/complete`) rotulava
   `paymentStatus: package_paid` pra qualquer pacote não-convênio, sem checar
   `per_session` vs `prepaid`. Esse fallback só é acionado quando
   `FeatureFlags.COMPLETE.USE_V2` está desligado — e havia um incidente documentado
   (2026-07-02) de env var ausente que ativava esse fallback silenciosamente. O fix do
   dia 02/07 (default seguro pro flag) matou esse bug de raiz — ver evidência de que
   nenhum caso novo apareceu depois dessa data.
5. **Descoberta arquitetural**: existem *pelo menos dois* scripts de correção rodados
   direto em produção, sem estarem versionados no repositório
   (`paymentOrigin: manual_recovery` e `backfill_operational_status_completed`,
   este último rodado em 2026-07-03 20:37, tocando 29 appointments de uma vez). Ambos
   corrigiram sintomas (`operationalStatus`) sem corrigir a causa (`Payment` ausente ou
   com status errado).
6. **Generalização pra base inteira**: rodado `domain-health-check.js` e depois
   `package-completion-integrity-report-v2.js` nos 790 appointments. Resultado inicial
   apontava 29 casos de "duplicidade provável" — 17 deles concentrados num único
   paciente (Enthony), o que motivou a investigação de caso único que revelou o
   problema de classificação (liminar tratado como prepaid).
7. **Correção do classificador** (`utils/packageFinancialModel.js`) e reprocessamento:
   duplicidade real caiu de 29 para 12.

## Resultado final (após execução)

```
Input:                                   836 appointments
Fora de escopo (liminar/convênio):        46
Analisados:                              790

OK (já correto ou corrigido):            700
VENDA_DE_PACOTE_MAL_ROTULADA:             35  (não é risco — Payment é a venda do pacote, só referenciado na sessão errada)
INDETERMINADO:                            24  (fila de auditoria)
DUPLICIDADE_PROVAVEL:                     12  (fila de auditoria)
SEM_FONTE_FINANCEIRA:                     11  (fila de auditoria — inclui padrão Isis)
STATUS_INVALIDO:                           8  (fila de auditoria — inclui os 2 casos da Isis)

Correções aplicadas:                     426 (só sync de paymentStatus/Session.payment)
Payments criados:                          0
Payments alterados:                        0
Valores financeiros alterados:             0
Conflitos de concorrência:                 0
```

## O que ainda está pendente

- **55 casos na fila `AUDIT_REQUIRED`** (`AuditLog.action = package_completion_audit_required`)
  — decisão humana necessária caso a caso, seguindo o mesmo processo usado no caso Enthony
  (ver `inspect-package-patient-integrity.js`).
- **Sessão de TO da Isis (29/05)** — precisa ser criada pelo fluxo oficial.
- **Par contaminado da Isis (22/05, 25/05)** — decisão pendente: normalizar (criar Session
  faltante + corrigir Payment.status) depois de confirmar com a clínica se foi pago ou fiado.
- **Fallback V1** — em observação via `GET /api/v2/health/complete-fallback?days=21`.
  Só remover depois de 2-3 semanas sem novas ocorrências + regressão verde.
- **35 casos de "venda de pacote mal rotulada"** — não é risco financeiro, mas o vínculo
  `Payment.appointment` está tecnicamente errado (aponta pra uma sessão em vez de
  representar a venda do pacote como um todo). Baixa prioridade.
