# Comunicação com a família: resumo da sessão e relatório mensal

Itens 3 e 4 da sprint do prontuário (03/11/2026). Leia antes de mexer em `routes/monthlyReport.v2.js`,
`models/MonthlyReport.js`, `services/clinical/*` ou no bloco "RESUMO PARA A FAMÍLIA" de `routes/evolution.v2.js`.

## O que é
- **Resumo da sessão (item 4):** depois de finalizar a evolução, o terapeuta pode enviar à família um texto curto
  (2–3 frases, 1 💚) sobre a sessão e uma dica para casa. O sistema sugere o começo do texto com as áreas
  trabalhadas, e o terapeuta completa o restante.
- **Relatório mensal (item 3):** é gerado por paciente, profissional e mês. Ele traz sessões com evolução, presença,
  áreas trabalhadas (primeira e última nota do mês), metas do PEI e o texto do terapeuta (resumo e próximos passos).
  Pode ser baixado em PDF, e um aviso curto vai à família pelo WhatsApp.

## Regras (não quebrar)
1. **Nada sai sem o terapeuta.** O resumo só é enviado por ação explícita (`POST /v2/evolutions/:id/family-summary/send`).
   O relatório precisa ser aprovado (`/approve`) antes de `/send`.
2. **Só evolução finalizada.** O resumo exige `status != draft`. Os números do relatório usam `FINALIZED_FILTER`.
3. **Idempotência.** Resumo: trava atômica em `familySummary.status` + `jobId famsum-<evolutionId>`. Relatório: trava
   atômica `approved → sent` + `jobId monthly-<reportId>`. Se a fila falhar, a trava é devolvida (resumo vira
   `failed`, relatório volta para `approved`) e a resposta é 503.
4. **Texto validado** (`validateFamilyText`): 20–1000 caracteres e sem trechos entre colchetes, que são marcadores
   da sugestão.
5. **Permissão:** só o profissional dono da evolução ou do relatório, ou admin. A secretária não envia.
6. **Privacidade:** o log guarda só ids. O documento guarda só os 4 últimos dígitos do telefone (`phoneLast4`).
7. **PDF não vai pelo WhatsApp.** A fila `whatsapp-send` só manda texto. O PDF é baixado (`GET /:id/pdf`) e anexado
   manualmente quando a família pedir. O aviso diz que o relatório está pronto.
8. Editar um relatório aprovado o devolve para `draft`, e é preciso aprovar de novo. Relatório enviado não se edita.
9. Gerar de novo só atualiza os números enquanto o relatório está em `draft`. Sem evolução finalizada no mês, a
   resposta é 409 `NO_FINALIZED_EVOLUTIONS`.

## Rotas
| Rota | O que faz |
|---|---|
| `GET /api/v2/evolutions/:id/family-summary` | sugestão de texto, se já foi enviado, `canSend`/`blockReason` |
| `POST /api/v2/evolutions/:id/family-summary/send` `{text}` | enfileira (201) ou devolve o já enviado (200, `idempotent`) |
| `GET /api/v2/monthly-reports/patient/:patientId` | relatórios do paciente (do profissional; admin vê todos) |
| `POST /api/v2/monthly-reports/generate` `{patientId, month, doctorId?}` | cria ou atualiza o rascunho do mês |
| `PUT /api/v2/monthly-reports/:id` `{summary, nextSteps, familyMessage}` | edita o texto |
| `POST /api/v2/monthly-reports/:id/approve` | aprova (exige resumo) e sugere o aviso para a família |
| `POST /api/v2/monthly-reports/:id/send` `{text?}` | enfileira o aviso (só aprovado) |
| `GET /api/v2/monthly-reports/:id/pdf` | PDF (marca d'água RASCUNHO enquanto `draft`) |

## Testes
`tests/unit/family-communication.test.js`, que roda com Mongo em memória e mocka a fila.
