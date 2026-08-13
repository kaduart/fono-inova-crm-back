/**
 * 🧪 Reparo da guia 16173377 — lógica de decisão, sem banco
 *
 * Testa as decisões que o script toma antes de escrever: prova de consumo,
 * retomabilidade por estado, saldo projetado e reconciliação final.
 *
 * ⚠️ Local e produção compartilham o mesmo MongoDB. Esta suíte é 100% em
 * memória e aborta se detectar URI real.
 */

import { describe, it, expect } from 'vitest';

for (const k of ['MONGO_URI', 'MONGODB_URI', 'MONGO_URL', 'DATABASE_URL']) {
  if (process.env[k] && /mongodb\+srv|\.mongodb\.net|prod/i.test(process.env[k])) {
    throw new Error(`🚫 ABORTADO: ${k} aponta para infraestrutura real.`);
  }
  delete process.env[k];
}

// ── Réplicas das funções de decisão do script ──────────────────────────────

function provarConsumo(appts, consumptionHistory, sessionsPorAppt) {
  const ocorrencias = new Map();
  for (const h of consumptionHistory) {
    const k = String(h.sessionId);
    ocorrencias.set(k, (ocorrencias.get(k) || 0) + 1);
  }
  const problemas = [];
  const duplicados = [...ocorrencias.entries()].filter(([, n]) => n > 1);
  if (duplicados.length) problemas.push(`consumptionHistory duplicado: ${duplicados.map(([k]) => k).join(',')}`);

  const evidencias = [];
  for (const a of appts) {
    const sessions = sessionsPorAppt[a._id] || [];
    const noHistorico = sessions.filter(s => ocorrencias.has(String(s._id)));
    const total = noHistorico.reduce((n, s) => n + ocorrencias.get(String(s._id)), 0);
    if (total === 0) problemas.push(`${a._id}: nenhum consumo no histórico`);
    else if (total > 1) problemas.push(`${a._id}: ${total} consumos`);
    else evidencias.push({ appointmentId: a._id, sessionId: noHistorico[0]._id });
  }
  return { evidencias, problemas };
}

function classificar1208(candidatos) {
  if (candidatos.length === 0) return { situacao: 'AUSENTE', acao: 'criar e concluir' };
  if (candidatos.length > 1) return { situacao: 'DUPLICADO', acao: 'abortar' };
  const a = candidatos[0];
  if (a.operationalStatus === 'completed') return { situacao: 'CONCLUIDO', acao: 'no-op', appt: a };
  if (['pre_agendado', 'scheduled', 'confirmed'].includes(a.operationalStatus)) {
    return { situacao: 'PENDENTE', acao: 'reutilizar e concluir', appt: a };
  }
  return { situacao: 'ESTADO_INESPERADO', acao: 'abortar', appt: a };
}

function projetarSaldo({ usedSessions, estornosPendentes, estado1208, confirm }) {
  const criadas = (confirm && ['AUSENTE', 'PENDENTE'].includes(estado1208.situacao)) ? 1 : 0;
  return usedSessions - estornosPendentes + criadas;
}

function reconciliar({ guide, appointmentsCompleted, sessionsCompleted, paysLegitimos, paysIndevidos, ledger, especialidades }) {
  const liquido = ledger.filter(l => !l.reversedAt).reduce((s, l) => s + l.amount, 0);
  return [
    ['guia.usedSessions = 3', guide.usedSessions === 3],
    ['consumptionHistory = 3', guide.consumptionHistory.length === 3],
    ['3 appointments completed', appointmentsCompleted === 3],
    ['3 Sessions completed', sessionsCompleted === 3],
    ['3 Payments pending_billing', paysLegitimos.length === 3 && paysLegitimos.every(p => p.insurance.status === 'pending_billing')],
    ['6 Payments fora do faturamento', paysIndevidos.every(p => p.status === 'canceled' && !p.insurance.status)],
    ['ledger líquido = 240', Math.abs(liquido - 240) < 0.01],
    ['especialidade única = TO', especialidades.size === 1 && especialidades.has('terapia_ocupacional')],
  ];
}

// ── Fixture: o estado real, sem tocar no banco ─────────────────────────────
const seisIndevidos = ['f1', 'f2', 'f3', 'f4', 'f5', 'x1809'].map(id => ({ _id: id }));
const sessionsPorAppt = Object.fromEntries(
  seisIndevidos.map(a => [a._id, [{ _id: `s_${a._id}` }, { _id: `dup_${a._id}` }]])
);
// consumptionHistory: 6 indevidos + 2 reais = 8 (bate com produção)
const historicoOk = [
  ...seisIndevidos.map(a => ({ sessionId: `s_${a._id}` })),
  { sessionId: 's_real1707' }, { sessionId: 's_real2407' },
];

describe('1. prova de consumo antes de decrementar', () => {
  it('aceita quando cada appointment tem exatamente 1 consumo', () => {
    const r = provarConsumo(seisIndevidos, historicoOk, sessionsPorAppt);
    expect(r.problemas).toEqual([]);
    expect(r.evidencias).toHaveLength(6);
  });

  it('aborta se um appointment não tem consumo — decrementar roubaria autorização alheia', () => {
    const historico = historicoOk.filter(h => h.sessionId !== 's_f3');
    const r = provarConsumo(seisIndevidos, historico, sessionsPorAppt);
    expect(r.problemas.some(p => /f3.*nenhum consumo/.test(p))).toBe(true);
  });

  it('aborta se houver consumo duplicado — um $pull deixaria resíduo', () => {
    const historico = [...historicoOk, { sessionId: 's_f1' }];
    const r = provarConsumo(seisIndevidos, historico, sessionsPorAppt);
    expect(r.problemas.length).toBeGreaterThan(0);
    expect(r.problemas.some(p => /duplicado|2 consumos/.test(p))).toBe(true);
  });

  it('a duplicidade conhecida de Sessions não gera falso positivo', () => {
    // Cada appointment tem 2 Sessions (bug do gerador), mas só 1 no histórico
    const r = provarConsumo(seisIndevidos, historicoOk, sessionsPorAppt);
    expect(r.evidencias.every(e => e.sessionId.startsWith('s_'))).toBe(true);
  });
});

describe('2. retomabilidade por estado do 12/08', () => {
  it('AUSENTE → criar e concluir', () => {
    expect(classificar1208([])).toMatchObject({ situacao: 'AUSENTE', acao: 'criar e concluir' });
  });

  it('PENDENTE → reutilizar, não recriar', () => {
    const r = classificar1208([{ _id: 'p1', operationalStatus: 'pre_agendado' }]);
    expect(r).toMatchObject({ situacao: 'PENDENTE', acao: 'reutilizar e concluir' });
    expect(r.appt._id).toBe('p1');
  });

  it('CONCLUIDO → no-op', () => {
    expect(classificar1208([{ _id: 'c1', operationalStatus: 'completed' }]))
      .toMatchObject({ situacao: 'CONCLUIDO', acao: 'no-op' });
  });

  it('DUPLICADO → abortar', () => {
    expect(classificar1208([{ _id: 'd1', operationalStatus: 'scheduled' }, { _id: 'd2', operationalStatus: 'scheduled' }]))
      .toMatchObject({ situacao: 'DUPLICADO', acao: 'abortar' });
  });

  it('estado inesperado → abortar', () => {
    expect(classificar1208([{ _id: 'e1', operationalStatus: 'suspended' }]))
      .toMatchObject({ situacao: 'ESTADO_INESPERADO', acao: 'abortar' });
  });
});

describe('3. saldo projetado', () => {
  it('execução completa: 8 → 3', () => {
    expect(projetarSaldo({ usedSessions: 8, estornosPendentes: 6, estado1208: { situacao: 'AUSENTE' }, confirm: true })).toBe(3);
  });

  it('segunda execução é no-op: 3 → 3', () => {
    expect(projetarSaldo({ usedSessions: 3, estornosPendentes: 0, estado1208: { situacao: 'CONCLUIDO' }, confirm: true })).toBe(3);
  });

  it('falha após os estornos deixa 2/10', () => {
    expect(projetarSaldo({ usedSessions: 8, estornosPendentes: 6, estado1208: { situacao: 'AUSENTE' }, confirm: false })).toBe(2);
  });

  it('retomada a partir de 2/10 com o 12/08 pendente chega a 3', () => {
    expect(projetarSaldo({ usedSessions: 2, estornosPendentes: 0, estado1208: { situacao: 'PENDENTE' }, confirm: true })).toBe(3);
  });

  it('sem a flag de confirmação, a projeção não fecha em 3', () => {
    expect(projetarSaldo({ usedSessions: 8, estornosPendentes: 6, estado1208: { situacao: 'AUSENTE' }, confirm: false }))
      .not.toBe(3);
  });
});

describe('4. payment estornado sai do faturamento', () => {
  const estornado = { status: 'canceled', insurance: { status: null } };
  const legitimo = { status: 'pending', insurance: { status: 'pending_billing' } };

  // Filtro canônico: buildInsuranceReceivableFilter
  const faturavel = (p) => p.status !== 'canceled' && ['pending_billing', 'billed'].includes(p.insurance?.status);

  it('estornado não aparece em "a faturar"', () => {
    expect(faturavel(estornado)).toBe(false);
  });

  it('legítimo continua aparecendo', () => {
    expect(faturavel(legitimo)).toBe(true);
  });

  it('não basta cancelar: insurance.status precisa sair de pending_billing', () => {
    const meioEstornado = { status: 'canceled', insurance: { status: 'pending_billing' } };
    // O filtro canônico já exclui, mas leitores que olham só o convênio pegariam
    expect(meioEstornado.insurance.status).toBe('pending_billing');
    expect(estornado.insurance.status).toBeNull();
  });
});

describe('5. reconciliação final', () => {
  const estadoBom = {
    guide: { usedSessions: 3, consumptionHistory: [{}, {}, {}] },
    appointmentsCompleted: 3,
    sessionsCompleted: 3,
    paysLegitimos: [1, 2, 3].map(() => ({ insurance: { status: 'pending_billing' } })),
    paysIndevidos: Array(6).fill({ status: 'canceled', insurance: { status: null } }),
    ledger: [{ amount: 80 }, { amount: 80 }, { amount: 80 }, { amount: 80, reversedAt: new Date() }],
    especialidades: new Set(['terapia_ocupacional']),
  };

  it('estado correto passa nas 8 verificações', () => {
    const checks = reconciliar(estadoBom);
    expect(checks.filter(([, ok]) => !ok)).toEqual([]);
    expect(checks).toHaveLength(8);
  });

  it('guia fora de 3 reprova', () => {
    const checks = reconciliar({ ...estadoBom, guide: { usedSessions: 4, consumptionHistory: [{}, {}, {}] } });
    expect(checks.find(([n]) => n.includes('usedSessions'))[1]).toBe(false);
  });

  it('ledger diferente de R$ 240 reprova', () => {
    const checks = reconciliar({ ...estadoBom, ledger: [{ amount: 80 }, { amount: 80 }] });
    expect(checks.find(([n]) => n.includes('ledger'))[1]).toBe(false);
  });

  it('payment indevido ainda em pending_billing reprova', () => {
    const checks = reconciliar({
      ...estadoBom,
      paysIndevidos: [{ status: 'canceled', insurance: { status: 'pending_billing' } }],
    });
    expect(checks.find(([n]) => n.includes('fora do faturamento'))[1]).toBe(false);
  });

  it('especialidade misturada reprova', () => {
    const checks = reconciliar({ ...estadoBom, especialidades: new Set(['terapia_ocupacional', 'fonoaudiologia']) });
    expect(checks.find(([n]) => n.includes('especialidade'))[1]).toBe(false);
  });
});
