# Módulo Fiscal NFS-e — Índices (PR1)

> Referência dos índices definidos nos schemas Mongoose do Fiscal Domain. Os índices reais vivem
> nos próprios arquivos de model (`schema.index(...)`) — este documento é só um mapa de consulta
> rápida, não a fonte de verdade.

## `FiscalInvoice`
| Índice | Propósito |
|---|---|
| `status + createdAt` | Listagens por status (ex. "pendentes de análise fiscal") |
| `origin.type + origin.id` | Resolver rapidamente se já existe FiscalInvoice para uma origem (pacote/appointment/lote) |
| `chaveAcesso` (unique, sparse) | Busca por chave de acesso oficial — sparse porque só existe após autorização |
| `nNFSe + serie` | Consulta por número/série |
| `patient + createdAt` | Histórico fiscal por paciente |
| `professional + createdAt` | Histórico fiscal por profissional |
| `fiscalProfileId` | Filtrar por perfil fiscal (relevante quando houver múltiplos CNPJs) |

## `OfficialFiscalEvent`
| Índice | Propósito |
|---|---|
| `fiscalInvoice + occurredAt` | Reconstruir a máquina de estados de uma nota em ordem cronológica |
| `tipoEvento` | Consultas agregadas por tipo de evento |
| `correlationId` | Rastreabilidade ponta a ponta (padrão já usado no event-driven do CRM) |

## `FiscalSubmission`
| Índice | Propósito |
|---|---|
| `fiscalInvoice + attemptNumber` | Reconstruir a cadeia de tentativas (outbox) de uma nota |
| `outcome` | Monitoramento (ex. taxa de `network_error`/`timeout`) |
| `createdAt` | Ordenação temporal geral |

## `ProviderTransaction`
| Índice | Propósito |
|---|---|
| `traceId` | Correlação com observabilidade/infraestrutura |
| `providerVersion` | Detectar mudança de versão do webservice do provedor |
| `fiscalSubmission` | Reconstruir todas as chamadas HTTP de uma tentativa |

## `FiscalAttachment`
| Índice | Propósito |
|---|---|
| `fiscalInvoice + type` | Buscar o XML/DANFSe específico de uma nota |

## `FiscalProfile`
| Índice | Propósito |
|---|---|
| `cnpj + ativo` | Resolver o perfil fiscal ativo de um CNPJ |
| `municipioIBGE` | Alimenta o `FiscalProviderResolver` (PR3) |

## `Certificate`
| Índice | Propósito |
|---|---|
| `status + expiresAt` | Job de alerta de renovação (certificados expirando) |
| `thumbprint` | Correlacionar com `ProviderTransaction.certificateThumbprint` |

## `FiscalSnapshot`
| Índice | Propósito |
|---|---|
| `fiscalSubmission` (unique) | Garante a relação 1:1 com a tentativa que o gerou |

---

Escopo do PR1: só persistência estrutural. Nenhum destes índices resolve regra de negócio (ex.
qual `FiscalSubmission` é a "vencedora") — isso é responsabilidade do `FiscalStateMachineService`
e do `FiscalInvoiceService`, no PR2.
