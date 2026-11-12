// constants/neuroReferral.js
// "Candidatos a neuro": pacientes da casa (fono/psico/TO) com sinais de TEA/TDAH que ainda não passaram
// pela consulta com neuropediatra, que é quem emite o laudo. A recepção oferece a consulta.
// Regra de negócio: neuro é SÓ PARTICULAR (sem GEAP, sem Base Aérea, sem outro convênio).

// a_confirmar  → sugestão automática (queixa/anamnese), aguarda a terapeuta confirmar a indicação
// indicado     → terapeuta confirmou; a recepção deve oferecer a consulta
// oferecido    → recepção já falou com a família
// agendado     → existe consulta de neuro marcada (marcado sozinho ao surgir o agendamento)
// recusado     → família não quis por agora
// ja_tem_laudo → criança já tem laudo/acompanhamento neuro fora
// descartado   → terapeuta avaliou que não há indicação
export const NEURO_REFERRAL_STATUS = [
    'a_confirmar', 'indicado', 'oferecido', 'agendado', 'recusado', 'ja_tem_laudo', 'descartado',
];

// Status em que o paciente "está na lista": só pode existir UM registro ativo por paciente.
export const NEURO_REFERRAL_ACTIVE_STATUS = ['a_confirmar', 'indicado', 'oferecido'];

export const NEURO_REFERRAL_STATUS_LABELS = {
    a_confirmar: 'A confirmar (terapeuta)',
    indicado: 'Indicado — oferecer',
    oferecido: 'Oferecido',
    agendado: 'Agendou',
    recusado: 'Recusou',
    ja_tem_laudo: 'Já tem laudo',
    descartado: 'Sem indicação',
};

export const NEURO_REFERRAL_REASONS = ['tea', 'tdah', 'atraso_desenvolvimento', 'outro'];

export const NEURO_REFERRAL_SOURCES = ['terapeuta', 'sugestao_automatica'];

// Quem pode levar a indicação para qual status (admin pode tudo).
// doctor = terapeuta; secretary = recepção.
export const NEURO_REFERRAL_TRANSITIONS = {
    doctor: {
        a_confirmar: ['indicado', 'descartado'],
        indicado: ['descartado'],
    },
    secretary: {
        indicado: ['oferecido', 'agendado', 'recusado', 'ja_tem_laudo'],
        oferecido: ['agendado', 'recusado', 'ja_tem_laudo'],
        recusado: ['indicado'], // família voltou a ter interesse
    },
};

// Especialidades "da casa" cujo paciente pode virar candidato (campo Appointment.specialty).
export const NEURO_REFERRAL_HOME_SPECIALTIES = ['fonoaudiologia', 'psicologia', 'terapia_ocupacional'];

// Especialidade da consulta com neuropediatra no Appointment.
export const NEURO_SPECIALTY = 'neuroped';

// Recusou: não volta a ser sugerido automaticamente por este período.
export const NEURO_REFERRAL_DECLINE_COOLDOWN_DAYS = 180;

// Termos que geram sugestão automática (procurados sem acento e em minúsculas).
// Cada entrada: motivo + regex. Mantido curto e específico para não sugerir à toa.
export const NEURO_SIGNAL_PATTERNS = [
    { reason: 'tea', term: 'autismo', re: /\bautis(mo|ta)\b/ },
    { reason: 'tea', term: 'TEA', re: /\btea\b/ },
    { reason: 'tea', term: 'espectro autista', re: /\bespectro\b/ },
    { reason: 'tea', term: 'asperger', re: /\basperger\b/ },
    { reason: 'tdah', term: 'TDAH', re: /\btdah?\b/ },
    { reason: 'tdah', term: 'hiperatividade', re: /\bhiperativ(idade|o|a)\b/ },
    { reason: 'tdah', term: 'déficit de atenção', re: /\bdeficit de atencao\b/ },
];
