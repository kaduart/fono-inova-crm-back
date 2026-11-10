# Metas (Planning) — o que é e regras

**O que é:** metas mensais/semanais/diárias da clínica (`models/Planning.js`). Tela: Financeiro → Resultados → Metas do ano.

## Fluxos
- `POST /api/planning/auto-generate` cria/atualiza o **mensal** e recria os semanais/diários do mês (dias úteis). Se o mensal do mês já existe, ele é **atualizado** — nunca duplicado (até 10/11/2026, `force: true` criava um segundo mensal).
- `PUT /api/planning/:id` edita uma meta (o front usa o mesmo formulário do Criar).
- `updatePlanningProgress` (services/planningService.js) recalcula o realizado.

## Por especialidade (`bySpecialty`)
- O front envia `{ specialty, sessions, revenue }`; o banco guarda `{ specialty (slug), targetSessions, targetRevenue, completedSessions, actualRevenue }`. Os virtuais `sessions`/`revenue` devolvem a meta no formato do front.
- `specialty` é o **slug** de `Appointment.specialty` (ex.: `terapia_ocupacional`). Rótulo antigo ("Terapia Ocupacional") é convertido por `utils/planningSpecialty.js`.
- Realizado por especialidade = atendimentos com `clinicalStatus: 'completed'` no período; receita = soma de `sessionValue` (**produção**, não caixa). A meta geral continua na regra do caixa (ver FINANCIAL_SOURCE_OF_TRUTH.md).
- Ao editar, o realizado já calculado é preservado até o próximo recálculo.

Testes: `utils/planningSpecialty.test.js`.
