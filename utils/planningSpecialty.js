// Metas por especialidade (Planning.bySpecialty).
// O front manda { specialty, sessions, revenue }; o banco guarda { specialty (slug), targetSessions, targetRevenue }.
// Rótulo livre antigo ("Fonoaudiologia", "Terapia Ocupacional") vira o slug usado em Appointment.specialty,
// para o realizado por especialidade bater com a agenda.

const SLUG_BY_LABEL = {
  fonoaudiologia: 'fonoaudiologia',
  fono: 'fonoaudiologia',
  'terapia ocupacional': 'terapia_ocupacional',
  to: 'terapia_ocupacional',
  psicologia: 'psicologia',
  fisioterapia: 'fisioterapia',
  pediatria: 'pediatria',
  neuropediatria: 'neuroped',
  musicoterapia: 'musicoterapia',
  psicomotricidade: 'psicomotricidade',
  psicopedagogia: 'psicopedagogia',
  neuropsicologia: 'neuropsicologia',
};

const stripAccents = (s) => s.normalize('NFD').replace(/[̀-ͯ]/g, '');

export const toSpecialtySlug = (value) => {
  if (!value || typeof value !== 'string') return '';
  const raw = stripAccents(value.trim().toLowerCase());
  if (SLUG_BY_LABEL[raw]) return SLUG_BY_LABEL[raw];
  return raw.replace(/\s+/g, '_');
};

const num = (v) => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : 0;
};

/** Normaliza a lista vinda da API; junta especialidades repetidas. Preserva o realizado já calculado. */
export const normalizeBySpecialty = (list = [], previous = []) => {
  if (!Array.isArray(list)) return [];
  const prevBySlug = new Map((previous || []).map((p) => [toSpecialtySlug(p.specialty), p]));
  const merged = new Map();
  for (const item of list) {
    const slug = toSpecialtySlug(item?.specialty);
    if (!slug) continue;
    const cur = merged.get(slug) || { specialty: slug, targetSessions: 0, targetRevenue: 0 };
    cur.targetSessions += num(item.sessions ?? item.targetSessions);
    cur.targetRevenue += num(item.revenue ?? item.targetRevenue);
    merged.set(slug, cur);
  }
  return [...merged.values()].map((s) => {
    const prev = prevBySlug.get(s.specialty);
    return {
      ...s,
      completedSessions: prev?.completedSessions || 0,
      actualRevenue: prev?.actualRevenue || 0,
    };
  });
};

/**
 * Realizado por especialidade a partir dos atendimentos concluídos do período.
 * Receita = produção (sessionValue dos atendimentos concluídos), não caixa.
 */
export const computeSpecialtyActuals = (bySpecialty = [], completedAppointments = []) => {
  const agg = new Map();
  for (const a of completedAppointments) {
    const slug = toSpecialtySlug(a?.specialty);
    if (!slug) continue;
    const cur = agg.get(slug) || { sessions: 0, revenue: 0 };
    cur.sessions += 1;
    cur.revenue += Number(a.sessionValue) || 0;
    agg.set(slug, cur);
  }
  return (bySpecialty || []).map((s) => {
    const plain = typeof s.toObject === 'function' ? s.toObject() : s;
    const slug = toSpecialtySlug(plain.specialty);
    const real = agg.get(slug) || { sessions: 0, revenue: 0 };
    return {
      ...plain,
      specialty: slug,
      completedSessions: real.sessions,
      actualRevenue: Math.round(real.revenue * 100) / 100,
    };
  });
};
