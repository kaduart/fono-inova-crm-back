# RCA: memória crítica na API (crm-backend) — 09/11/2026

## Sintoma (log do Render, 17h50 BRT)
- `rss=478/512MB (93.4%)`, `memory_critical` a cada minuto; heap só em 51% (262/515 MB).
- node-cron `missed execution`; AppointmentRecovery, EventReaper e CommunicationReconciliation
  levando ~60 s para consultas que retornam vazio (CPU/event loop sufocados).
- `[PatientProjectionWorker][ERROR] 💥 Worker error: [object Object] {}` no log da **API**.
- Front com timeout de 15 s ao criar pacote.

## Causas
1. **API consumindo a fila `patient-projection`.** `domains/clinical/workers/patientProjectionWorker.js`
   fazia `export const patientProjectionWorker = new Worker(...)` no topo do arquivo.
   `routes/patient.v2.js` importa `getProjectionWorkerStatus` desse arquivo, então o Worker nascia
   no boot da API, em paralelo ao do crm-worker (grupo `clinical`). Cada criação de pacote,
   pagamento ou cancelamento gera rebuild completo da `PatientsView` (concorrência 2) — e metade
   deles rodava no processo que atende o front. Confirmado instrumentando o `bullmq` no boot:
   antes `##WORKER patient-projection` aparecia; depois, nenhum Worker é criado na API.
2. **Bibliotecas do Google carregadas no boot sem uso.** `routes/google-ads.js` → `services/google-ads.js`
   importava `google-ads-api` (~102 MB de heap / ~174 MB de RSS só no import) e `routes/google-auth.js`
   importava `googleapis` (~56 MB / ~107 MB). Essas rotas são usadas raramente.
3. Logs verbosos de `calculateAvailableSlots` (array inteiro de slots com nome de paciente a cada
   consulta de horários).

## Correção
- Worker de projeção de paciente criado só por `startPatientProjectionWorker()` (chamado pelo
  `workers/registry.js`). Status/métricas leem a fila via `getQueue`. Testes e rota de debug usam
  `processPatientProjectionJob()` sem criar Worker.
- `google-ads-api` e `googleapis` com `import()` sob demanda (cliente em cache após a 1ª chamada).
- Logs de `calculateAvailableSlots` só com `LOG_VERBOSE=true`.

## Medição (boot local, mesmas variáveis, sem Mongo)
| | RSS | heap usado |
|---|---|---|
| antes | 352 MB | 237 MB |
| depois | 198 MB | 94 MB |

## Próximos passos (não feitos aqui)
- A API ainda importa `whatsapp-web.js`/puppeteer via `services/whatsappWebJsService.js` (~48 MB RSS).
- `config/bullConfig.js` cria 7 `QueueEvents` (uma conexão Redis bloqueante cada) no import.
