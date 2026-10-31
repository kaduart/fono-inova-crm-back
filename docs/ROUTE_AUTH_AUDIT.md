# Proteção de rotas (auditoria 31/10/2026, rodada 2)

O `server.js` não tem auth global: cada router precisa se proteger.
Perfis: `middleware/requireRole.js` (`requireStaff` = admin/secretária + serviço Amanda;
`requireStaffOrAgenda` = staff + token da Agenda Externa; `requireAdmin`).

| Rota | Antes | Agora |
|---|---|---|
| `POST /api/signup` | aceitava `role` do corpo | sempre `patient` (modelo User não dá login no ERP) |
| `/api/v2/liminar-contracts` | público | login; mutações staff |
| `/api/convenio-packages`, `/api/sync`, `/api/v2/totals` | público | flexibleAuth + staff |
| `/api/followups`, `/api/ai`, `/api/marketing`, `/api/imagebank`, `/api/amanda` | público | flexibleAuth + staff |
| `/api/whatsapp-web/*`, `/api/whatsapp-vps/*` | público | flexibleAuth + staff ou token da agenda (`WHATSAPP_WEB_AUTH_MODE=log` libera e só registra, para emergência) |
| `/api/import-from-agenda/limpar-*` | público | admin |
| `/api/v2/financial/patient/:id/summary`, `/batch`, `/paid-payments` | público | login; `/receive` staff |
| `/api/v2/appointments` admin-edit, reschedule, PUT, cancel, confirm, post-appointment, DELETE | qualquer JWT | staff ou agenda |
| `/api/v2/appointments/:id/complete`, `professional-payment-status` | qualquer JWT | staff |
| `/api/v2/payments` (request, multi, create-sync, PATCH, register-debit, bulk-settle, DELETE), `/api/v2/balance` debit/credit, `/api/v2/packages` mutações | qualquer JWT | staff |

Terapeuta continua criando agendamento (`POST /api/v2/appointments`), evolução, laudos e status clínico.
Teste: `tests/unit/routeAuthGuards.test.js`.
