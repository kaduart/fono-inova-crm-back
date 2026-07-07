# Decision Log — Finance Integrity Audit

## DEC-001

**Data:** 2026-07-07
**Decisão:** `Payment` permanece a fonte única de verdade financeira. `Appointment.paymentStatus`,
`Session.paymentStatus` e `Package.balance/totalPaid` são estado sombra — podem ficar
desatualizados e não devem ser usados como fonte pra decisão financeira ou de auditoria.
**Motivo:** confirmado na investigação que `Package.balance` diverge de `totalValue - totalPaid`
em múltiplos pacotes (campo não recalculado após updates diretos). Já era diretriz do projeto
(`FINANCIAL_SOURCE_OF_TRUTH.md`), esta investigação apenas confirma com evidência nova.

## DEC-002

**Data:** 2026-07-07
**Decisão:** Pacotes `model: liminar` não participam da heurística de duplicidade usada pra
pacotes prepaid comuns.
**Motivo:** pagamento judicial periódico (`package_receipt`) e reconhecimento de receita por
sessão consumida (`recognizeRevenue.js`) são dois eventos financeiros legítimos e
independentes no modelo liminar. Tratá-los com a regra do prepaid gerou 17 falsos positivos
de "cobrança duplicada" num único paciente (ver `evidence/enthony-case.md`).
**Como aplicar:** sempre passar o `Package` por `classifyPackageFinancialModel()` antes de
qualquer análise financeira; nunca usar `paymentType` isolado.

## DEC-003

**Data:** 2026-07-07
**Decisão:** Não remover o fallback V1 de `routes/appointment.v2.js` imediatamente, mesmo
com o bug do `package_paid` identificado e sem evidência de uso desde 02/07.
**Motivo:** o fallback existe como rede de segurança pra quando o V2 falha. Removê-lo sem
janela de observação elimina a rede de segurança antes de provar que ela é dispensável.
**Critério de remoção:** `GET /api/v2/health/complete-fallback?days=21` retornando
`success: true` (zero ocorrências no `AuditLog`) por 2-3 semanas + suíte de regressão verde.

## DEC-004

**Data:** 2026-07-07
**Decisão:** Corrigir automaticamente só os 426 casos classificados como pura
desnormalização (Payment já existe e é a fonte de verdade; só o rótulo/referência do
Appointment/Session estava desatualizado). Não tocar em nenhum caso onde exista
julgamento financeiro (duplicidade, ausência de fonte, status inválido).
**Motivo:** correção determinística sem risco — o dinheiro já está corretamente registrado
em algum lugar, só falta sincronizar o espelho. Casos com julgamento financeiro exigem
decisão humana (ex.: "essa sessão foi paga ou fiada?" não é uma pergunta que o banco
responde sozinho).
**Salvaguardas aplicadas:** `before`/`after` completo no `AuditLog` de cada mudança +
checagem otimista (revalida estado atual antes de escrever, pula e loga conflito se algo
mudou entre o dry-run e a execução).

## DEC-005

**Data:** 2026-07-07
**Decisão:** Os 55 casos que exigem julgamento financeiro (`DUPLICIDADE_PROVAVEL`,
`INDETERMINADO`, `SEM_FONTE_FINANCEIRA`, `STATUS_INVALIDO`) ficam registrados em
`AuditLog` (`action: package_completion_audit_required`, `severity: WARNING`) e **não são
corrigidos automaticamente**.
**Motivo:** cada um exige o mesmo tratamento manual dado ao caso Enthony e à Isis —
confirmar contra a realidade (pacote realmente é o que o banco diz? a sessão foi paga?)
antes de qualquer escrita. Automatizar isso seria repetir o erro que gerou o falso
positivo do Enthony, em escala.

## DEC-006

**Data:** 2026-07-07
**Decisão:** Os 3 registros de origem manual identificados nesta investigação (2 da Isis,
com `paymentOrigin: manual_recovery`, e o lote de 29 do backfill de 2026-07-03) não são
scripts versionados no repositório.
**Motivo:** confirmado por busca textual completa no código — nenhum arquivo gera essas
strings/padrões. Foram escritas manuais diretas no MongoDB (via mongosh/Compass ou script
não commitado).
**Ação decorrente:** nenhuma correção de dado foi feita via novo script ad-hoc não
versionado. Toda correção desta investigação está em `back/scripts/`, commitada, com
dry-run por padrão. Recomenda-se restringir acesso de escrita direto ao cluster de
produção a partir daqui — ver ponto aberto na seção "Próximos passos" do documento
principal.
