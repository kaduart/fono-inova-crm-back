import { CLINIC_KNOWLEDGE } from '../knowledge/clinicKnowledge.js';

export function canAutoRespond(flags) {
  const autoFlags = [
    'asksPrice', 'asksPlans', 'mentionsReembolso',
    'asksAddress', 'asksLocation', 'asksAboutAfterHours',
    'asksPayment',
    'wantsCancel', 'wantsReschedule', 'saysThanks', 'saysBye'
  ];
  return autoFlags.some(f => flags[f]);
}

export function buildResponseFromFlags(flags, context = {}) {
  const parts = [];
  
  if (flags.asksPrice) {
    const therapy = context.therapyArea || 'avaliacao';
    const isNeuro = therapy === 'neuropsicologia';
    const price = isNeuro 
      ? 'R$ 2.000 (até 6x)'
      : CLINIC_KNOWLEDGE.pricing.avaliacao;
    
    parts.push(
      `O investimento é **${price}**. ` +
      `${CLINIC_KNOWLEDGE.pricing.valorAgregado} 💚`
    );
  }
  
  if (flags.asksPlans || flags.mentionsReembolso) {
    parts.push(
      `${CLINIC_KNOWLEDGE.insurance.comoFunciona} ` +
      `${CLINIC_KNOWLEDGE.insurance.facilitacao} 💚`
    );
  }
  
  if (flags.asksAddress || flags.asksLocation) {
    parts.push(
      `Nosso endereço é **${CLINIC_KNOWLEDGE.location.endereco}**. ` +
      `${CLINIC_KNOWLEDGE.location.estacionamento} 💚`
    );
  }
  
  if (flags.asksAboutAfterHours) {
    parts.push(
      `Atendemos ${CLINIC_KNOWLEDGE.schedule.diasAtendimento}, ` +
      `${CLINIC_KNOWLEDGE.schedule.horarioFuncionamento}. 💚`
    );
  }

  if (flags.asksPayment) {
    parts.push(
      `Sim! Trabalhamos com **PIX, cartão de crédito/débito e dinheiro** 💚\n\n` +
      `A avaliação é o primeiro passo pra entender o caso e montar o plano ideal para seu filho(a).\n\n` +
      `Se quiser, já posso te explicar como funciona ou verificar os horários disponíveis 😊`
    );
  }

  if (flags.wantsCancel) {
    parts.push(
      `Claro, sem problema! Posso cancelar o agendamento pra você. 💚\n\n` +
      `Só me confirma: é o agendamento mais próximo que você quer cancelar?`
    );
  }

  if (flags.wantsReschedule) {
    parts.push(
      `Claro! Vamos remarcar. 💚\n\n` +
      `Qual período funciona melhor pra você — manhã, tarde ou noite?`
    );
  }

  if (flags.saysThanks) {
    parts.push(`Imagina! 😊 Qualquer coisa é só me chamar, tô por aqui! 💚`);
  }

  if (flags.saysBye) {
    parts.push(`Até mais! 👋 Se precisar de algo é só chamar 💚`);
  }

  return parts.join('\n\n');
}

export function getTherapyInfo(therapyKey) {
  const therapy = CLINIC_KNOWLEDGE.specialties[therapyKey];
  if (!therapy) return null;
  return {
    nome: therapy.nome,
    trata: therapy.trata.slice(0, 3).join(', '),
    idades: therapy.idadesAtendidas
  };
}
