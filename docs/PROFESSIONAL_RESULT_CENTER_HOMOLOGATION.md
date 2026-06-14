# Plano de Homologação — Centro de Resultado dos Profissionais

> **Sprint 3.5 — Homologação Financeira**
>
> Objetivo: validar os números do novo domínio financeiro por profissional antes de construir o Dashboard.

---

## Por que homologar antes do Dashboard

Até aqui construímos:

```text
Reconciliation
↓
ProfessionalFinancialService
↓
ProfessionalAdvance
↓
ProfessionalSettlement
```

Tudo isso pode ser recalculado. O `ProfessionalSettlement` é o primeiro artefato histórico.

O risco agora não é técnico — é de **interpretação dos números reais**.

---

## Checklist de homologação

### 1. Reconciliação global

Executar:

```bash
node scripts/run-reconciliation.js \
  --start=2026-06-01 \
  --end=2026-06-30
```

Validar:

- [ ] Produção total parece razoável?
- [ ] Recebido total parece razoável?
- [ ] Diferença é explicável (convênio, liminar, pendências)?
- [ ] Quantidade de sessões órfãs é aceitável?
- [ ] Quantidade de pagamentos órfãos é aceitável?
- [ ] Divergências de comissão são conhecidas?

### 2. Reconciliação por profissional (mínimo 3)

Escolher 3 profissionais representativos:

1. Um com alto volume.
2. Um com volume médio.
3. Um com convênio/liminar.

Executar para cada um:

```bash
node scripts/run-reconciliation-doctor.js \
  --doctor=<id> \
  --start=2026-06-01 \
  --end=2026-06-30
```

Validar por profissional:

- [ ] Produção bate com o esperado.
- [ ] Recebido bate com o esperado.
- [ ] Comissão bate com a regra do profissional.
- [ ] Pendente é explicável.
- [ ] Detalhamento por paciente faz sentido.

### 3. Preview de fechamento

Para um dos profissionais:

```bash
curl -H "Authorization: Bearer <token>" \
  "https://<api>/api/v2/professionals/<id>/settlements/preview?month=6&year=2026"
```

Validar:

- [ ] Valores do preview batem com a reconciliação.
- [ ] Adiantamentos listados estão corretos.
- [ ] Não há problemas financeiros críticos.

### 4. Fechamento de teste

Para um dos profissionais:

```bash
curl -X POST -H "Authorization: Bearer <token>" \
  -H "Content-Type: application/json" \
  -d '{"month":6,"year":2026}' \
  "https://<api>/api/v2/professionals/<id>/settlements/close"
```

Validar:

- [ ] Settlement foi criado com status `closed`.
- [ ] Snapshot está completo.
- [ ] Adiantamentos foram vinculados.
- [ ] Adiantamentos vinculados não podem mais ser cancelados.

### 5. Histórico de fechamentos

```bash
curl -H "Authorization: Bearer <token>" \
  "https://<api>/api/v2/professionals/<id>/settlements"
```

Validar:

- [ ] Fechamento aparece no histórico.
- [ ] Snapshot pode ser consultado.

### 6. Cenário com adiantamento

Para um profissional de teste:

```bash
curl -X POST -H "Authorization: Bearer <token>" \
  -H "Content-Type: application/json" \
  -d '{"amount":500,"date":"2026-06-15","type":"advance","notes":"teste homologação"}' \
  "https://<api>/api/v2/professionals/<id>/advances"
```

Validar:

- [ ] Summary reflete o adiantamento.
- [ ] Balance = commission - advances.
- [ ] Adiantamento aparece na lista.
- [ ] Cancelamento funciona.

---

## Resultados da homologação — 12/06/2026

### Reconciliação de junho/2026

```bash
node scripts/run-reconciliation.js --start=2026-06-01 --end=2026-06-30
```

Saída corrigida:

```text
Produção:           R$ 21.851,00
Recebido:           R$ 25.841,84
Diferença:          R$ -3.990,84
Comissão:           R$ 9.549,00
Sessões realizadas: 128
Sessões com pagto:  55
Sessões sem pagto:  73
  ├─ Pacotes:       47
  ├─ Convênios:     25
  ├─ Part. pendente: 1
  ├─ Liminar:       0
  └─ Problema real: 0
A receber:          R$ 10.110,00
  ├─ Pacotes:       R$ 7.130,00
  ├─ Convênios:     R$ 2.850,00
  ├─ Part. pendente: R$ 130,00
  └─ Liminar:       R$ 0,00
Pagamentos órfãos:  19
```

### Correções aplicadas

1. **Reclassificação das sessões sem pagamento**
   - Antes: 73 sessões órfãs.
   - Depois: 47 pacotes + 25 convênios + 1 particular pendente + 0 liminar + 0 problema real.
   - Regra centralizada em `back/utils/classifyPendingSession.js`.

2. **Fonte da comissão**
   - Antes: `Session.commissionValue` (sempre `null` em produção → R$ 0,00).
   - Depois: `commissionService.calculateDoctorCommission()` → valores reais por profissional.
   - `ProfessionalFinancialService` agora usa a comissão calculada no `balance`.

3. **Visão "a receber" por categoria**
   - `receivables` agora mostra pacotes, convênios, particular pendente e liminar.
   - Explica a diferença negativa entre produção e recebido no mesmo mês.

### Problemas reais restantes

Nenhuma sessão completada sem explicação. Os 19 pagamentos órfãos continuam como débito de pacotes/convênios antigos ou pagamentos avulsos sem sessão vinculada — devem ser investigados separadamente.

### Próxima ação

Aprova a **Sprint 4 — Dashboard do Centro de Resultado dos Profissionais**.

---

## Critérios de aprovação

A homologação está aprovada quando:

1. **3 profissionais** validados com diferença explicável.
2. **1 fechamento** de teste executado com sucesso.
3. **1 adiantamento** criado, refletido no saldo e cancelado.
4. Nenhum problema financeiro **não explicado**.

---

## Rollback / Limpeza após validação

> **IMPORTANTE:** após validar, todos os dados de teste devem ser removidos para não gerar furos de caixa nem distorcer análises futuras.

### 1. Cancelar o fechamento de teste

```bash
curl -X PATCH -H "Authorization: Bearer <token>" \
  -H "Content-Type: application/json" \
  -d '{"reason":"homologação - rollback"}' \
  "https://<api>/api/v2/professionals/<id>/settlements/2026/6/cancel"
```

Isso:
- mantém o registro histórico com status `cancelled`;
- desvincula os adiantamentos do fechamento;
- permite reabrir o período futuramente.

### 2. Cancelar o adiantamento de teste

```bash
curl -X PATCH -H "Authorization: Bearer <token>" \
  -H "Content-Type: application/json" \
  -d '{"reason":"homologação - rollback"}' \
  "https://<api>/api/v2/professionals/<id>/advances/<advanceId>/cancel"
```

### 3. Verificar que o summary voltou ao estado original

```bash
curl -H "Authorization: Bearer <token>" \
  "https://<api>/api/v2/professionals/<id>/summary?startDate=2026-06-01&endDate=2026-06-30"
```

- [ ] `advances` deve estar zerado (ou igual ao valor real anterior).
- [ ] `balance` deve refletir apenas comissão real.

### 4. Verificar histórico

```bash
curl -H "Authorization: Bearer <token>" \
  "https://<api>/api/v2/professionals/<id>/settlements"
```

- [ ] Fechamento de teste aparece como `cancelled`.
- [ ] Não há fechamento `closed` para o período de teste.

### 5. Se necessário, limpar diretamente no banco

Caso o cancelamento via API não seja suficiente, executar em ambiente controlado:

```js
db.professionalsettlements.deleteOne({ doctor: ObjectId('<id>'), periodMonth: 6, periodYear: 2026 });
db.professionaladvances.deleteMany({ doctor: ObjectId('<id>'), notes: /homologação/i });
```

**Apenas em produção se absolutamente necessário e com backup prévio.**

---

## Após aprovação

Aprova a **Sprint 4 — Dashboard do Centro de Resultado dos Profissionais**.

---

## Reaproveitamento de frontend

Conforme análise, **60–70% da UI já existe**:

- `RankingProfissionais.tsx` → base do ranking.
- `DoctorFinancialTab.tsx` → base dos cards de resumo.
- `ListaPacientesVIP.tsx` → base do detalhamento por paciente.
- `AlertsPanel.tsx` → base do painel de saúde financeira.
- `DashboardV3Tab.tsx` → template de layout com tabs.
- `Patient360Modal.tsx` → referência para modais de detalhe.

O que falta criar:

- `professionalResultService.ts`
- `useProfessionalResult.ts`
- `pages/ProfessionalResultCenter/index.tsx`
- Componentes específicos de composição.

---

## Nota de segurança

A homologação deve ser feita por alguém da equipe com acesso ao banco de produção. Não compartilhar tokens nem dados sensíveis em logs.
