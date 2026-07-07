# Caso de evidência: Enthony Kauan Mesias Oliveira

**Paciente:** `69bbf5d42d22a57a538ed310`
**Resultado:** FALSO POSITIVO
**Categoria original:** `DUPLICIDADE_PROVAVEL` × 17 (de 29 casos na base inteira — 59% do total)

## O que o relatório v1 mostrou

```
Paciente: Enthony Kauan Mesias Oliveira
46 appointments
OK: 28
DUPLICIDADE_PROVAVEL: 17
Impacto: R$ 2.640,00
```

Uma concentração de 17 casos num único paciente, todos com o mesmo padrão (Payment real
existente, `isFromPackage: false`, valor batendo com 1 sessão avulsa num pacote
supostamente "prepaid").

## Investigação (`inspect-package-patient-integrity.js --patient=69bbf5d42d22a57a538ed310`)

Os 4 pacotes do Enthony são todos `model: 'liminar'` (psicopedagogia, psicologia,
terapia_ocupacional, fonoaudiologia — todos judiciais). Cada um mostrou o mesmo padrão:

```
Package 69c14528c19d35b8454a27e8 (psicopedagogia)
  model: liminar | paymentType: full | totalValue: 2400 | sessionValue: 150

  Venda do pacote encontrada: SIM
    Payment 69c2e8a25c4ad17fefccc204 | R$150 | kind=package_receipt | status=paid
    Payment 69cc23466873402d92efeda0 | R$150 | kind=package_receipt | status=paid
  Payments de sessão avulsa: 8 (isFromPackage=true na maioria, alguns false)
```

Os "8 payments extras por sessão" não são cobrança em cima de um pacote já pago — são o
reconhecimento de receita por sessão consumida do crédito judicial
(`domain/liminar/recognizeRevenue.js`), e os `package_receipt` são os recebimentos
periódicos do processo judicial. **Dois eventos financeiros diferentes, ambos legítimos,
coexistindo por desenho.**

## Causa raiz

O critério usado no relatório v1 era:

```js
const isPrepaid = pkg.model === 'prepaid' || pkg.paymentType === 'full';
```

Como pacotes liminar também usam `paymentType: 'full'`, todo pacote liminar do Enthony
caiu no bucket "prepaid" e foi avaliado pela regra errada (que espera 1 Payment cobrindo
o pacote inteiro, com qualquer Payment adicional sendo suspeito).

## Correção

`utils/packageFinancialModel.js` — `classifyPackageFinancialModel()` agora checa
`model === 'liminar'` (e `type === 'liminar'`) **antes** de checar `paymentType`, retornando
`JUDICIAL_LIMINAR` como categoria própria, fora do escopo da heurística de duplicidade
prepaid.

## Resultado após correção

```
DUPLICIDADE_PROVAVEL: 29 → 12   (-17, todos do Enthony)
Impacto financeiro estimado: R$ 22.010 → R$ 19.370
```

Nenhum dado do Enthony foi alterado — o caso dele nunca precisou de correção, só de
reclassificação da análise.

## Lição pra próxima auditoria

Antes de declarar qualquer "duplicidade" ou "cobrança indevida" com base em heurística
automatizada: **se um único paciente concentra uma fração desproporcional dos casos
suspeitos, suspeite primeiro do classificador, não do paciente.** Duplicidade real tende
a aparecer espalhada; concentração extrema é sinal de categoria de domínio não tratada.
