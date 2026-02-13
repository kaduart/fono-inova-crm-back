# 🧠 Learning Flow (Aprendizado Contínuo)

Este documento descreve o sistema de auto-aperfeiçoamento da Amanda (`amandaLearningService.js` + `LearningInjector.js`).

## 📌 Visão Geral

A Amanda analisa conversas passadas bem-sucedidas (leas que viraram pacientes) para aprender padrões de persuasão e recusa, melhorando sua performance automaticamente ao longo do tempo.

## 🔄 Ciclo de Aprendizado

### 1. Coleta e Análise (`Run 23:00 - learningCron.js`)
Diariamente às 23h, o sistema:
1.  Busca leads com status `virou_paciente`.
2.  Extrai métricas de conversão:
    *   **Aberturas**: Qual frase inicial gerou mais resposta?
    *   **Objeções de Preço**: Como a objeção foi contornada?
    *   **Fechamento**: Qual pergunta final levou ao agendamento?
3.  **Escopo Negativo (NOVO)**: Identifica o que a Amanda recusou (ex: "não fazemos cirurgia") e consolida como regra.

### 2. Consolidação de Insights (`LearningInsight.js`)
Os padrões encontrados são salvos no MongoDB (coleção `LearningInsights`).
-   Cada insight tem um contador de frequência.
-   **Negative Scope** tem uma flag `verified: false` por padrão (segurança).

### 3. Teste de Regressão (`Run 00:00 - regressionCron.js`)
À meia-noite, um script de teste (`comprehensive_regression.js`) roda cenários simulados para garantir que os novos aprendizados não quebraram a lógica existente.

### 4. Injeção em Tempo Real (`LearningInjector.js`)
Durante a conversa (`AmandaOrchestrator.js`):
1.  O sistema carrega os insights mais recentes do banco (Cache de 4h).
2.  Filtra apenas insights válidos.
    *   **Negative Scope**: Só injeta se `verified === true` (Human-in-the-loop).
    *   **Kill Switch**: Se `DISABLE_AUTO_LEARNING=true`, ignora aprendizados novos.
3.  Injeta no System Prompt.

---

## 🛡️ Mecanismos de Segurança

### 1. Verified Flag (Human-in-the-Loop)
Recusas automáticas (Negative Scope) são detectadas mas **não ativadas** automaticamente.
-   Estado inicial: `verified: false`.
-   Um humano (admin) precisa revisar e marcar como `true` no banco.
-   Isso impede que a IA aprenda a recusar serviços que a clínica passou a oferecer, ou aprenda errado.

### 2. Kill Switch
Variável de ambiente `DISABLE_AUTO_LEARNING=true`.
-   Desativa instantaneamente a injeção de aprendizados automáticos.
-   Útil em caso de comportamento anômalo da IA.
-   **Nota**: Regras de `Negative Scope` verificadas continuam valendo se desacopladas (ver `amandaPrompt.js`).

### 3. Pipeline de Teste
O aprendizado acontece à noite (23h) e é testado logo em seguida (00h), garantindo que problemas sejam pegos antes do horário comercial (08h).

## 🛠️ Principais Arquivos

| Arquivo | Responsabilidade |
| :--- | :--- |
| `amandaLearningService.js` | Analisa histórico e gera insights. |
| `LearningInjector.js` | Serve os insights para o orchestrator com cache e filtros. |
| `learningCron.js` | Agendador do processo de aprendizado. |
| `regressionCron.js` | Agendador dos testes de segurança. |
