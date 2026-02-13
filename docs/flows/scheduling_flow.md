# 📅 Scheduling Flow (Agendamento Automático)

Este documento descreve o fluxo de agendamento automático consumido pela Amanda (`amandaBookingService.js`).

## 📌 Visão Geral

O sistema permite que a Amanda encontre horários livres na agenda dos profissionais e realize o agendamento direto no sistema, sem intervenção humana.

## 🔄 Fluxo de Agendamento

### 1. Busca de Disponibilidade (`findAvailableSlots`)
Quando o lead demonstra interesse em agendar:

1.  **Filtros**:
    *   `therapyArea`: Especialidade (fono, psico, etc.).
    *   `preferredPeriod`: Manhã, Tarde ou Noite.
    *   `preferredDay`: Dia da semana específico (opcional).
2.  **Busca no Core**: Chama `/api/appointments/available-slots` para cada doutor ativo da especialidade.
3.  **Algoritmo de Seleção**:
    *   Prioriza o período desejado.
    *   Seleciona 1 horário **Principal** (Primary).
    *   Seleciona até 2 horários **Alternativos** no mesmo período.
    *   Seleciona até 2 horários **Alternativos** em períodos diferentes (para opção).

### 2. Apresentação ao Usuário
A Amanda formata a mensagem com opções claras:
> "Tenho disponível:
> A) Terça-feira (15/10) às 14:00 com Dra. Ana
> B) Quarta-feira (16/10) às 09:00 com Dr. Pedro"

### 3. Escolha do Slot (`pickSlotFromUserReply`)
A Amanda interpreta a resposta do usuário:
-   **Letra/Número**: "Quero a opção B", "número 1".
-   **Linguagem Natural**: "Pode ser na terça?", "Prefiro de manhã".

### 4. Coleta de Dados Faltantes
Se o lead ainda não tem cadastro completo, a Amanda solicita (via Orchestrator):
1.  Nome Completo do Paciente.
2.  Data de Nascimento.

### 5. Confirmação e Agendamento (`autoBookAppointment`)
Com o slot escolhido e dados completos:

1.  **Validação Final**: Verifica se o slot *ainda* está livre (`validateSlotStillAvailable`).
2.  **Criação/Busca de Paciente**: `/api/patients/add`.
3.  **Criação do Agendamento**: `/api/appointments`.
    *   Status: `scheduled`.
    *   Tipo: `avaliacao` (R$ 200 via Pix ou conforme tabela).
    *   Nota: "[AGENDADO AUTOMATICAMENTE VIA AMANDA/WHATSAPP]".

### 6. Tratamento de Conflitos
Se o horário for ocupado enquanto o usuário decidia:
-   O sistema retorna erro `TIME_CONFLICT`.
-   A Amanda avisa o usuário: "Esse horário acabou de ser preenchido 😕".
-   O fluxo reinicia ou passa para humano.

---

## 🛠️ Principais Funções

| Função | Responsabilidade |
| :--- | :--- |
| `findAvailableSlots` | Varre agendas de múltiplos doutores e retorna melhores candidatos. |
| `pickSlotFromUserReply` | Lógica fuzzy para entender qual horário o usuário escolheu. |
| `autoBookAppointment` | Executa a transação de agendamento (Paciente + Appointment). |
| `validateSlotStillAvailable` | Double-check antes de confirmar para evitar overbooking. |

## ⚙️ Configuração

-   **API Interna**: Usa `INTERNAL_BASE_URL` para comunicar com o backend.
-   **Token**: Usa `ADMIN_API_TOKEN` para autenticação privilegiada.
-   **Horários de Corte**: Recessos e feriados são verificados em `config/clinic.js`.
