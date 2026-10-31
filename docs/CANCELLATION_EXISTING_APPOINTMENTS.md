# Cancelamentos informados na geração de sessões

O formulário de convênio pode registrar uma ocorrência cancelada ausente ou cancelar um atendimento pendente já existente, mantendo os mesmos IDs e vínculos.

| Registro encontrado na mesma guia, paciente, especialidade e profissional | Decisão |
| --- | --- |
| Nenhum | Criar ocorrência cancelada, sem consumo ou faturamento |
| Pré-agendado, agendado, confirmado ou pendente | Validar sessão e financeiro; cancelar pelo command canônico |
| Já cancelado | Preservar, sem duplicar eventos ou histórico |
| Concluído ou sessão consumida | Bloquear com mensagem de correção administrativa necessária |
| Outra guia/plano, vínculos inconsistentes ou vários registros | Bloquear para conferência |
| Pagamento faturado, recebido, parcial ou incluído em lote | Bloquear para conciliação |

O lote é atômico: um conflito impede todos os cancelamentos e toda a geração associada. Uma prévia pode executar a simulação dentro de uma transação que será abortada; nesse caminho, projeções e invalidações de cache não podem ser executadas antes do commit. O Outbox continua dentro da transação e só fica disponível aos consumidores depois do commit.

O retorno de cancelamentos inclui `created`, `canceled`, `preserved`, `decisions` e `conflicts`. `decisions[].action = cancel` significa reutilizar e cancelar o atendimento pendente existente; não significa criar uma nova ocorrência.

Correção de uma conclusão registrada por engano é uma operação administrativa separada. Não habilitar reversão de conclusão no formulário. É necessário conferir e reverter consumo, reconhecimento contábil, comissão e projeções, preservando recebimentos e histórico. Não basta alterar `operationalStatus`.

Validação local transacional:

```sh
npx vitest run --config vitest.cancellation-status.config.mjs
```

A suíte usa MongoDB temporário local; não carrega o setup de testes gerais nem conecta ao banco configurado no ambiente da aplicação.
