// Fonte única das respostas manuais; não agenda nem envia mensagens.
export const commercialPlaybook = [
  {
    "id": "inicio",
    "title": "Abertura",
    "when": "Contato novo sem necessidade definida",
    "text": "Olá! Aqui é [nome], da Fono Inova. Como posso ajudar você?"
  },
  {
    "id": "orientar",
    "title": "Dúvida sobre a área",
    "when": "Somente quando a área ainda não estiver clara",
    "text": "Se ainda não souber qual atendimento procurar, pode nos contar o que está buscando?"
  },
  {
    "id": "primeirafono",
    "title": "Primeiro atendimento de Fono",
    "when": "Pergunta sobre como funciona o encontro de Fono",
    "text": "O primeiro atendimento de Fonoaudiologia começa com uma conversa com os pais ou responsável para conhecer a história e as necessidades da criança. Esse encontro dura aproximadamente uma hora e ajuda a orientar os próximos passos."
  },
  {
    "id": "planofono",
    "title": "Plano terapêutico de Fono",
    "when": "Pergunta sobre o que acontece depois",
    "text": "A partir das informações dessa conversa, o profissional define os próximos passos e, se necessário, o plano terapêutico. As etapas dependem de cada situação."
  },
  {
    "id": "valor",
    "title": "Valor e horários",
    "when": "Responder primeiro ao valor solicitado e conferir a agenda",
    "text": "O valor do atendimento de [especialidade] é R$ [valor confirmado]. Temos [dia e horário 1] ou [dia e horário 2]. Qual funciona melhor para você?"
  },
  {
    "id": "convenio",
    "title": "Convênio",
    "when": "Conferir cobertura da especialidade antes de responder",
    "text": "Para [especialidade], a condição do convênio [nome] é: [informação confirmada]. [Alternativa real, quando aplicável.]"
  },
  {
    "id": "pensar",
    "title": "Vou pensar",
    "when": "Acolher a decisão e combinar a retomada",
    "text": "Claro. Ficou alguma dúvida sobre o atendimento ou sobre as condições? Se preferir, podemos combinar uma data para retomar a conversa."
  },
  {
    "id": "horarios",
    "title": "Opções de horário",
    "when": "Oferecer somente opções reais disponíveis",
    "text": "Temos [dia e horário 1] ou [dia e horário 2] para [atendimento]. Qual funciona melhor para você?"
  },
  {
    "id": "semhorario",
    "title": "Sem horário compatível",
    "when": "Buscar alternativa sem prometer vaga",
    "text": "Esses horários não funcionam para vocês. Quais dias e períodos costumam ser possíveis? Vou consultar as alternativas disponíveis."
  },
  {
    "id": "retomada",
    "title": "Retomada contextual",
    "when": "Na data combinada e sem recusa ou pedido para parar",
    "text": "Olá, [nome]. Retomando nossa conversa sobre [pendência específica]: [resposta ou alternativa confirmada]. [Próximo passo concreto.]"
  },
  {
    "id": "confirmado",
    "title": "Agendamento confirmado",
    "when": "Somente após confirmação registrada no sistema",
    "text": "Seu atendimento de [especialidade] está confirmado para [data], às [hora], na Fono Inova. Endereço: [endereço confirmado]. [Orientações aplicáveis.]"
  },
  {
    "id": "origem",
    "title": "Origem do contato",
    "when": "Somente quando a origem ainda não estiver identificada",
    "text": "Como você conheceu a Fono Inova?"
  }
];
