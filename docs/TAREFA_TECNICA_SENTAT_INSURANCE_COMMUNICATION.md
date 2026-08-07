# Tarefa técnica — `sentAt` explícito em `InsuranceCommunication`

**Aberta em:** 2026-08-07
**Origem:** condição 2 da aprovação da Fase 3 da Read View de Convênios
**Status:** ABERTA — não implementar junto da Fase 3 (Fase 3 é somente leitura)

---

## O problema

O domínio precisa responder **"quando a documentação foi enviada ao convênio?"**, mas
não existe campo que registre isso. `InsuranceCommunication` tem apenas:

- `invoiceDate` — preenchido só quando há nota; hoje ausente em parte dos registros
- `createdAt` / `updatedAt` — de `timestamps: true`

Hoje a leitura usa este fallback (`insuranceGuidesReadView.js`, `documentationByGuide`):

```js
sentAt: comm.invoiceDate || comm.updatedAt,
sentAtIsProxy: !comm.invoiceDate
```

O mesmo proxy já era usado pelo `insuranceBatchGuideAdapter`.

## Por que é um proxy e não a data

`updatedAt` se move a **qualquer** edição do registro. Uma correção de número de nota
feita hoje reescreve a "data de envio" de uma documentação enviada mês passado. Ou
seja: o valor é plausível, muda sozinho, e não há como distinguir um do outro depois.

**Impacto medido em produção (2026-08-07):** 2 guias. Baixo hoje, silencioso quando crescer —
o eixo de competência da fase `documentationSent` depende dessa data.

## O que fazer

1. Adicionar `sentAt: { type: Date, default: null }` a `InsuranceCommunication`.
2. Gravar `sentAt = new Date()` no ponto em que a comunicação passa a `status: 'sent'`
   (escrita — fora do escopo da Read View).
3. Backfill dos registros existentes: `sentAt = invoiceDate || updatedAt`, marcando a
   origem do dado para não confundir backfill com registro real.
4. Na Read View, trocar o fallback por `comm.sentAt || comm.invoiceDate || comm.updatedAt`
   e manter `sentAtIsProxy` apenas para os registros anteriores ao backfill.
5. Só então remover `documentationSentAtIsProxy` do payload.

## Enquanto não for feito

O campo `documentationSentAtIsProxy` **deve continuar no payload**. Ele é o que impede
que uma data aproximada seja lida como data real na tela. Não remover antes do passo 5.

## Referências

- [insuranceGuidesReadView.js](../services/insuranceGuide/insuranceGuidesReadView.js) — `documentationByGuide`
- [PROPOSTA_LEITURA_CONVENIOS_V2.md](PROPOSTA_LEITURA_CONVENIOS_V2.md) — limitação registrada
- [InsuranceCommunication.js](../models/InsuranceCommunication.js)
