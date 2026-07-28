# GO-LIVE — NFS-e (Sprint 1)

> Documento de execução, não de compliance. Pergunta única: **o que falta para a clínica emitir a primeira nota fiscal real, no caso comum, conforme a regra que entra em 01/09/2026?** Tudo que não está aqui foi deliberadamente adiado — ver `compliance_checklist.md` (o que falta para 100% de aderência ao Padrão Nacional) e `decisoes_fiscais_clinica.md` (perguntas de negócio, algumas das quais alimentam este checklist diretamente).
>
> Regra de escopo: um item só entra aqui se a ausência dele impede emitir **qualquer** nota no caso comum (paciente pessoa física, sem retenção, sem liminar, sem intermediário, sem substituição). Regra específica de negócio (retenção, liminar, tomador PJ) fica em Sprint 2, mesmo que pareça urgente — só sobe para cá se a resposta em `decisoes_fiscais_clinica.md` confirmar que acontece hoje.

## Base já pronta (não recomeçar do zero)

Tudo isto foi implementado e testado na semana de 2026-07-16 (PR1-PR4) e continua valendo — a Sprint 1 é construída em cima disso, não substitui nada:

- **Persistência completa**: `FiscalInvoice`, `FiscalProfile`, `FiscalSubmission`, `FiscalSnapshot`, `Certificate`, `OfficialFiscalEvent`, `ProviderTransaction` + repositórios.
- **Domínio**: `FiscalStateMachineService` (máquina de estados oficial, cancelamento/substituição/análise fiscal), `FiscalInvoiceService`, `FiscalInvoicePaymentProjection`, policies/specifications/validators — 21 testes unitários passando.
- **Provider Layer**: `FiscalProviderResolver` (município + regime + data, incluindo a regra de migração 01/09/2026 já hardcoded), `DpsBuilder` (gera XML no leiaute nacional correto), `MockAdapter` — 18 testes unitários passando.
- **Application Layer**: `IssueFiscalInvoiceService` + `RetryFiscalSubmissionService` + `_attemptSubmission` orquestrando o fluxo completo — 5 testes de integração contra MongoDB real passando (42/42 no total do módulo).
- **Frontend**: `FiscalConfiguration.tsx` (perfil + certificado) e `EmitFiscalInvoiceModal.tsx` (emissão MVP) já em produção, funcionando contra `MockAdapter`.
- **Endpoints REST**: `POST /nfse/emit`, `/nfse/emit-from-payment`, `GET /nfse`, `GET /nfse/:id`, `/retry`, `/cancel`, download de XML/PDF — todos implementados no `fiscalController.js`.

O que falta abaixo é **só** o que impede esse fluxo já pronto de rodar contra o mundo real (certificado de verdade, mTLS, dados de endereço) — não é trabalho de arquitetura ou domínio novo.

## Bloqueadores atuais

Por que a primeira nota ainda não foi emitida, em uma frase cada:

- 🔴 Contador não confirmou o regime tributário (`decisoes_fiscais_clinica.md` #1)
- 🔴 Certificado digital não definido (A1/A3/HSM) nem adquirido (`decisoes_fiscais_clinica.md` #2)
- 🔴 Certificado não configurado no ambiente — `CertificateManager` ainda é só Mock
- 🔴 mTLS não implementado — `httpsAgent` do `SefinNacionalAdapter` sempre `undefined`
- 🔴 Seleção de ambiente (homologação/produção) incorreta — `_attemptSubmission.js:27` ignora `FiscalProfile.ambiente`
- 🔴 Endereço de prestador e tomador não coletado nem incluído na DPS

## Definition of Done por bloco

| Bloco | Done quando... |
|---|---|
| 1. Cenário | Regime tributário, emissor e certificado definidos pelo contador (as 3 respostas registradas em `decisoes_fiscais_clinica.md` #1-#3) |
| 2. Dados | Prestador e tomador têm todos os campos obrigatórios do bloco preenchidos — endereço incluído |
| 3. Fluxo | É possível emitir, consultar e cancelar uma NFS-e de teste sem erros, em Produção Restrita |
| 4. Transporte | Certificado real configurado, mTLS funcionando, emissão validada no ambiente correto (homologação, depois produção) |
| Go-live | Primeira NFS-e emitida em produção e validada pelo financeiro/contador |

## Sequência de execução recomendada

1. Confirmar regime tributário
2. Definir certificado (A1/A3/HSM)
3. Completar `FiscalProfile` (principalmente endereço do prestador)
4. Completar dados do tomador (endereço + código IBGE no `Patient`) e ligar ao `DpsBuilder`
5. Implementar assinatura real (substituir `MockCertificateManager`)
6. Configurar mTLS
7. Corrigir a seleção dinâmica de ambiente (`_attemptSubmission.js`)
8. Emitir uma NFS-e em homologação (Produção Restrita) e validar com o contador
9. Emitir a primeira NFS-e em produção

## 1. Cenário confirmado — decisão de negócio, zero código

*Done quando: regime tributário, emissor e certificado definidos pelo contador.*

- [ ] Regime tributário confirmado (`decisoes_fiscais_clinica.md` #1)
- [ ] Certificado digital decidido e adquirido — A1, A3 ou HSM (`decisoes_fiscais_clinica.md` #2)
- [ ] Emissor técnico definido — Sefin Nacional **ou** NotaControl/Anápolis (`decisoes_fiscais_clinica.md` #3)
- [ ] Se NotaControl: contato feito com `suporte.anapolis@notacontrol.com.br`, IP liberado, WSDL/manual em mãos

## 2. Dados mínimos obrigatórios (só o que bloqueia emissão)

*Done quando: prestador e tomador têm todos os campos obrigatórios do bloco preenchidos — endereço incluído.*

**Prestador** (`FiscalProfile`)
- [x] CNPJ, IM, Razão Social — já existem
- [ ] Endereço completo (logradouro, número, bairro, CEP, código IBGE do município)

**Tomador** (`Patient`)
- [x] CPF, Nome — já existem
- [ ] Endereço completo + código IBGE do município (hoje `city` é texto livre, sem código)
- [ ] `DpsBuilder`/`FiscalSnapshotBuilder` alterados para efetivamente incluir esse endereço na DPS (hoje `tomaXml` só envia CPF+nome)

**Serviço**
- [x] Código do serviço (LC116), valor, descrição — já existem e já chegam na DPS

## 3. Fluxo ponta a ponta funcionando

- [x] `Payment` → cria `FiscalInvoice` (draft) → abre `FiscalSubmission` — já implementado
- [ ] Monta XML da DPS com endereço de prestador e tomador incluídos (depende do Bloco 2)
- [ ] Assina XML com certificado **real** (hoje `CertificateManager` é só Mock)
- [ ] Envia para o adapter real definido no Bloco 1 (`SefinNacionalAdapter` ou `AnapolisMunicipalAdapter`, hoje ambos inutilizáveis em produção por motivos diferentes)
- [x] Consulta por chave de acesso — implementada, não testada contra ambiente real
- [x] Cancela — domínio pronto, não testado contra ambiente real

## 4. Adapter Nacional / transporte — o bloqueador técnico de verdade

- [ ] Assinatura digital real funcionando (substitui `MockCertificateManager`)
- [ ] mTLS configurado — `httpsAgent` real passado ao `SefinNacionalAdapter` (hoje sempre `undefined`) **ou** endpoint do NotaControl liberado e implementado (hoje `AnapolisMunicipalAdapter` é 100% stub)
- [ ] `FiscalProfile.ambiente` corretamente ligado ao host da chamada HTTP — bug conhecido: hoje `_attemptSubmission.js:27` sempre usa Produção Restrita, ignorando o campo configurado
- [ ] Testado em Produção Restrita (homologação) com um caso real
- [ ] Primeira nota emitida e **autorizada** em Produção

## Produção homologada

- [ ] Go-live confirmado — clínica emitindo NFS-e real pelo CRM

---

### Como os três documentos se relacionam

| Documento | Pergunta que responde |
|---|---|
| `decisoes_fiscais_clinica.md` | O que o contador/operação precisa decidir? |
| `go_live_nfse.md` (este) | O que falta para emitir a primeira nota no caso comum? |
| `compliance_checklist.md` | O sistema está 100% aderente ao Padrão Nacional? |

Este documento é o principal enquanto o go-live não acontece. Os outros dois viram material de apoio (o de decisões alimenta os itens do Bloco 1 aqui; o de compliance guarda tudo que foi conscientemente adiado para Sprint 2+).
