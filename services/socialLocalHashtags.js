const LOCAL_TAGS_BY_THEME = {
  fonoaudiologia: ['fonoaudiologia', 'fonoaudiologa'],
  fonoaudiologia_anapolis: ['fonoaudiologia', 'fonoaudiologa'],
  fono_adulto: ['fonoaudiologiaadulto', 'fonoaudiologa'],
  psicologia: ['psicologiainfantil', 'psicologainfantil'],
  psicologia_infantil_anapolis: ['psicologiainfantil', 'psicologainfantil'],
  terapia_ocupacional: ['terapiaocupacional', 'terapeutaocupacional'],
  terapia_ocupacional_anapolis: ['terapiaocupacional', 'terapeutaocupacional'],
  fisioterapia: ['fisioterapiainfantil', 'fisioterapeutainfantil'],
  fisioterapia_infantil_anapolis: ['fisioterapiainfantil', 'fisioterapeutainfantil'],
  psicomotricidade: ['psicomotricidade', 'psicomotricista'],
  psicomotricidade_anapolis: ['psicomotricidade', 'psicomotricista'],
  freio_lingual: ['testedalinguinha', 'fonoaudiologia', 'fonoaudiologa'],
  teste_da_linguinha_anapolis: ['testedalinguinha', 'fonoaudiologia', 'fonoaudiologa'],
  neuropsicologia: ['avaliacaoneuropsicologica', 'neuropsicologia'],
  avaliacao_neuropsicologica_anapolis: ['avaliacaoneuropsicologica', 'neuropsicologia'],
  psicopedagogia_clinica: ['psicopedagogiaclinica', 'psicopedagoga'],
  psicopedagogia: ['psicopedagogia', 'psicopedagoga'],
  musicoterapia: ['musicoterapia', 'musicoterapeuta'],
  tdah: ['tdahinfantil', 'avaliacaotdah'],
  autismo: ['autismoinfantil', 'avaliacaoautismo'],
  neuropediatria: ['neuropediatra', 'neuropediatria'],
  neuropediatria_anapolis: ['neuropediatra', 'neuropediatria'],
  plano_saude_reembolso: ['reembolsoplanodesaude', 'terapiainfantil'],
};

function normalizeTag(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');
}

function topicTag(topic) {
  const value = String(topic || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
  const topics = [
    [/teste da linguinha|freio lingual|lingua presa/, 'testedalinguinha'],
    [/atraso (?:da|de|na) fala|fala tardia/, 'atrasodafala'],
    [/avaliacao neuropsicologica/, 'avaliacaoneuropsicologica'],
    [/neuropediatr/, 'neuropediatra'],
    [/terapia ocupacional/, 'terapiaocupacional'],
    [/psicologia infantil/, 'psicologiainfantil'],
    [/fisioterapia infantil/, 'fisioterapiainfantil'],
    [/psicomotricidade/, 'psicomotricidade'],
    [/dislexia/, 'dislexia'],
    [/autismo|\btea\b/, 'autismo'],
    [/\btdah\b/, 'tdah'],
  ];
  return topics.find(([pattern]) => pattern.test(value))?.[1] || null;
}

export function requiredLocalHashtags(theme, topic = '') {
  const id = typeof theme === 'string' ? theme : theme?.id;
  const specialties = LOCAL_TAGS_BY_THEME[id] || [normalizeTag(id).replace(/anapolis$/, '') || 'fonoinova', 'fonoinova'];
  const subject = topicTag(topic);
  return [...new Set([
    ...(subject ? [`#${subject}anapolis`] : []),
    ...specialties.map((specialty) => `#${specialty}anapolis`),
  ])].slice(0, 4);
}

export function ensureLocalHashtags(text, theme, maxLength = Infinity, topic = '') {
  const body = String(text || '').trim();
  const present = new Set([...body.matchAll(/#([^\s#]+)/g)].map((match) => normalizeTag(match[1])));
  const missing = requiredLocalHashtags(theme, topic).filter((tag) => !present.has(normalizeTag(tag)));
  if (!missing.length) return body;

  const suffix = `\n\n${missing.join(' ')}`;
  const available = Math.max(0, maxLength - suffix.length);
  const trimmedBody = body.length > available ? body.slice(0, available).trimEnd() : body;
  return `${trimmedBody}${suffix}`.trim();
}
