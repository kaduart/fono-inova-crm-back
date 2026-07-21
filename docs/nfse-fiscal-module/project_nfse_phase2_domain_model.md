# Módulo Fiscal NFS-e — Fase 2: Modelo de Domínio

> Documento de arquitetura de domínio (não código). Base: `project_nfse_phase1_official_spec.md`, `dps_field_matrix.md`, `event_matrix.md`, `anapolis_integration_status.md` (Fase 1 + Fase 1.5), cruzados com `back/docs/DOMAIN_INVARIANTS.md` e `back/docs/ARQUITETURA_EVENT_DRIVEN.md` do CRM.
>
> **v3 (2026-07-16)**: segunda rodada de review incorporada — `FiscalSubmission` formalizado como Aggregate próprio, `FiscalProfile` introduzido, `FiscalInvoice` desacoplado de `Payment` (via `origin` + projeção), `FiscalSnapshot` para reconstrução exata da DPS enviada, `ResolutionPolicy` configurável. Fecha com plano de execução da Fase 3 em 4 PRs.
>
> Pergunta que este documento responde: **como o domínio fiscal se encaixa no CRM sem contaminar os domínios existentes, sem acoplar a um provedor/município, e sem acoplar o Aggregate a Payment?**

---

## 0. Achado prévio que condiciona este desenho

Já existe no código `back/models/ConfiguracaoFiscal.js` (`regimeTributario: SIMPLES_NACIONAL|LUCRO_PRESUMIDO|LUCRO_REAL`), usado hoje só para cálculo de margem de `Sale`, **vazio em produção** (0 documentos, confirmado por query direta). Não resolve a pergunta pendente do regime tributário real da clínica — decisão de reaproveitar ou não fica na Seção 12 (decisões em aberto).

---

## 1. Princípio estrutural: 4 camadas

```
CRM Domain           (Payment, Package, Patient, Doctor, Invoice — já existentes)
       │  (leitura/eventos, unidirecional)
       ▼
Fiscal Domain         (FiscalInvoice, FiscalInvoiceItem, OfficialFiscalEvent,
                        FiscalSubmission [Aggregate próprio] + FiscalSnapshot,
                        FiscalAttachment, FiscalProfile, Certificate,
                        FiscalStateMachineService)
       │  (interface FiscalProvider — o domínio só conhece esta interface)
       ▼
Provider Layer        (FiscalProvider interface, FiscalProviderResolver,
                        ResolutionPolicy, ProviderTransaction)
       │
       ▼
Municipal Adapter      (AnapolisMunicipalAdapter/NotaControlAdapter,
                        SefinNacionalAdapter, MockAdapter — HTTP, assinatura, XML)
```

Regra mantida: `FiscalInvoice` nunca referencia um provedor/vendor por nome — isso vive só em `FiscalSubmission`/`ProviderTransaction`.

---

## 2. Modelo de Domínio (camada Fiscal Domain)

### 2.1 `FiscalInvoice` (agregado raiz — desacoplado de `Payment`)

**Mudança desta rodada**: removido `payments: [ObjectId → Payment]`. Um Aggregate que referencia diretamente outro Aggregate de outro domínio (Payment) acopla o ciclo de vida de ambos — se `Payment` mudar de shape, `FiscalInvoice` quebra junto. Substituído por uma referência polimórfica de origem + uma projeção separada que resolve os Payments envolvidos.

| Campo | Tipo/Ref | Nota |
|---|---|---|
| `status` | enum interno | Nunca setado diretamente — derivado de `OfficialFiscalEvent` |
| `cStat`, `ambGer`, `tpEmis` | Number | Campos oficiais do documento (não são infra) |
| `origin` | `{ type: 'package'\|'appointment'\|'invoice'\|'manual'\|'batch', id: ObjectId }` | **Substitui `payments[]` e o antigo `originType`** — referência única e polimórfica à entidade que originou a nota. Para `batch`, `id` referencia um registro leve de seleção (não uma nova coleção pesada) |
| `fiscalProfileId` | `ObjectId → FiscalProfile` | **Novo** — substitui a dependência implícita de configuração singleton (Seção 2.3) |
| `dpsId`, `chaveAcesso`, `nNFSe`, `serie` | — | Sem mudança |
| `dhEmi`, `dhProc`, `dCompet` | Date | — |
| `invoiceRef` | `ObjectId → Invoice` (opcional) | Referência informativa, nunca fusão de estado |
| `patient`, `responsibleParty`, `professional`, `packageRef` | — | Sem mudança |
| `serviceDescription`, `serviceCode`, `valorServico`, `valorLiquido`, `vISSQN` | — | Sem mudança |
| `liminarFlow` | enum | Ver Seção 6 |
| `substitutes`/`substitutedBy` | self-ref | — |
| `rejectionReason`, `correlationId`, `version` | — | — |

**Quem resolve "quais Payments participaram"**: uma **Projeção** (`FiscalInvoicePaymentProjection`, read-model/query service, não um campo persistido no Aggregate) — dado um `origin`, resolve os `Payment`s correspondentes em tempo de leitura (ex.: `origin.type='package'` → todos os Payments `paid` daquele pacote no período de competência). Isso mantém o Aggregate estável mesmo se a forma de "quais payments pertencem a um pacote" mudar no domínio Financeiro.

### 2.2 `FiscalInvoiceItem` — sem mudanças desta rodada

`description`, `quantity`, `unitValue`, `totalValue`, `session`→`Session`, `appointment`→`Appointment`, `specialty`, `doctor`→`Doctor`, `serviceDate`.

### 2.3 `FiscalProfile` (novo — substitui a ideia solta de `FiscalConfiguration` singleton)

O review identificou corretamente que faltava um nível intermediário entre "Empresa" e os detalhes fiscais/certificado — necessário para suportar matriz/filiais/múltiplos CNPJs/múltiplos municípios no futuro, sem exigir refatoração.

| Campo | Nota |
|---|---|
| `cnpj`, `razaoSocial` | Identificação do emitente deste perfil |
| `municipioIBGE` | Alimenta o `FiscalProviderResolver` (Seção 4.3) |
| `cnae`, `codigoServicoLC116` (`cTribNac`), `inscricaoMunicipal` | — |
| `regimeTributario` | Ver Seção 0 — possivelmente lido de `ConfiguracaoFiscal` existente |
| `ambiente` | `producao \| producao_restrita` |
| `certificateRef` | `ObjectId → Certificate` |
| `ativo` | Permite desativar um perfil sem apagar histórico |

`FiscalInvoice.fiscalProfileId → FiscalProfile` — nunca um singleton implícito. Hoje a clínica opera com **exatamente 1 `FiscalProfile`** (1 CNPJ, 1 município) — o custo de já modelar como coleção em vez de singleton é baixo e evita rename forçado se um dia houver filial.

### 2.4 `Certificate` — status expandido (ponto 8 do review)

| Campo | Nota |
|---|---|
| `type` | A1 \| A3/HSM |
| `passwordReference` | Referência a secret manager — nunca texto puro |
| `expiresAt`, `issuer`, `thumbprint`, `storageKey` | — |
| `status` | **Expandido**: `active \| expiring_soon \| expired \| revoked \| validating \| invalid_password \| corrupted \| import_error` — os 4 últimos cobrem falhas que ocorrem *antes* da primeira assinatura (maioria dos problemas reais, segundo o review) |

### 2.5 `OfficialFiscalEvent` — sem mudanças desta rodada

Mantido exatamente como na v2 (o review confirmou: "excelente mudança, manteria").

### 2.6 `FiscalSubmission` — formalizado como Aggregate próprio (ponto 1 do review)

Deixa de ser só "um log dentro de FiscalInvoice" e passa a ser um **Aggregate Root independente**, com sua própria coleção/repositório, referenciando `fiscalInvoiceId`. Isso separa claramente três responsabilidades que antes viviam meio misturadas:

```
FiscalInvoice           (documento tributário)
    │
    └── N FiscalSubmission     (Aggregate próprio — tentativa de execução)
            │
            ├── 1 FiscalSnapshot        (o que foi enviado, exatamente)
            └── N ProviderTransaction   (execução técnica HTTP)
```

| Campo | Nota |
|---|---|
| `fiscalInvoiceId` → `FiscalInvoice` (nullable) | Nulo se falhou antes de existir a nota |
| `providerSnapshot` | Qual implementação processou esta tentativa (nome do adapter, não do domínio) |
| `attemptNumber`, `outcome` (`success\|rejected\|network_error\|timeout`), `errorCode` | — |
| `attemptedAt` | — |

### 2.7 `FiscalSnapshot` (novo — ponto 4 do review)

A própria DPS enviada é um snapshot que precisa sobreviver a mudanças futuras nos dados de origem (endereço do paciente muda, configuração fiscal muda) — sem isso, reconstruir "o que foi exatamente enviado 5 anos atrás" exigiria regenerar a partir do estado atual, que pode já ter mudado. 1:1 com `FiscalSubmission` (cada tentativa gera seu próprio snapshot, já que uma correção entre tentativas muda o conteúdo).

| Campo | Nota |
|---|---|
| `fiscalSubmissionId` → `FiscalSubmission` | — |
| `xml`, `json` | Conteúdo exato enviado (DPS), nas duas representações |
| `hash` | Para verificação de integridade |
| `schemaVersion` | **Novo (ponto 5 do review)** — versão do leiaute/XSD usado (ex. Anexo I `v1.01-20260209`) |
| `manualVersion` | **Novo (ponto 5)** — versão do manual oficial que o `DpsBuilder` seguia no momento (rastreabilidade quando a documentação oficial mudar) |

Nota de versionamento (ponto 5 do review): três conceitos diferentes, cada um no lugar certo — `schemaVersion`/`manualVersion` aqui em `FiscalSnapshot` (o que foi construído), `providerVersion` em `ProviderTransaction` (Seção 4.2, o que o webservice respondeu usar).

### 2.8 `FiscalAttachment` — sem mudanças desta rodada

`type` (`xml_dps\|xml_nfse\|danfse_pdf\|xml_event`), `storageRef`, `hash`, `mimeType`, `size`, `generatedAt`. Continua sendo os artefatos **recebidos/gerados** pela autoridade (distinto de `FiscalSnapshot`, que é o que o CRM **enviou**).

---

## 3. Máquina de Estados — sem mudança estrutural

`FiscalInvoice.status` nunca setado diretamente — `FiscalStateMachineService` recomputa a partir do histórico de `OfficialFiscalEvent`, mesmo padrão de `transitionPaymentStatus()`. Ver v2 para o diagrama completo (inalterado).

---

## 4. Provider Layer

### 4.1 `FiscalProvider` (interface — inalterada)

```
FiscalProvider: submitDps · queryByChave · registerEvent · listEvents · getDanfse
```

### 4.2 `ProviderTransaction` — campos adicionados (ponto 7 do review)

| Campo | Nota |
|---|---|
| `fiscalSubmissionId` → `FiscalSubmission` | — |
| `attemptId` | **Novo** — identifica esta chamada específica dentro da submission |
| `traceId` | **Novo** — correlação com observabilidade/logs de infraestrutura |
| `endpoint`, `httpStatus`, `request`, `response`, `headers` | — |
| `duration` | (antes `latency` — mesmo conceito, nome alinhado ao review) |
| `tlsVersion` | **Novo** — útil quando um provedor municipal atualiza TLS e quebra clientes antigos silenciosamente |
| `certificateThumbprint` | **Novo** — qual certificado assinou *esta* chamada específica, imutável mesmo se `Certificate` girar depois |
| `providerVersion` | Versão do webservice/API reportada |
| `retryOf` → `ProviderTransaction` (self-ref, opcional) | — |

Razão (do review): esses campos "salvam dias de investigação quando aparecem problemas intermitentes com provedores municipais" — TLS e thumbprint específico da chamada são exatamente o tipo de dado que some se não for capturado no momento.

### 4.3 `ResolutionPolicy` + `FiscalProviderResolver` — motor configurável (ponto 9 do review)

Em vez de lógica hardcoded (`if regime === X → provider Y`), o resolver vira um **motor que lê política configurável**, para que uma mudança legal futura (ex.: novo prazo de migração, novo município aderindo) não exija deploy de código:

```
FiscalProfile.municipioIBGE
        │
        ▼
ResolutionPolicy (registro configurável, por município)
    { municipioIBGE, rules: [
        { condition: { regime: 'SIMPLES_NACIONAL', validFrom: null, validUntil: '2026-08-31' }, adapter: 'AnapolisMunicipalAdapter' },
        { condition: { regime: 'SIMPLES_NACIONAL', validFrom: '2026-09-01' }, adapter: 'SefinNacionalAdapter' },
        { condition: { regime: 'LUCRO_PRESUMIDO' }, adapter: 'AnapolisMunicipalAdapter' },
        { condition: { regime: 'MEI' }, adapter: 'SefinNacionalAdapter' }
      ] }
        │
        ▼
FiscalProviderResolver.resolve(fiscalProfile, date) → adapter concreto
```

`ResolutionPolicy` fica em uma coleção própria (Provider Layer), editável por configuração — não por código. Isso absorve o que na v2 era `MunicipioProviderRegistry` (mesmo papel, agora com regras condicionais em vez de mapeamento fixo 1:1).

---

## 5. Domain Events — sem mudança desta rodada

Ver v2: `PaymentSettled` consumido; `FiscalInvoiceRequested/Authorized/Rejected/Cancelled/Substituted`, `FiscalEventReceived` publicados. Continuam distintos de `OfficialFiscalEvent`.

---

## 6. `liminarFlow` — sem mudança desta rodada

Ver v2: `tax_suspension` vs. `judicial_bypass`, campo explícito, nunca inferido automaticamente.

---

## 7. Integração com Domínios Existentes (CRM Domain)

Sem mudança de fronteira, exceto que a integração com `Payment` agora passa pela projeção (Seção 2.1), não por referência direta:
- **`Payment`**: `PaymentSettled` continua o único gatilho de elegibilidade. A resolução "quais Payments compõem esta nota" é uma leitura via `FiscalInvoicePaymentProjection`, nunca um array persistido no Aggregate.
- **`Invoice`**, **`Package`**, **`Patient`/`Doctor`**: sem mudança da v2.

---

## 8. Bounded Context (atualizado)

**Fiscal Domain possui**: `FiscalInvoice`, `FiscalInvoiceItem`, `OfficialFiscalEvent`, `FiscalSubmission` (Aggregate próprio) + `FiscalSnapshot`, `FiscalAttachment`, `FiscalProfile`, `Certificate`, `FiscalStateMachineService`, `FiscalInvoicePaymentProjection` (read-model).

**Provider Layer possui**: `FiscalProvider`, `FiscalProviderResolver`, `ResolutionPolicy`, `ProviderTransaction`.

**Municipal Adapter possui**: `AnapolisMunicipalAdapter`, `SefinNacionalAdapter`, `MockAdapter`.

**Fiscal Domain NÃO possui / nunca escreve**: `Payment.status`, `Invoice.status`, `Package.financialStatus`, `Session`/`Appointment`. Não referencia `Payment` diretamente (só via projeção). Não conhece nomes de vendor.

---

## 9. Invariantes (acumuladas + novas desta rodada)

1–10: inalteradas da v2 (não fundir estado com Invoice/Payment, emissão só em `paid`, sem estorno automático, `FiscalAttachment` imutável, `OfficialFiscalEvent` append-only, `status` nunca direto, outbox antes do POST, provider nunca no Aggregate, `liminarFlow` explícito, config lida uma vez).
11. `FiscalProviderResolver` decide por município primeiro, regime depois (v2).
12. `Certificate` tem ciclo de vida próprio; nenhuma submissão com certificado fora de `active`/`expiring_soon`.
13. Segredo de certificado nunca em texto puro.
14. **Novo**: `FiscalInvoice` nunca referencia `Payment` diretamente — só via `origin` + projeção de leitura.
15. **Novo**: `FiscalSnapshot` é imutável e 1:1 com a `FiscalSubmission` que o gerou — nunca regenerado/sobrescrito, mesmo que os dados de origem mudem depois.
16. **Novo**: `ResolutionPolicy` é dado de configuração, nunca lógica hardcoded no `FiscalProviderResolver` — mudança de regra legal não deve exigir deploy.
17. **Novo**: `ProviderTransaction.certificateThumbprint` é capturado no momento da chamada e nunca recalculado depois — mesmo que o `Certificate` gire.

---

## 10. Critério de sucesso — respondido

- **Entidades do Fiscal Domain**: `FiscalInvoice`, `FiscalInvoiceItem`, `OfficialFiscalEvent`, `FiscalSubmission`, `FiscalSnapshot`, `FiscalAttachment`, `FiscalProfile`, `Certificate`.
- **Provider Layer**: `FiscalProvider`, `FiscalProviderResolver`, `ResolutionPolicy`, `ProviderTransaction`.
- **Relação com o CRM**: leitura unidirecional de `Package`/`Patient`/`Doctor`; `Payment` só via projeção (nunca referência direta); referência informativa com `Invoice`.
- **Invariantes**: 17, todas ancoradas em achados reais ou em correções de review.
- **Múltiplos provedores/perfis fiscais**: `FiscalProfile` suporta múltiplos CNPJs/municípios sem exigir refatoração; `ResolutionPolicy` suporta mudança de regra sem deploy.

---

## 11. Plano de Execução da Fase 3 (proposto pelo usuário, adotado)

4 PRs independentes, permitindo validar o domínio inteiro com `MockAdapter` antes de qualquer integração municipal real:

1. **Persistência** — Models Mongoose (`FiscalInvoice`, `FiscalInvoiceItem`, `OfficialFiscalEvent`, `FiscalSubmission`, `FiscalSnapshot`, `FiscalAttachment`, `FiscalProfile`, `Certificate`), índices, repositórios, migrações.
2. **Core Domain** — `FiscalStateMachineService`, `FiscalInvoiceService`, `FiscalInvoicePaymentProjection`, invariantes, Domain Events.
3. **Provider Layer** — `FiscalProvider` (interface), `FiscalProviderResolver`, `ResolutionPolicy`, `MockAdapter`, `ProviderTransaction`.
4. **Integração** — Worker de reconciliação (polling de `OfficialFiscalEvent`, sem webhook nativo), BullMQ, APIs REST, upload de XML/PDF, observabilidade.

PRs 1–3 são testáveis de ponta a ponta só com `MockAdapter`, antes de decidir/obter o host técnico de Anápolis ou o certificado digital — reduz risco antes de tocar em infraestrutura municipal real.

---

## 12. Decisões em aberto para a Fase 3

1. Reaproveitar `ConfiguracaoFiscal.regimeTributario` ou criar campo próprio em `FiscalProfile`.
2. `tpRetISSQN` por convênio.
3. Onde mora a decisão de `liminarFlow` (`TherapeuticPlan`, não confirmado).
4. Host técnico real do webservice municipal de Anápolis (NotaControl/ISSNET).
5. Tipo de certificado digital (A1 vs A3/HSM).
6. Onde/como `Certificate.passwordReference`/`storageKey` são armazenados (secret manager/KMS/HSM).
7. **Novo**: forma exata da query da `FiscalInvoicePaymentProjection` (quais critérios resolvem "Payments de um pacote/appointment/lote") — desenho de implementação, não de domínio, deferido para o PR2.
