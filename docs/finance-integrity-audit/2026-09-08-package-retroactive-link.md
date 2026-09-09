# Pacote por quantidade de sessões — retroativa sem vínculo

Pacote investigado: `6a9811c2943c9ac437792235`. Consulta somente leitura em 08/09/2026.

## Evidência confirmada no banco

Contrato de 2 sessões, R$ 200 por sessão, R$ 400 totais; data contratual 01/09/2026.
`model=prepaid`, `paymentType=full`, `preConsumedCount=1`, `sessionsDone=1`.
O modo de cálculo por quantidade de sessões não é o mesmo conceito que pagamento por sessão (`per_session`).

| Registro | Estado observado |
|---|---|
| Appointment `6a956a6e13426564def16dce` | 01/09, completed, package=null |
| Session `6a956a6e13426564def16dd1` | 01/09, completed, package=null |
| Payment `6a9737f8b82dac16d0bcf455` | R$ 200, paid, package=null, vinculado ao avulso |
| Payment `6a9811c4943c9ac437792246` | R$ 200, paid, package_receipt, vinculado ao pacote |
| Appointment `6a9811c3943c9ac437792238` | 08/09, scheduled, vinculado ao pacote |
| Package | totalPaid=200; arrays sessions/appointments contêm somente 08/09 |

A primeira sessão existe. O calendário do pacote não a encontra porque faltam os vínculos.
Há dois pagamentos paid de R$ 200; somente um participa do total do pacote.

## Linha do tempo (Brasília)

- 01/09 17:39: auditoria `appointment_completed` registra o avulso concluído com Payment pending de R$ 200 e origem manual_balance.
- 02/09 09:08: criação do agendamento futuro e do recebimento de pacote de R$ 200.
- 02/09 09:18: `paidAt` do pagamento avulso; ledger posterior registra payment_received de R$ 200.
- Ambos os Payments possuem financialDate=01/09/2026. As datas de registro são diferentes da data financeira.
- 08/09: a tentativa de concluir a segunda sessão encontra totalPaid=200 e consumo calculado=400.

Os logs de console locais encontrados são anteriores a setembro. A consulta não recuperou o payload HTTP original nem prova qual erro ocorreu na segunda chamada em 02/09.

## Fragilidade confirmada no código atual

`TherapyPackageFormModal.tsx` envia `preConsumedCount`, retira os slots retroativos da agenda nova e desconta seus valores dos pagamentos novos. Depois de criar o pacote, chama `/settle-payments` separadamente.

O endpoint aceitava somente Payments pending. Um avulso quitado por outro caminho deixava de poder ser incorporado pela retomada desse fluxo. A criação e a incorporação ainda são duas operações; esta correção torna a incorporação de um pagamento já quitado retomável, sem afirmar atomicidade entre as duas chamadas.

Correção implementada no endpoint: aceita pending/paid selecionados, valida propriedade e vínculos, preserva datas/método/valor de paid, não cria crédito de quitação para paid, completa arrays do pacote e não soma novamente em retry. Rejeita seleção parcial, outro paciente/pacote, origem protegida, excesso de valor e excesso de sessões. Mantém a estrutura da resposta.

## Reparo aplicado após autorização

`scripts/maintenance/repair-package-retroactive-2026-09-01.mjs` valida os IDs e estados esperados, vincula o trio avulso, acrescenta referências ao pacote, ajusta totalPaid para R$ 400 e mantém sessionsDone=1. Preserva os dois recebimentos e suas datas, o estado clínico e o ledger. Registra auditoria e reconstrói a visão do pacote.

A revisão automática inicialmente bloqueou a execução. Após autorização explícita do usuário, o dry-run validou os registros e o reparo foi aplicado em transação, com auditoria e reconstrução da visão. A leitura posterior confirmou 01/09 e 08/09 no array de sessões e totalPaid=400. Nessa verificação, 08/09 também já estava completed por alteração externa ao reparo; a correção não concluiu sessões.

## Prevenção aplicada após o diagnóstico

O formulário agora envia os IDs dos pagamentos retroativos na requisição de criação. O backend exige IDs válidos e quantidade consistente com preConsumedCount; clientes antigos recebem erro de negócio em vez de criar um pacote incompleto.

A incorporação usa `services/package/incorporatePackagePayments.js` dentro da transação de criação, juntamente com os novos recebimentos. Falhas na vinculação ou na criação desses recebimentos abortam a operação inteira. A quitação automática genérica de PatientBalance não executa nesse fluxo, evitando contabilizar duas vezes as mesmas retroativas. A segunda chamada do formulário foi removida; o endpoint separado permanece para retomadas de registros legados.

## Achado adicional no ledger

O lançamento package_purchase `6a9811c5943c9ac43779224e` tem R$ 400, embora o Payment associado tenha R$ 200. `recordPackagePurchase` usava `pkg.totalValue` em cada chamada. Para novos registros, foi corrigido para usar valor e data do Payment. Existe também payment_received de R$ 200 para o avulso. Essa divergência histórica exige reconciliação própria; o reparo de vínculo não alterou nem criou lançamentos contábeis.

## Validação

41 testes backend e 9 testes frontend passaram, incluindo criação atômica, rollback por falha no recebimento, incorporação de paid e retry, reutilização de avulso agendado, valor real no ledger, contrato enviado pelo formulário e proteção financeira. A validação automatizada usa banco de teste isolado. As alterações preventivas de código precisam ser publicadas em conjunto (backend e frontend) no ambiente da aplicação.
