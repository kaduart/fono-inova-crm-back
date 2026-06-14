# Sprint 3.7 — Governança de Comissão

> **Status:** Implementado em 12/06/2026
>
> **Escopo:** permitir configurar regras de comissão por profissional (fixo/percentual, por tipo de atendimento, convênio e vigência) e usar essas regras no cálculo de comissão do Centro de Resultado.

---

## Motivação

Antes desta sprint, o cálculo de comissão dependia de campos fixos em `Doctor.commissionRules`:

- `standardSession`
- `evaluationSession`
- `neuropsychEvaluation`
- `byInsurance` (Map)

Isso não conseguia representar cenários reais como:

- Profissional A: Particular R$ 60, Convênio Unimed R$ 45, Avaliação R$ 100.
- Profissional B: Particular 50%, Convênio 40%.
- Profissional C: Unimed R$ 30, Hapvida R$ 25, Particular 60%.

Agora cada profissional possui um array de regras configuráveis.

---

## Modelo de dados

`Doctor.commissionRules` foi expandido com um array `rules`:

```js
commissionRules: {
  standardSession: 60,           // fallback legado
  evaluationSession: 0,          // fallback legado
  neuropsychEvaluation: 1200,    // fallback legado
  byInsurance: {},               // fallback legado
  rules: [{
    _id: ObjectId,
    serviceType: 'session' | 'evaluation' | 'neuropsychological' | 'aba' | 'psychology' | 'speech',
    billingType: 'particular' | 'convenio' | 'liminar' | 'package',
    insurance: String | null,    // nome do convênio quando billingType = 'convenio'
    commissionType: 'fixed' | 'percentage',
    value: Number,
    startDate: Date | null,
    endDate: Date | null,
    active: Boolean,
    notes: String
  }]
}
```

Campos antigos foram mantidos para **backward compatibility**.

---

## Motor de regras

`back/services/commissionRule.service.js` centraliza:

- `classifySessionForCommission(session)`
- `findApplicableCommissionRule(doctor, session, sessionDate)`
- `calculateSessionCommission(doctor, session, sessionDate)`
- `calculateCommissionBatch(doctor, sessions)`
- CRUD de regras

### Prioridade de matching

1. Regra ativa dentro da vigência (`startDate`, `endDate`).
2. Match exato de `billingType` + `serviceType` + `insurance`.
3. Match de `billingType` + `serviceType` genérico.
4. Fallback para campos legados (`standardSession`, `evaluationSession`, `byInsurance`).
5. Fallback hardcoded: neuropediatria 80%.

---

## Endpoints

Base: `/api/v2/professionals/:id`

| Método | Rota | Descrição | Autorização |
|---|---|---|---|
| GET | `/:id/commission-rules` | Lista regras do profissional | admin, secretary |
| POST | `/:id/commission-rules` | Cria nova regra | admin |
| PATCH | `/:id/commission-rules/:ruleId` | Atualiza regra | admin |
| DELETE | `/:id/commission-rules/:ruleId` | Remove regra | admin |

O `GET /api/v2/doctors/:id` agora também retorna `commissionRules`.

---

## Integração com cálculo de comissão

### `commissionService.calculateDoctorCommission`
Agora usa `calculateCommissionBatch` do `commissionRule.service`.

### `professionalFinancial.service`
A função `calculateCommissionForDoctor` foi simplificada para usar `calculateCommissionBatch`, eliminando duplicação de lógica.

### `financialExpenseWorker`
A lógica local de cálculo de comissão foi substituída por `calculateSessionCommission` do `commissionRule.service`.

---

## Congelamento no fechamento

`ProfessionalSettlement.snapshot` agora inclui:

```js
snapshot: {
  ...,
  commissionRules: { /* regras vigentes no momento do fechamento */ }
}
```

Isso garante que fechamentos históricos não mudem quando as regras forem alteradas no futuro.

---

## Frontend

### Nova aba no modal de edição do profissional

Caminho: **Gestão → Profissionais → Editar → Aba "Comissões"**

Componentes:

- `front/src/components/ManageDoctors/DoctorCommissionRulesTab.tsx`
- `front/src/components/ManageDoctors/DoctorForm.tsx` (reorganizado em tabs)

Funcionalidades:

- Listar regras em tabela.
- Adicionar nova regra (tipo de atendimento, serviço, convênio, tipo de comissão, valor, status).
- Editar regra existente.
- Remover regra.
- Regras são persistidas ao salvar o profissional (`PUT /api/v2/doctors/:id`).

### Tipagens

Atualizadas em:

- `front/src/utils/types/types.ts`
- `front/src/services/doctorService.ts`

Novo service:

- `front/src/services/professionalCommissionService.ts` (CRUD via endpoints dedicados).

---

## Testes

`back/tests/unit/commissionRule.service.test.js` cobre:

1. Classificação de sessões (particular, convênio).
2. Matching de regras específicas.
3. Cálculo fixo e percentual.
4. Fallback legado.
5. Neuropediatria percentual.
6. Regras inativas.
7. Neuropsicologia em batch.

Rodar:

```bash
cd back
npx vitest run tests/unit/commissionRule.service.test.js
```

---

## Pontos de atenção futuros

- `Session.commissionValue` continua sendo calculado em hooks e usado por `financialMetrics.service.js`. Isso é um gap conhecido que deve ser endereçado na **Sprint Finance Core** de consolidação financeira.
- `financialMetrics.calculateCommissions` deve migrar para usar `commissionService.calculateDoctorCommission` ou `commissionRule.service`.
- O campo `byInsurance` legado pode ser migrado para regras formais via script de migração quando a clínica validar o novo modelo.

---

## Próximo passo sugerido

Após validação em staging:

1. Cadastrar regras reais para 2-3 profissionais.
2. Comparar comissão calculada pelo Centro de Resultado vs. planilha manual.
3. Quando validado, migrar `byInsurance` legado para regras formais.
