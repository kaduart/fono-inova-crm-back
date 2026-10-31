# Amanda com Claude

O Claude conduz a conversa no WhatsApp e o backend executa e valida. Este módulo troca só o "cérebro": webhook, buffer de mensagens, worker, lock, `manualControl`, idempotência do envio e retentativas continuam como estão.

```
webhook → whatsappAutoReplyWorker → runOrchestrator ─┬─ FSM atual (WhatsAppOrchestrator)
                                                      └─ runAmandaAgent (este módulo)
```

## Arquivos

| Arquivo | O que faz |
|---|---|
| `prompt.js` | Instruções da Amanda + dados da clínica (preços de `config/pricing.js`) + dados do contato |
| `tools.js` | `buscar_horarios`, `reservar_horario`, `atualizar_contato`, `transferir_para_equipe` |
| `index.js` | Loop do agente; devolve `{ command, payload: { text }, meta }` igual à FSM |
| `router.js` | Decide FSM / agente / sombra pelas variáveis de ambiente |

## Variáveis de ambiente

| Variável | Padrão | Uso |
|---|---|---|
| `ANTHROPIC_API_KEY` | — | Obrigatória para o agente |
| `AMANDA_AGENT_MODE` | `off` | `off`, `shadow` (Claude roda sem enviar nem gravar) ou `on` |
| `AMANDA_AGENT_PHONES` | vazio | Lista de telefones separados por vírgula. Com `on`/`shadow`, só esses números entram |
| `AMANDA_AGENT_AUTOBOOK` | `false` | `true` = cria o agendamento de verdade via `autoBookAppointment`. `false` = pré-reserva e a equipe confirma |
| `AMANDA_AGENT_MODEL` | `claude-opus-5-5` | Modelo |
| `AMANDA_AGENT_EFFORT` | `medium` | `low`, `medium`, `high` (mais alto = pensa mais, mais lento e mais caro) |
| `AMANDA_AGENT_TIMEOUT_MS` | `45000` | Tempo máximo por chamada à API |
| `AMANDA_AGENT_FALLBACKS` | `on` | `off` desliga o fallback automático de modelo em caso de recusa |

## Como ligar com segurança

1. **Sombra:** `AMANDA_AGENT_MODE=shadow`. A FSM continua respondendo. O Claude roda em paralelo sem escrever nada e grava a sugestão em `amandaagentshadows` (lado a lado com a resposta da FSM). Custa uma chamada extra por mensagem.
2. **Revisar:** comparar `fsmReply` × `agentReply` e marcar `review.better`.
   ```js
   db.amandaagentshadows.find({}, { input: 1, fsmReply: 1, agentReply: 1, toolCalls: 1 }).sort({ createdAt: -1 }).limit(50)
   ```
3. **Números de teste:** `AMANDA_AGENT_MODE=on` + `AMANDA_AGENT_PHONES=<seus números>`.
4. **Todos:** `AMANDA_AGENT_MODE=on` sem lista. Para voltar, `AMANDA_AGENT_MODE=off`.

## Garantias que não dependem do prompt

- Horário só sai da agenda real e só de profissional da especialidade pedida.
- "Reservado/agendado" só depois que a tool confirma; o status real vai para o Claude.
- Reserva repetida do mesmo horário não gera nova reserva nem novo aviso.
- Handoff liga `manualControl` (o worker para de responder) e avisa a recepção com resumo (`lead:manualControl` e `system:alert`).
- Erro, timeout ou resposta vazia: manda uma frase segura e chama a equipe. Nunca inventa resposta.

## Testes

```bash
npm run test:agent
```
