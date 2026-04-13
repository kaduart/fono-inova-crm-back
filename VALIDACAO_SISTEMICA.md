A partir desta alteração, NÃO valide apenas o endpoint isolado.

Quero que você atue em modo de VALIDAÇÃO SISTÊMICA (nível SaaS real).

🎯 OBJETIVO:
Garantir que a mudança não quebre o fluxo completo do sistema.

---

## 🧱 FLUXO OBRIGATÓRIO A VALIDAR (end-to-end):

Identifique e valide todo o fluxo afetado, por exemplo:

- criação → processamento → persistência → sync entre entidades
- eventos (worker / queue)
- atualizações em outras collections
- impacto no ledger (se financeiro)
- impacto no dashboard / projections
- impacto em reconciliation / auto-fix

---

## 🔍 REGRAS DE VALIDAÇÃO:

1. NÃO confiar apenas no response da API
2. Validar estado final no banco (source of truth)
3. Validar consistência entre entidades relacionadas
4. Garantir que workers/eventos processaram corretamente
5. Validar que não existem side effects quebrados
6. Identificar possíveis inconsistências futuras (não só atuais)

---

## 🧪 CHECKLIST OBRIGATÓRIO:

Depois da mudança, responda:

- [ ] Fluxo principal funciona end-to-end
- [ ] Payment ↔ Appointment sincronizados (se existir)
- [ ] Ledger atualizado corretamente (se aplicável)
- [ ] Dashboard reflete estado correto
- [ ] Worker processou eventos corretamente
- [ ] Não há dados órfãos ou inconsistentes
- [ ] Reconciliation não precisa corrigir o fluxo

---

## 🚨 SE ENCONTRAR PROBLEMA:

- explique onde o fluxo quebra
- indique a causa sistêmica (não só bug local)
- sugira correção arquitetural (não só patch)

---

## 🧠 MODO DE RESPOSTA:

Quero uma análise como engenheiro de sistemas distribuídos:
não como debug de função isolada.

Priorize consistência do sistema acima de performance ou estética de código.

Após execução do fluxo, validar:

- estado final no Mongo (source of truth)
- ledger consistente
- dashboard consistente
- projection consistente
- ausência de correção por reconciliation
- ausência de eventos pendentes em worker