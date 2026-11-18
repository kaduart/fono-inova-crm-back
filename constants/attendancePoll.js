// Enquete do lembrete de presença (texto é regra de negócio do CRM). Fonte única para o modo local
// (whatsappWebJsService) e o externo (o CRM manda a definição ao conector em POST /v1/messages).
export const ATTENDANCE_POLL = Object.freeze({
  question: 'Confirme sua presença 💚',
  options: Object.freeze(['Confirmar presença ✅', 'Falar com a recepção']),
  // Se o WhatsApp Web não aceitar enquete, vai em texto.
  fallbackText: 'Responda:\n*1* — Confirmar presença\n*2* — Falar com a recepção',
});

export default ATTENDANCE_POLL;
