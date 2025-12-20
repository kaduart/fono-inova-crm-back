// ======================================================
// 🔹 ModeRouter.js
// Define se a Amanda fala no modo clínico, comercial, booking ou suporte
// ======================================================

export function determineMode({ lead, lastUserMessage, recentMessages = [] }) {
  const text = (lastUserMessage?.content || "").toLowerCase();

  if (
    /\b(agendar|horário|marcar|agenda|segunda|terça|quarta|quinta|sexta|manhã|tarde|noite)\b/.test(
      text
    )
  )
    return "BOOKING";

  if (
    /\b(valor|preço|particular|plano|reembolso|ipasgo|unimed|convênio)\b/.test(
      text
    )
  )
    return "COMMERCIAL";

  if (
    /\b(laudo|tea|tdah|atraso|fala|bebê|criança|crise|neuro|psico|fono|to|fisioterapia)\b/.test(
      text
    )
  )
    return "CLINICAL";

  // Pós-paciente ou mensagens de rotina
  if (lead?.stage === "paciente" || /lembrete|documento/.test(text))
    return "PATIENT_SUPPORT";

  // fallback: reutiliza o último modo conhecido
  return lead?.lastMode || "CLINICAL";
}
