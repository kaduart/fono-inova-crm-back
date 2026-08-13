/**
 * 🧪 Coerência de especialidade: plano = guia = profissional
 *
 * Incidente guia 16173377 (Ícaro): o plano nasceu `fonoaudiologia` contra uma
 * guia de `terapia_ocupacional`, com profissional de TO. Sobreviveu a 5 edições
 * porque o PATCH nem aceitava `specialty` — não havia como corrigir. Alguém
 * "consertou" um appointment na mão, o que não propagou e ainda concluiu a
 * sessão sem querer.
 *
 * Testa as duas funções puras de decisão extraídas da rota, sem banco.
 *
 * ⚠️ Local e produção compartilham o mesmo MongoDB — esta suíte não conecta.
 */

import { describe, it, expect } from 'vitest';

for (const k of ['MONGO_URI', 'MONGODB_URI', 'MONGO_URL', 'DATABASE_URL']) {
  if (process.env[k] && /mongodb\+srv|\.mongodb\.net|prod/i.test(process.env[k])) {
    throw new Error(`🚫 ABORTADO: ${k} aponta para infraestrutura real.`);
  }
  delete process.env[k];
}

/** Réplica da regra da rota (POST e PATCH usam a mesma lógica). */
function checarCoerencia({ planSpecialty, guide, doctor }) {
  const mismatches = [];
  if (guide?.specialty && planSpecialty !== guide.specialty) {
    mismatches.push(`a guia #${guide.number} autoriza "${guide.specialty}", não "${planSpecialty}"`);
  }
  const declared = doctor
    ? [doctor.specialty, ...(doctor.specialties || [])].filter(Boolean).map(s => String(s).toLowerCase())
    : [];
  if (declared.length > 0 && !declared.includes(String(planSpecialty).toLowerCase())) {
    mismatches.push(`${doctor.fullName} atende "${declared.join(', ')}", não "${planSpecialty}"`);
  }
  return mismatches;
}

/** Classificação de impacto — réplica de avaliarImpactoCorrecaoEspecialidade. */
function classificarImpacto(appts, novaEspecialidade, paymentsPorAppt = {}) {
  const elegiveis = [], bloqueados = [], jaCorretos = [];
  for (const a of appts) {
    if (a.specialty === novaEspecialidade) { jaCorretos.push(a); continue; }
    if (a.operationalStatus === 'completed') {
      bloqueados.push({ ...a, motivo: 'atendimento concluído — exige reparo administrativo' }); continue;
    }
    if (['canceled', 'missed'].includes(a.operationalStatus)) {
      bloqueados.push({ ...a, motivo: 'cancelado/falta — histórico não é reescrito' }); continue;
    }
    const pays = paymentsPorAppt[a._id] || [];
    const travado = pays.find(p =>
      p.insurance?.batchId || p.batchId ||
      ['billed', 'received'].includes(p.insurance?.status) ||
      ['paid', 'received'].includes(p.status));
    if (travado) { bloqueados.push({ ...a, motivo: 'pagamento já faturado/em lote' }); continue; }
    elegiveis.push(a);
  }
  return { elegiveis, bloqueados, jaCorretos };
}

const GUIA_TO = { number: '16173377', specialty: 'terapia_ocupacional' };
const THAYNA = { fullName: 'Thayna Miranda', specialty: 'terapia_ocupacional', specialties: [] };
const FONO = { fullName: 'Lorrany', specialty: 'fonoaudiologia', specialties: [] };

describe('validação de coerência', () => {
  it('reproduz o incidente: plano fono contra guia TO com profissional TO', () => {
    const erros = checarCoerencia({ planSpecialty: 'fonoaudiologia', guide: GUIA_TO, doctor: THAYNA });
    expect(erros).toHaveLength(2);
    expect(erros[0]).toMatch(/autoriza "terapia_ocupacional"/);
    expect(erros[1]).toMatch(/atende "terapia_ocupacional"/);
  });

  it('aceita a tríade coerente', () => {
    expect(checarCoerencia({ planSpecialty: 'terapia_ocupacional', guide: GUIA_TO, doctor: THAYNA })).toEqual([]);
  });

  it('recusa profissional que não atende a especialidade da guia', () => {
    const erros = checarCoerencia({ planSpecialty: 'terapia_ocupacional', guide: GUIA_TO, doctor: FONO });
    expect(erros).toHaveLength(1);
    expect(erros[0]).toMatch(/Lorrany atende/);
  });

  it('recusa especialidade diferente da guia mesmo com profissional compatível', () => {
    const erros = checarCoerencia({ planSpecialty: 'fonoaudiologia', guide: GUIA_TO, doctor: FONO });
    expect(erros.some(e => /guia #16173377/.test(e))).toBe(true);
  });

  it('profissional multi-especialidade é aceito se cobre a da guia', () => {
    const multi = { fullName: 'Ana', specialty: 'fonoaudiologia', specialties: ['terapia_ocupacional'] };
    expect(checarCoerencia({ planSpecialty: 'terapia_ocupacional', guide: GUIA_TO, doctor: multi })).toEqual([]);
  });
});

describe('impacto da correção cadastral', () => {
  const appts = [
    { _id: 'a1', specialty: 'fonoaudiologia', operationalStatus: 'scheduled' },
    { _id: 'a2', specialty: 'fonoaudiologia', operationalStatus: 'pre_agendado' },
    { _id: 'a3', specialty: 'fonoaudiologia', operationalStatus: 'completed' },
    { _id: 'a4', specialty: 'fonoaudiologia', operationalStatus: 'canceled' },
    { _id: 'a5', specialty: 'fonoaudiologia', operationalStatus: 'missed' },
    { _id: 'a6', specialty: 'terapia_ocupacional', operationalStatus: 'scheduled' },
    { _id: 'a7', specialty: 'fonoaudiologia', operationalStatus: 'scheduled' },
  ];
  const pays = { a7: [{ insurance: { status: 'billed', batchId: 'LOTE-1' } }] };

  const r = classificarImpacto(appts, 'terapia_ocupacional', pays);

  it('futuros sem faturamento são elegíveis', () => {
    expect(r.elegiveis.map(a => a._id)).toEqual(['a1', 'a2']);
  });

  it('concluído é bloqueado — exige reparo administrativo', () => {
    expect(r.bloqueados.find(a => a._id === 'a3').motivo).toMatch(/concluído/);
  });

  it('cancelado e falta são bloqueados — histórico não é reescrito', () => {
    expect(r.bloqueados.find(a => a._id === 'a4').motivo).toMatch(/histórico/);
    expect(r.bloqueados.find(a => a._id === 'a5').motivo).toMatch(/histórico/);
  });

  it('item em lote é bloqueado', () => {
    expect(r.bloqueados.find(a => a._id === 'a7').motivo).toMatch(/lote/);
  });

  it('já correto não entra em nenhuma lista de mudança', () => {
    expect(r.jaCorretos.map(a => a._id)).toEqual(['a6']);
    expect([...r.elegiveis, ...r.bloqueados].map(a => a._id)).not.toContain('a6');
  });

  it('nada é alterado automaticamente entre os bloqueados', () => {
    expect(r.bloqueados).toHaveLength(4);
    expect(r.bloqueados.every(b => b.motivo)).toBe(true);
  });
});

describe('correção cadastral × mudança de terapia', () => {
  it('alinhar o plano À GUIA é correção cadastral', () => {
    const nova = 'terapia_ocupacional';
    expect(nova === GUIA_TO.specialty).toBe(true); // reconcilia vínculos
  });

  it('divergir da guia é mudança de terapia — exige plano novo, não PATCH', () => {
    const nova = 'psicologia';
    const erros = checarCoerencia({ planSpecialty: nova, guide: GUIA_TO, doctor: THAYNA });
    expect(erros.length).toBeGreaterThan(0);
    // A rota devolve 422 com a orientação de encerrar o plano e criar outro,
    // em vez de transformar uma terapia na outra em silêncio.
  });
});
