# Audit: Frontend API Usage — 2026-04-17 11:42

> Gerado por `back/scripts/audit-frontend-api-usage.js`

## 🔴 Rotas V1 ainda chamadas pelo frontend

| Rota V1 | Arquivos | V2 disponível? | Safe to disable? |
|---------|----------|----------------|-----------------|
| `/api/amanda` | 1 arquivo(s): components/mkt/whatsapp/LeadAmandaModal.tsx | ❌ sem V2 | 🔴 validar antes |
| `/api/analytics` | 1 arquivo(s): components/mkt/whatsapp/AmandaInsights.jsx | ❌ sem V2 | 🔴 validar antes |
| `/api/evolutions` | 2 arquivo(s): components/patients/PatientDashboard.tsx, components/patients/PatientEvolution.tsx | ❌ sem V2 | 🔴 validar antes |
| `/api/packages` | 1 arquivo(s): components/patients/__tests__/TherapyPackageFormModal.test.tsx | ✅ `/api/v2/packages` | 🔴 validar antes |
| `/api/provisionamento` | 1 arquivo(s): pages/Financial/tabs/ProvisionamentoTab.tsx | ❌ sem V2 | 🔴 validar antes |
| `/api/reports` | 1 arquivo(s): components/patients/PatientEvolution.tsx | ❌ sem V2 | 🔴 validar antes |

## ✅ Rotas V2 já usadas pelo frontend

| Rota V2 | Arquivos |
|---------|----------|
| `/api/v2/appointments` | 1 |
| `/api/v2/pre-appointments` | 4 |

## ⚪ Chamadas não mapeadas (verificar manualmente)

| Padrão | Arquivos |
|--------|----------|
| `/api/sessoes` | 1 |
| `/api/metrics/decision${params}` | 1 |
| `/api/chat-context/:param` | 1 |
| `${base}/api/proxy-media` | 1 |
| `/api/notifications/count` | 1 |
| `/api/notifications` | 1 |
| `/api/notifications/:param/read` | 1 |
| `/api/evaluations/availables` | 1 |
| `/api/evaluationTypes` | 1 |
| `${API_URL}/api/financial/convenio/metrics` | 1 |
| `${API_URL}/api/financial/convenio/dashboard-summary` | 1 |
| `/api/auth/forgot-password` | 1 |
| `/api/auth/reset-password/:param` | 1 |
| `/api/journey/track` | 1 |

## 📊 Resumo

| | Total |
|---|---|
| Rotas V1 ainda chamadas | 6 |
| Rotas V2 em uso | 2 |
| Rotas V1 com V2 disponível | 1 |
| Safe to disable agora | 0 |

## 🚦 Checklist de desligamento por endpoint

### `/api/packages` → `/api/v2/packages`

- [ ] Frontend não chama mais esta rota V1
- [ ] Sem tráfego em produção nos últimos 7 dias
- [ ] V2 cobre 100% dos endpoints (GET + POST + PATCH + DELETE)
- [ ] Nenhum worker/cron chama esta rota diretamente
- [ ] Comentar no server.js: `// app.use("/api/packages", ...)`
- [ ] Deploy + monitorar erros por 24h
