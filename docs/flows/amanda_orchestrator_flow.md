# 🤖 Amanda Orchestrator Flow

Este documento descreve o fluxo ponta a ponta da **Amanda** (`AmandaOrchestrator.js`), o cérebro da assistente virtual da Clínica Fono Inova.

## 📌 Visão Geral

A Amanda é um sistema orquestrado que combina **Regras de Negócio (Hard Rules)** com **Inteligência Artificial (LLM)** para atender pacientes no WhatsApp.

O objetivo dela é:
1.  **Acolher** famílias atípicas (TEA, TDAH, atrasos).
2.  **Triar** a necessidade (qual especialidade? qual idade?).
3.  **Agendar** uma avaliação inicial.

---

## 🔄 Fluxo de Processamento

### 1. Entrada de Mensagem (`getOptimizedAmandaResponse`)
Toda mensagem recebida pelo webhook do WhatsApp passa por aqui.

1.  **Refresh do Lead**: Busca sempre a versão mais recente do lead no MongoDB para evitar conflitos de estado.
2.  **Anti-Spam/Handoff**: Se o lead já foi encaminhado para humanos, a Amanda silencia para não atrapalhar.
3.  **Guardrails de Preço**: Se o cliente pergunta preço, a Amanda responde **imediatamente** com valores tabelados (bypassando a IA), a menos que o lead esteja muito no início.

### 2. Detecção de Flags (`flagsDetector.js`)
O texto do usuário é analisado por Regex para detectar intenções e entidades:
-   **Intenções**: `asksPrice`, `wantsToBook`, `complaint`, `cancellation`.
-   **Entidades**: `childAge`, `specialty` (fono, psico, etc.), `insurance`.

### 3. Máquina de Estados (Triagem)
Antes de chamar a IA, a Amanda tenta preencher os dados mínimos para agendamento:
1.  **Período**: Manhã ou Tarde?
2.  **Paciente**: Nome completo?
3.  **Idade**: Anos/Meses (para definir se é infantil ou adulto).
4.  **Queixa**: O que está acontecendo?

> **Nota**: Se o usuário fizer uma pergunta específica (ex: "aceita Unimed?"), a triagem é pausada e a IA responde.

### 4. Enriquecimento de Contexto (`leadContext.js`)
Se não for um caso de regra fixa, preparamos o contexto para o LLM:
-   **Histórico**: Últimas 10 mensagens.
-   **Dados do Lead**: Nome, estágio do funil, se já é paciente.
-   **Learnings (`LearningInjector.js`)**: Injeção de aprendizados automáticos (o que funcionou no passado).
-   **Wisdom (`clinicWisdom.js`)**: Regras manuais da clínica.

### 5. Injeção de Prompt (`amandaPrompt.js`)
Construímos o System Prompt dinâmico com:
-   **Persona**: Acolhedora, não-robótica.
-   **Modo**: `CLOSER` (focada em fechar), `ACOLHIMENTO` (focada em ouvir) ou `URGÊNCIA`.
-   **Escopo Negativo**: O que a clínica **NÃO** faz (ex: cirurgia de freio), para evitar alucinações.
-   **Regras de Tom**: Inegociáveis (ex: validação emocional antes de preço).

### 6. Geração de Resposta (LLM)
-   **Modelo Principal**: Claude 3.5 Sonnet (via Anthropic).
-   **Fallback**: OpenAI (GPT-4o) se o Claude falhar.
-   **Circuit Breaker**: Proteção contra falhas consecutivas de API.

---

## 🛠️ Principais Componentes

| Arquivo | Responsabilidade |
| :--- | :--- |
| `AmandaOrchestrator.js` | Controlador central, decide se usa regra ou IA. |
| `flagsDetector.js` | "Ouvidos" da Amanda. Detecta intenções via Regex. |
| `amandaPrompt.js` | "Personalidade" da Amanda. Monta o prompt do LLM. |
| `amandaLearningService.js` | "Memória" da Amanda. Analisa conversas passadas. |
| `clinicWisdom.js` | "Manual" da clínica. Base de conhecimento estática. |

## 🚨 Pontos Críticos

-   **Segurança**: O `negativeScope` garante que a Amanda negue procedimentos que a clínica não faz.
-   **Performance**: Cache de 4h para learnings e wisdom.
-   **Custo**: Uso de regras fixas (regex) para perguntas triviais economiza tokens de LLM.
