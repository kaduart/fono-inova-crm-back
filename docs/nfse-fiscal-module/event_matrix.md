# NFS-e Padrão Nacional — Matriz Oficial de Eventos (Anexo II)

> Documento de pesquisa técnica — Sprint 1 da Fase 1.5 (validação técnica), item bloqueante único:
> obter o leiaute oficial do **Anexo II — Leiautes e Regras de Negócio de Eventos do Sistema Nacional NFS-e**
> (`AnexoII-...-SNNFSe`), referenciado mas **não obtido** na Fase 1
> (`back/docs/nfse-fiscal-module/project_nfse_phase1_official_spec.md`, Seção 3.3 e Seção 5).
>
> Convenção: ✅ Confirmado pela documentação oficial nacional | ⚠ Confirmado por documentação secundária/municipal
> | ❓ Não confirmado / lacuna.

---

## 1. Resumo — cobertura obtida

O bloqueio identificado na Fase 1 foi **resolvido**. O Anexo II não é mais um link interno de PDF inacessível: a
página oficial `gov.br/nfse/pt-br/biblioteca/documentacao-tecnica/documentacao-atual` lista, como download de topo
(não hyperlink interno), o arquivo:

- **`Anexo_II-SEFIN_ADN-PedRegEvt_Evt-SNNFSe-V1.01-20260122.xlsx`**
  URL: `https://www.gov.br/nfse/pt-br/biblioteca/documentacao-tecnica/documentacao-atual/anexo_ii-sefin_adn-pedregevt_evt-snnfse-v1-01-20260122.xlsx`
  Metadado interno do arquivo (`docProps/core.xml`): criado em 2022-02-02, **última modificação 2026-01-17T18:03:52Z**
  (autor: Adriano Guedes da Silva). Publicado/linkado na página oficial em 22/01/2026. **✅ Fonte primária, versão vigente.**

Este arquivo foi baixado, descompactado (é um `.xlsx`/OOXML — zip de XML) e parseado programaticamente (sem
biblioteca externa — `zipfile` + `xml.etree` da stdlib Python, para não inferir/transcrever manualmente). Contém 4
abas:

1. `TIPO EVENTOS DE NFSe` — tabela mestra com os 16 tipos de evento e seus **códigos numéricos de `tipoEvento`**.
2. `RN EVENTOSxEVENTOS` — matriz de regras de negócio evento-vs-evento (o que pode/não pode ser recepcionado dado um
   evento pré-existente já vinculado à NFS-e) — é a **máquina de estados** em forma tabular oficial.
3. `LEIAUTE EVENTO_PED.REG.EVENTO` — leiaute de campos XML do Pedido de Registro de Evento, por tipo de evento
   (confirma os códigos como prefixo de elemento XML, ex. `e101101`, `e105102`).
4. `RN EVENTO_PED.REG.EVENTO` — regras de negócio de validação de campo, com códigos de erro (ex. `E0822`, `E1965`,
   `E1967`) e a matriz "executada em Web Service (V)" / "executada em Sefin Pública (V)" / "não executada (X)".

**Também foi baixada e comparada, como controle cruzado, a versão anterior** do mesmo anexo, de setembro de 2022
(homologação): `anexoii-leiautesrn_eventos-snnfse_v1-01-00-homologacao.xlsx`
(`gov.br/nfse/pt-br/biblioteca/eventos_NFS-e/evento-tecnico-setembro-de-2022/...`). Os **16 códigos numéricos são
idênticos** entre as duas versões (2022 e 2026) — alta confiança de estabilidade. Uma única divergência textual foi
encontrada entre as duas versões (não numérica) — ver Seção 4.

**Cobertura dos 9 tipos de evento pedidos**: **9 de 9** tiveram código numérico de `tipoEvento` confirmado (a
"Manifestação de NFS-e" se desdobra oficialmente em 8 sub-tipos com código próprio cada, e "Bloqueio"/"Desbloqueio de
NFS-e por Ofício" são 1 código cada, parametrizável por um campo interno `codEvento` que aponta o tipo de evento alvo
— não 5 códigos por alvo). Total: **16 códigos numéricos de `tipoEvento` confirmados**, todos com validação cruzada
adicional (aparecem também como prefixo de elemento XML nas abas de leiaute/regras do mesmo arquivo).

---

## 2. Matriz de eventos

Estrutura do código: **6 dígitos** = `[Categoria(1)][Autor(2)][Ambiente receptor(1)][Sequencial(2)]`.
Fonte: rodapé da aba `TIPO EVENTOS DE NFSe`, idêntico nas duas versões (2022/2026). **✅**

Tabela de códigos de Autor (legenda oficial, versão 2026-01-22 — nota: a versão 2022 não tinha os códigos `08` e `99`):
`01`=Emite (emitente da NFS-e) · `02`=Prestador · `03`=Tomador · `04`=Intermediário · `05`=MEmis (Município Emissor) ·
`06`=MIncid (Município de Incidência) · `07`=Man (Módulo de Apuração Nacional) · `08`=RespTrib (Responsável
Tributário) · `56`=MEmis|MInci · `67`=MInci|Man · `99`=CGNFSe (Comitê Gestor da NFS-e).

Visibilidade (legenda oficial 2026): `EM`=Emitente NFS-e · `NE`=Não Emitente · `SP`=Sujeito Passivo ·
`CP`=Consulta Pública · `AT`=Administração Tributária (municípios Emissor/Incidência/Não-Emitentes/prestação).

| # | Evento | Código `tipoEvento` | Categoria | Quem emite (Autor) | Assinatura digital obrigatória? | Ambiente receptor | NFS-e precisa existir no ADN? | Evento único? | Visibilidade | Fonte | Confiança |
|---|---|---|---|---|---|---|---|---|---|---|---|
| 1 | Cancelamento de NFS-e | **101101** | 1 — Cancelamentos | Emite (emitente/prestador) | Sim | Sistema que gerou a NFS-e | Sim | Sim | EM/NE/CP/AT | Anexo II v1.01 20260122 e v1.01.00-Homologação 2022 (idêntico) | ✅ |
| 2 | Cancelamento de NFS-e por Substituição | **105102** | 1 — Cancelamentos | MEmis (Município Emissor — gerado automaticamente ao processar `POST /nfse` com `chSubstda`) | — | Sistema que gerou a NFS-e | Sim | Sim | EM/NE/CP/AT | idem | ✅ |
| 3 | Solicitação de Análise Fiscal para Cancelamento de NFS-e | **101103** | 1 — Cancelamentos | Emite (emitente/prestador) | Sim | Sistema que gerou a NFS-e | Sim | Sim | EM/NE/AT | idem | ✅ |
| 4 | Cancelamento de NFS-e Deferido por Análise Fiscal | **105104** | 1 — Cancelamentos | MEmis (Município Emissor / fisco) | — | Sistema que gerou a NFS-e | Sim | Sim | EM/NE/AT | idem | ✅ |
| 5 | Cancelamento de NFS-e Indeferido por Análise Fiscal | **105105** | 1 — Cancelamentos | MEmis (Município Emissor / fisco) | — | Sistema que gerou a NFS-e | Sim | Sim | EM/NE/AT | idem | ✅ |
| 6 | Manifestação de NFS-e — Confirmação do Prestador | **202201** | 2 — Manifestações | Prestador (`Emite (Prestador)` na v2026; `Prestador` puro na v2022) | Não | ADN | Sim | Sim | EM/NE/CP/AT | idem | ✅ |
| 7 | Manifestação de NFS-e — Confirmação do Tomador | **203202** | 2 — Manifestações | Tomador | Não | ADN | Sim | Sim | EM/NE/CP/AT | idem | ✅ |
| 8 | Manifestação de NFS-e — Confirmação do Intermediário | **204203** | 2 — Manifestações | Intermediário | Não | ADN | Sim | Sim | EM/NE/CP/AT | idem | ✅ |
| 9 | Manifestação de NFS-e — Confirmação Tácita | **205204** | 2 — Manifestações | v2026: **MIncid** (Município de Incidência) · v2022: **MEmis** (Município Emissor) — ⚠ ver divergência Seção 4 | — | Sistema que gerou a NFS-e + ADN | Sim | Sim | EM/NE/CP/AT | idem | ✅ código / ⚠ autor |
| 10 | Manifestação de NFS-e — Rejeição do Prestador | **202205** | 2 — Manifestações | Prestador | Não | ADN | Sim | Sim | EM/NE/CP/AT | idem | ✅ |
| 11 | Manifestação de NFS-e — Rejeição do Tomador | **203206** | 2 — Manifestações | Tomador | Não | ADN | Sim | Sim | EM/NE/CP/AT | idem | ✅ |
| 12 | Manifestação de NFS-e — Rejeição do Intermediário | **204207** | 2 — Manifestações | Intermediário | Não | ADN | Sim | Sim | EM/NE/CP/AT | idem | ✅ |
| 13 | Manifestação de NFS-e — Anulação da Rejeição | **205208** | 2 — Manifestações | v2026: **MIncid** · v2022: **MEmis** — ⚠ ver divergência Seção 4 | — | ADN | Sim | Sim | EM/NE/CP/AT | idem | ✅ código / ⚠ autor |
| 14 | Cancelamento de NFS-e por Ofício | **305101** | 3 — Ofícios | MEmis (só o Município Emissor pode emitir; efetivo mesmo com manifestação de confirmação prévia) | — | Sistema que gerou a NFS-e | Sim | Sim | EM/NE/CP/AT | idem | ✅ |
| 15 | Bloqueio de NFS-e por Ofício | **305102** | 3 — Ofícios | MEmis | — | Sistema que gerou a NFS-e | Sim | **Não** (não é único — impede um tipo específico de evento por vez; alvo indicado no campo interno `codEvento` do próprio evento; alvos possíveis: eventos #1, #2, #4, #5, #14) | EM/AT | idem | ✅ |
| 16 | Desbloqueio de NFS-e por Ofício | **305103** | 3 — Ofícios | MEmis | — | Sistema que gerou a NFS-e | Sim | **Não** (idem #15 — deve corresponder exatamente ao identificador do bloqueio pendente) | EM/AT | idem | ✅ |

**Pré-condições confirmadas na aba `RN EVENTO_PED.REG.EVENTO` (regras de campo, com código de erro oficial):**

- **Cancelamento (#1)**: rejeitado com **`E0822`** se fora do "prazo limite para o cancelamento da NFS-e, conforme
  parametrização do município emissor" — ✅ confirma que o prazo de cancelamento **não é fixo nacionalmente**, é
  parametrizável por município (compatível com a lacuna já registrada na Fase 1, Seção 6, sobre "prazo exato de
  quando cancelamento simples deixa de ser aceito" — resposta: **depende do parâmetro municipal**, não há um número
  fixo de dias documentado no Anexo II em si).
- **Cancelamento por Substituição (#2)**: rejeitado com **`E0845`** se já houver outro evento incompatível já
  vinculado à NFS-e (verificação contra a própria matriz evento×evento da Seção 3 abaixo).
- **Bloqueio (#15)**: rejeitado com **`E1967`** se já existir um bloqueio pendente do mesmo tipo de evento-alvo sem o
  desbloqueio correspondente (não é possível bloquear um tipo de evento já bloqueado).
- Todo Pedido de Registro de Evento fora da versão de leiaute aceita é rejeitado com **`E1260`**/**`E1825`**
  (prazo de aceitação de versão do leiaute expirado).
- Assinatura digital do Pedido de Registro de Evento é **obrigatória quando enviado via Web Service** (`E1989`), mas
  a matriz da mesma linha mostra "X" para "executada na geração por Emissores Públicos Nacionais (Sefin/Web/App)" —
  ou seja, **quando o próprio emissor público nacional gera o evento em nome do contribuinte (ex. clínica sem
  certificado próprio, usando a Sefin Nacional), a assinatura de Pedido de Registro de Evento não é exigida da mesma
  forma que num envio direto via Web Service** — relevante para decidir arquitetura de `CertificateManager` (Fase 1,
  Seção 4, `[LACUNA]` sobre tipo de certificado) — ✅ mas ainda não resolve *qual* certificado, apenas confirma que o
  canal de acesso (Web Service direto vs. Emissor Público Sefin/Web/App) muda a obrigatoriedade.

---

## 3. Máquina de estados da NFS-e

### 3.1 Visão simplificada (fluxo principal)

```
                                   ┌────────────────────────────┐
                                   │         EMITIDA/VÁLIDA      │◄────────────┐
                                   └──────────────┬───────────────┘             │
              ┌────────────────────────┬──────────┼───────────────┬────────────┤
              │                        │           │               │            │
   Evt #1 Cancelamento     Evt #2 Cancel.p/Subst.  │   Evt #3 Solicitação   Evt #6-13
   (101101)                (105102)                │   Análise Fiscal (101103)  Manifestação
              │                        │           │               │        (confirma/rejeita/
              ▼                        ▼           │               ▼         anula — não muda
        ┌──────────┐           ┌───────────────┐    │      ┌────────────────┐  estado central,
        │ CANCELADA│           │ CANCELADA +   │    │      │ EM ANÁLISE      │  ver 3.3)
        │(terminal)│           │ SUBSTITUÍDA   │    │      │ FISCAL          │
        └──────────┘           │ (terminal)    │    │      └───────┬─────────┘
                                └───────────────┘    │              │
                                                      │     ┌────────┴─────────┐
                                                      │     │                  │
                                                      │  Evt #4 Deferido    Evt #5 Indeferido
                                                      │  (105104)           (105105)
                                                      │     │                  │
                                                      │     ▼                  ▼
                                                      │ ┌──────────┐   ┌──────────────────┐
                                                      │ │ CANCELADA│   │ VÁLIDA (indeferido)│
                                                      │ │(terminal)│   │ — NÃO aceita nova  │──┐
                                                      │ └──────────┘   │ Solicitação Análise │  │
                                                      │                │ Fiscal (X); aceita  │  │
                                                      │                │ Cancel.p/Ofício (V) │  │
                                                      │                └──────────────────┘  │
                                                      │                                        │
                                              Evt #14 Cancelamento por Ofício (305101)          │
                                              (MEmis — pode ocorrer a qualquer momento,          │
                                               inclusive sobre nota já confirmada/manifestada)   │
                                                      │                                        │
                                                      ▼                                        │
                                             ┌──────────────────┐                              │
                                             │ CANCELADA POR     │◄─────────────────────────────┘
                                             │ OFÍCIO (terminal) │
                                             └──────────────────┘

  Ramo paralelo — BLOQUEIO/DESBLOQUEIO (não é um estado da nota, é um "trava" por tipo de evento-alvo):

  Evt #15 Bloqueio de NFS-e por Ofício (305102, alvo = um de {#1,#2,#4,#5,#14})
        → o tipo de evento-alvo fica temporariamente INACEITÁVEL para novo registro
        → só pode ser revertido por:
  Evt #16 Desbloqueio de NFS-e por Ofício (305103, deve casar exatamente com o bloqueio pendente)
        → o tipo de evento-alvo volta a ser aceitável
```

### 3.2 Ramo de Manifestação (sub-estado paralelo, não exclusivo)

A trilha de Manifestação (eventos #6–#13) **não cancela** a NFS-e — é um sub-estado paralelo de "ciência/contestação"
por ator (Prestador, Tomador, Intermediário), com confirmação tácita automática decorrido um prazo (evento #9,
gerado pelo próprio sistema — autor `MIncid`/`MEmis` conforme divergência da Seção 4, não pelo contribuinte). Uma
Rejeição (#10/#11/#12) pode ser desfeita por Anulação da Rejeição (#13). A matriz oficial evento×evento (aba `RN
EVENTOSxEVENTOS`, reproduzida na íntegra na Seção 3.3) contém, para vários pares Confirmação-vs-Rejeição do mesmo
ator, o valor **`X/V`** (condicional) em vez de um `V`/`X` simples — ou seja, a aceitação depende de uma regra de
negócio adicional não detalhada na própria célula (provavelmente "é `V` se o autor da nova manifestação for
diferente do autor da manifestação já registrada, `X` se for o mesmo ator tentando manifestar-se duas vezes"; isso é
**inferência plausível, não confirmada explicitamente na fonte — registrado como lacuna, não assumido no lugar da
fonte**).

### 3.3 Matriz oficial completa evento × evento (aba `RN EVENTOSxEVENTOS`, verbatim)

`V` = permitido · `X` = não permitido · `X/V` = condicional (regra adicional não detalhada nesta célula — ver 3.2).
Linhas = evento **pré-existente** já vinculado à NFS-e; colunas = evento **recebido agora**. Ordem de colunas:
`[1 Cancel] [2 Cancel.Subst] [3 SoliticAnaliseFiscal] [4 Deferido] [5 Indeferido] [6 ConfPrestador] [7 ConfTomador]
[8 ConfIntermediario] [9 ConfTacita] [10 RejPrestador] [11 RejTomador] [12 RejIntermediario] [13 AnulacaoRejeicao]
[14 CancelOficio] [15-19 Bloqueio→{Cancel,Subst,Deferido,Indeferido,Oficio}] [20-24 Desbloqueio→{Cancel,Subst,Deferido,Indeferido,Oficio}]`

```
Pré-existente=NENHUM:                    V V V X X V V V V V V V V V V V V V V X X X X X
Pré-existente=Cancelamento:               X X X X X X X X X X X X X X X X X X X X X X X X
Pré-existente=Cancel.p/Substituição:      X X X X X X X X X X X X X X X X X X X X X X X X
Pré-existente=SoliticAnaliseFiscal:       X X X V V V V V V V V V V X V V V V V V V V V V
Pré-existente=Deferido:                   X X X X X X X X X X X X X X X X X X X X X X X X
Pré-existente=Indeferido:                 X X X X X V V V V V V V V V V V V V V V V V V V
Pré-existente=ConfPrestador:               X V X X X X X/V X/V X V X/V X/V V V V V V V V V V V V
Pré-existente=ConfTomador:                 X V X X X X/V X X/V X X/V V X/V V V V V V V V V V V V
Pré-existente=ConfIntermediario:           X V X X X X/V X/V X X X/V X/V V V V V V V V V V V V V
Pré-existente=ConfTacita:                  X V V V V X X X X X X X X V V V V V V V V V V V
Pré-existente=RejPrestador:                V V V V V V X/V X/V X X X/V X/V V V V V V V V V V V V
Pré-existente=RejTomador:                  V V V V V X/V V X/V X X/V X X/V V V V V V V V V V V V
Pré-existente=RejIntermediario:            V V V V V X/V X/V V X X/V X/V X V V V V V V V V V V V
Pré-existente=AnulacaoRejeicao:            X V V V V V V V V X/V X/V X/V X V V V V V V V V V V
Pré-existente=CancelOficio:                X X X X X X X X X X X X X X X X X X X X X X X X
Pré-existente=BloqueioPara(Cancel):        X/V V V V V V V V V V V V V V X/V V V V V V V V V
Pré-existente=BloqueioPara(Subst):         V X/V V V V V V V V V V V V V V X/V V V V V V V V
Pré-existente=BloqueioPara(Deferido):      V V V X/V V V V V V V V V V V V V X/V V V V V V V
Pré-existente=BloqueioPara(Indeferido):    V V V V X/V V V V V V V V V V V V V X/V V V V V V
Pré-existente=BloqueioPara(Oficio):        V V V V V V V V V V V V V X/V V V V V X/V V V V V
Pré-existente=DesbloqueioPara(Cancel):     V V V V V V V V V V V V V V V V V V V X V V V V
Pré-existente=DesbloqueioPara(Subst):      V V V V V V V V V V V V V V V V V V V V X V V V
Pré-existente=DesbloqueioPara(Deferido):   V V V V V V V V V V V V V V V V V V V V V X V V
Pré-existente=DesbloqueioPara(Indeferido): V V V V V V V V V V V V V V V V V V V V V V X V
Pré-existente=DesbloqueioPara(Oficio):     V V V V V V V V V V V V V V V V V V V V V V V X
```

Fonte: Anexo II v1.01 20260122, aba `RN EVENTOSxEVENTOS`. **✅ Confirmado, cópia literal via parsing programático do
XML interno do `.xlsx`** (sem digitação manual célula a célula da parte textual — apenas o realinhamento das colunas
foi feito manualmente a partir da extração, então recomenda-se conferência pontual antes de codificar regras
críticas de bloqueio a partir desta transcrição).

**Leitura de destaque**: uma vez que uma NFS-e recebe `Cancelamento`, `Cancelamento por Substituição`,
`Cancelamento Deferido por Análise Fiscal` ou `Cancelamento de NFS-e por Ofício`, **nenhum evento subsequente é
aceito** (linha inteira em `X`) — são os 4 estados terminais confirmados. `Cancelamento Indeferido` **não** é
terminal — a nota permanece sujeita a manifestações e a um futuro cancelamento por ofício, mas **não aceita nova
Solicitação de Análise Fiscal** (só uma tentativa de análise fiscal por nota, aparentemente).

---

## 4. Divergência encontrada — não resolvida por inferência

**Autor dos eventos #9 (Confirmação Tácita) e #13 (Anulação da Rejeição)** diverge entre as duas versões oficiais do
mesmo Anexo II:

| Versão | Data | Autor listado (texto) | Dígito de autor no código `tipoEvento` |
|---|---|---|---|
| `anexoii-leiautesrn_eventos-snnfse_v1-01-00-homologacao.xlsx` | Homologação, set/2022 | **MEmis** (Município Emissor) | `05` (consistente com legenda: `05=MEmis`) |
| `anexo_ii-sefin_adn-pedregevt_evt-snnfse-v1-01-20260122.xlsx` | Vigente, modificado 2026-01-17, publicado 2026-01-22 | **MIncid** (Município de Incidência) | `05` (**inconsistente** com a legenda da própria aba 2026, onde `05=MEmis` e `06=MIncid`) |

Em ambas as versões o **código numérico não mudou** (`205204` e `205208`), mas o texto da coluna "Autor" mudou de
`MEmis` para `MIncid` na versão de 2026 — **sem** o dígito de autor no código acompanhar essa mudança (permaneceu
`05`, que segundo a própria legenda de 2026 corresponde a `MEmis`, não a `MIncid`). Isso é uma **inconsistência
interna da fonte oficial vigente** (texto da célula "Autor" vs. dígito do código, ambos na mesma aba, mesma versão).

**Não foi resolvido por inferência.** Duas hipóteses igualmente plausíveis, nenhuma escolhida:
1. Mudança de regra de negócio real (autor passou de MEmis para MIncid) e o código de 6 dígitos ficou desatualizado
   por erro de edição da planilha (o valor "visual" do código pode não ter sido recalculado ao editar o texto da
   coluna Autor).
2. Erro de digitação na coluna de texto "Autor" da versão 2026, e o código de 6 dígitos (`05` = MEmis) é que está
   correto, mantendo o comportamento de 2022.

**Recomendação para a Fase 2**: tratar o **código numérico** (`205204`/`205208`) como autoritativo para fins de
`tipoEvento` (é o valor tecnicamente usado nas chamadas de API), mas **não presumir** qual ator efetivamente dispara
esses dois eventos na prática sem confirmação adicional — isso só importa operacionalmente se o CRM algum dia
precisar *emitir* um desses dois eventos (não é o caso hoje: são eventos gerados pelo sistema/município, não pelo
contribuinte) ou precisar decidir para quem notificar/exibir esse evento na UI (aí a diferença MEmis vs. MIncid
importa, ex. para instruir o usuário sobre "quem" tacitamente confirmou ou anulou uma rejeição).

---

## 5. Lacunas remanescentes explícitas

1. ❓ **Regra granular por trás dos valores `X/V` (condicional)** na matriz evento×evento (Seção 3.3) — ex. exata
   condição que torna uma segunda Confirmação/Rejeição do mesmo ator aceita ou rejeitada. O Anexo II não detalha essa
   condição na própria célula da matriz; pode estar em texto de rodapé não capturado pelo parsing (não foi
   encontrado rodapé equivalente na aba `RN EVENTOSxEVENTOS`) ou pode exigir cruzamento com a aba `RN
   EVENTO_PED.REG.EVENTO` (regras de campo) evento a evento — não foi feito esse cruzamento completo célula a célula
   nesta pesquisa (86 e 111 linhas nas abas de leiaute/regras, respectivamente; apenas os trechos relacionados a
   prazo de cancelamento, bloqueio duplicado e assinatura foram extraídos, ver Seção 2).
2. ❓ **Divergência de autor MEmis vs. MIncid** para os eventos #9 e #13 — ver Seção 4, não resolvida.
3. ❓ **Prazo numérico exato (em dias) para cancelamento simples (#1) deixar de ser aceito e exigir Solicitação de
   Análise Fiscal (#3)** — confirmado apenas que **existe** parametrização por município (regra `E0822`), mas o
   Anexo II não lista os valores numéricos de prazo por município (isso provavelmente está na API
   `/parametros_municipais/{codigoMunicipio}/convenio`, já mapeada na Fase 1, Seção 3.1 — não uma tabela estática do
   Anexo II).
4. ❓ **Manual Integrado do Sistema Nacional NFS-e** (`manualintegradosnnfse_v1-01-00-homologacao.pdf`, 149 páginas,
   baixado nesta pesquisa em `/tmp/.../nfse/manual_integrado.pdf` mas **não lido integralmente**) pode conter
   narrativa complementar sobre o fluxo de eventos (ex. explicação textual da condição por trás dos `X/V`). Não
   processado por já ter sido obtido o dado bloqueante (os códigos numéricos) diretamente do Anexo II, que é fonte
   mais autoritativa que um manual narrativo — decisão de escopo desta sprint, registrada aqui para a Fase 2 se a
   lacuna #1 acima precisar ser fechada.
5. ❓ **Anexo I (leiaute DPS/NFS-e) e Anexo A (tabela IBGE)** — mencionados como lacunas na Fase 1 e permanecem fora
   do escopo desta sprint (o item bloqueante desta sprint era exclusivamente o Anexo II de Eventos). Ambos têm
   versões vigentes datadas (Anexo I: `v1-01-20260209`; Anexo A: `v1-00-20251210`) já localizadas na página
   `documentacao-atual` durante esta pesquisa, prontas para uma sprint futura dedicada.
6. ❓ **Campo exato que carrega o "tipo de evento alvo" dentro do Bloqueio/Desbloqueio (#15/#16)** — identificado
   como `codEvento` dentro do grupo de elemento `e305102` (confirmado na aba `RN EVENTO_PED.REG.EVENTO`, regra de
   erro `E1967`), mas o **leiaute XML completo desse campo** (tipo, domínio de valores aceitos — presumivelmente os
   6 códigos `101101/105102/105104/105105/305101`) não foi transcrito célula a célula da aba `LEIAUTE
   EVENTO_PED.REG.EVENTO` nesta pesquisa (ficou disponível localmente em
   `/tmp/.../nfse/current_sheet3_leiaute.tsv`, não copiado para este documento por não ser o item bloqueante da
   sprint).

---

## Fontes e cobertura desta sprint

**Baixados e parseados integralmente (xlsx, via `zipfile`/`ElementTree`, sem biblioteca de terceiros)**:
- `Anexo_II-SEFIN_ADN-PedRegEvt_Evt-SNNFSe-V1.01-20260122.xlsx` — https://www.gov.br/nfse/pt-br/biblioteca/documentacao-tecnica/documentacao-atual/anexo_ii-sefin_adn-pedregevt_evt-snnfse-v1-01-20260122.xlsx (vigente, mod. 2026-01-17)
- `AnexoII-LeiautesRN_Eventos-SNNFSe_V1.01.00-Homologação.xlsx` — https://www.gov.br/nfse/pt-br/biblioteca/eventos_NFS-e/evento-tecnico-setembro-de-2022/anexoii-leiautesrn_eventos-snnfse_v1-01-00-homologacao.xlsx (histórico 2022, usado só para controle cruzado)

**Baixado, não lido integralmente**: Manual Integrado do Sistema Nacional NFS-e (149 págs.) —
https://www.gov.br/nfse/pt-br/biblioteca/eventos_NFS-e/evento-tecnico-setembro-de-2022/manualintegradosnnfse_v1-01-00-homologacao.pdf

**Página índice usada para localizar a versão vigente**: https://www.gov.br/nfse/pt-br/biblioteca/documentacao-tecnica/documentacao-atual (listou também, como novidade em relação à Fase 1: Anexo I v1.01 20260209, Anexo III (CNC) v1.00 20251216, Anexo IV (ADN) v1.00 20251216, Anexo V (Painel Adm. Municipal) v1.00 20251216, Anexo B (NBS2) v1.01 20260122, Anexo C (IndOp IBSCBS) v1.01 20260122 — todos agora disponíveis como link de topo, não mais só hyperlink interno de PDF).

Arquivos brutos baixados e TSVs extraídos ficam em
`/tmp/claude-1000/-home-user-projetos-crm/5158d2de-be5e-4e13-9471-f7a77d27b0d8/scratchpad/nfse/` (diretório
temporário de sessão — **não persistente**; se a Fase 2 precisar reprocessar, deve rebaixar os arquivos das URLs
acima).
