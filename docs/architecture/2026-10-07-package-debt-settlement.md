# Baixa de débitos e totais dos pacotes

## Falha encontrada

Receber e baixa em lote já tentavam atualizar o pacote, mas descobriam os
pacotes somente por `Payment.package`. Pagamentos legados com esse campo vazio
continuam vinculados por `Payment.appointment -> Appointment.package` e eram
ignorados. Além disso, `PAYMENT_STATUS_CHANGED` não era encaminhado ao worker
de pacotes. A lista em Pacotes/Gerenciar lê `packages_view`, que podia continuar
mostrando o snapshot antigo.

## Correção

- `packagePaymentReconciliation.js` resolve os vínculos por pacote, agendamento
  e sessão legada, soma os Payments
  quitados e exclui recebimentos agregados para evitar dupla contagem.
- `totalPaid` preserva também `fundedByTransfer`, conforme o contrato do modelo.
  Consumo de sessões não é modificado por esta conciliação financeira.
- Receber, baixa em lote e `transitionPaymentStatus` conciliam pacotes
  particulares por sessão. Nas rotas transacionais, a escrita usa a mesma sessão
  Mongo e falhas abortam a baixa.
- `PAYMENT_STATUS_CHANGED` vai também para `package-projection`. O worker
  resolve o vínculo pelo agendamento e reconstrói a view inteira.
- A lista de pacotes sobrepõe somente os totais financeiros atuais desses
  pacotes, em uma consulta em lote, para cobrir o intervalo até o worker.
  A leitura não escreve na projeção.
- O modal de saldo invalida pagamentos após a baixa, e a aba de pacotes escuta
  essa invalidação para recarregar a lista.

O saldo contratual do pacote inclui sessões futuras. Ele não equivale ao débito
vencido da paciente, calculado pelos pagamentos pendentes de sessões concluídas.

## Encerramento após a baixa

Regra autorizada: pacotes particulares por sessão são inativados quando todos
os atendimentos realizados têm pagamentos quitados. Sessões ainda não realizadas
e suas cobranças pendentes são canceladas na mesma transação. O status interno
`canceled` representa a inativação, como no endpoint `/inactivate` existente.

`settlementClosure` registra data, motivo, valor contratual original, valor
cobrável efetivo e os agendamentos cancelados. `totalValue` mantém o contrato
original; `totalPaid` continua sendo dinheiro efetivamente recebido. O saldo
financeiro passa a usar o valor cobrável desse encerramento, para não contabilizar
sessões canceladas como dívida nem criar receita fictícia.

O fechamento não ocorre quando há atendimento sem pagamento vinculado, baixa
parcial, status operacional indefinido ou pagamento antecipado de sessão restante
(esse último exigiria estorno/transferência). Pacotes pré-pagos, convênio e liminar
não participam deste fluxo. Repetir a baixa não repete cancelamentos.

No reparo histórico da Isis, a relação enviada pelo usuário define os IDs.
Pacotes com agendamentos de outubro/2026 ou posteriores são excluídos inteiros,
incluindo suas sessões de setembro, por pedido explícito do usuário. Só pacotes
com quitação comprovada são modificados; registros inconclusivos ficam para revisão.

Reparo aplicado em 07/10/2026: 8 pacotes históricos inativados e quitados,
com backup completo e rebuild integral. 4 pacotes antigos não foram modificados:
há atendimentos concluídos com pagamentos cancelados (o vínculo por sessão foi
conferido também). Os 2 pacotes que incluem outubro foram excluídos do reparo.

## Verificação

`tests/unit/packagePaymentReconciliation.test.js` cobre vínculo legado,
idempotência, soma financeira, exclusão de recebimentos agregados, cobertura
transferida e restrição a pacotes particulares por sessão.
