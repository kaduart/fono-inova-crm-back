# PEI: plano individual com metas

Item 5 da sprint do prontuário (03/11/2026). Leia antes de mexer em `models/PeiPlan.js`, `routes/pei.v2.js` ou
`services/clinical/peiService.js`.

## O que é
É o plano do paciente com cada profissional. Cada meta tem área, descrição, critério de medida, linha de base e alvo
(0–10), além do histórico de medições. O relatório mensal mostra o avanço de cada meta (`activeGoalsSnapshot`).

## Regras
1. **Um plano ativo por paciente e profissional** (índice único parcial `one_active_pei_per_doctor`). Criar de novo
   devolve o plano ativo, de forma idempotente.
2. O alvo precisa ser maior que a linha de base. Os valores vão de 0 a 10.
3. Medição (`POST /:id/goals/:goalId/progress`): entra no histórico e atualiza `current`. Chegar ao alvo marca a meta
   como `achieved`. Se uma medição posterior cair abaixo do alvo, a meta volta para `active`. Meta `paused` não muda
   de status sozinha.
4. Editar meta não apaga o histórico. Plano `closed` não se edita: crie um novo.
5. **Acesso:** só a equipe clínica (doctor e admin). O profissional vê e mexe só nos próprios planos; o admin vê
   todos. A secretária recebe 403.
6. `Evolution.therapeuticPlan.objectives` (o plano antigo, dentro de cada evolução) continua existindo e não é
   lido aqui. O PEI é a fonte das metas daqui em diante.

## Rotas (`/api/v2/pei`)
`GET /patient/:patientId` · `POST /` · `PUT /:id` · `POST /:id/goals/:goalId/progress` · `POST /:id/close`
