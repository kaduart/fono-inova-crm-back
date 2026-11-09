/**
 * Texto para o comercial quando cancelamentos informados na geração de sessões batem com
 * atendimentos já existentes. Função pura (sem banco) — ver docs/MENSAGERIA_PADRAO.md §4:
 * dizer qual data, o que já está lá e o que fazer; listar tudo de uma vez (máx. 5 + "e mais N").
 */
const STATUS_LABELS = {
  scheduled: 'agendado', pre_agendado: 'pré-agendado', confirmed: 'confirmado', pending: 'pendente',
  completed: 'realizado', canceled: 'cancelado', cancelled: 'cancelado', force_cancelled: 'cancelado',
  missed: 'falta', no_show: 'falta',
};
const MAX_LINES = 5;

const brDate = iso => String(iso || '').slice(0, 10).split('-').reverse().join('/');
export const specialtyLabel = value => {
  const text = String(value || '').replace(/_/g, ' ').trim();
  return text ? text[0].toUpperCase() + text.slice(1) : '';
};

/** "Fonoaudiologia com Lorrany (guia 0020), pré-agendado" */
export function describeExistingAppointment(existing = {}) {
  const parts = [specialtyLabel(existing.specialty) || 'Atendimento'];
  if (existing.doctorName) parts.push(`com ${existing.doctorName}`);
  let text = parts.join(' ');
  if (existing.guideNumber) text += ` (guia ${existing.guideNumber})`;
  else if (existing.liminar) text += ' (liminar)';
  const status = STATUS_LABELS[existing.status] || existing.status;
  if (status) text += `, ${status}`;
  return text;
}

function lineFor(conflict) {
  const when = `${brDate(conflict.date)} às ${conflict.time}`;
  if (Array.isArray(conflict.existing) && conflict.existing.length) {
    return `• ${when} — já existe ${conflict.existing.map(describeExistingAppointment).join(' e ')}`;
  }
  return `• ${when} — ${conflict.message || 'já existe atendimento nesse horário'}`;
}

/** @returns {{ title: string, action: string, message: string, items: object[] }} */
export function buildCancellationConflictMessage(conflicts = []) {
  const total = conflicts.length;
  const blocked = conflicts.some(c => ['COMPLETED_CANCELLATION_BLOCKED', 'CONSUMED_SESSION_CANCELLATION_BLOCKED'].includes(c.code));
  const title = total === 1
    ? 'Nada foi gerado — 1 data cancelada bate com um atendimento já lançado'
    : `Nada foi gerado — ${total} datas canceladas batem com atendimentos já lançados`;
  const lines = conflicts.slice(0, MAX_LINES).map(lineFor);
  if (total > MAX_LINES) lines.push(`• e mais ${total - MAX_LINES}`);
  const action = blocked
    ? 'Sessão já realizada não pode virar cancelamento: peça a correção ao administrativo. Nada foi salvo.'
    : 'Se o atendimento existente é o certo, tire essa data da lista de cancelamentos. Se ele está errado, cancele ou remarque pela agenda e confira de novo. Nada foi salvo.';
  const items = conflicts.map(c => ({
    date: c.date, time: c.time, specialty: c.specialty, code: c.code || null,
    reason: c.message || null, existing: c.existing || [],
  }));
  return { title, action, message: [title, ...lines, '', action].join('\n'), items };
}
