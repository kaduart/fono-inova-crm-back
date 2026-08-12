/**
 * 🧪 Testes unitários — Política de edição de Package (PUT /api/v2/packages/:id)
 *
 * Trava as três decisões que geraram o incidente de 2026-08-12:
 * 1. type='package' (dialeto da API) precisa virar 'therapy' antes do Mongoose,
 *    senão o enum estoura como 500 opaco.
 * 2. Campo protegido enviado com valor DIFERENTE deve ser recusado com motivo —
 *    nunca gravado, nunca descartado em silêncio com resposta 200.
 * 3. Campo protegido reenviado com o MESMO valor é payload legado inofensivo:
 *    ignora, não recusa.
 */

import { describe, it, expect } from 'vitest';
import {
  classifyUpdates,
  normalizeApiDialect,
  buildBlockedMessage,
  EDITABLE_FIELDS,
} from '../../services/billing/commands/packageUpdatePolicy.js';

const basePackage = {
  _id: 'pkg1',
  patient: '6a1d740b4bafb710ab15562b',
  doctor: '684072213830f473da1b0b0b',
  specialty: 'fonoaudiologia',
  sessionType: 'fonoaudiologia',
  type: 'therapy',
  model: 'prepaid',
  paymentType: 'full',
  totalSessions: 8,
  sessionValue: 180,
  totalValue: 1440,
  totalPaid: 1440,
  sessionsDone: 2,
  notes: '',
};

describe('normalizeApiDialect', () => {
  it("traduz type='package' (contrato da API) para 'therapy' (enum do schema)", () => {
    expect(normalizeApiDialect({ type: 'package' }).type).toBe('therapy');
  });

  it('não mexe em outros valores de type', () => {
    expect(normalizeApiDialect({ type: 'convenio' }).type).toBe('convenio');
  });
});

describe('classifyUpdates — campos protegidos', () => {
  it('recusa redução da quantidade contratada', () => {
    const { blocked, allowed } = classifyUpdates({ totalSessions: 4 }, basePackage);
    expect(allowed).toEqual({});
    expect(blocked.map(b => b.field)).toContain('totalSessions');
  });

  it('recusa alteração do valor total (venda é fato histórico)', () => {
    const { blocked } = classifyUpdates({ totalValue: 720 }, basePackage);
    expect(blocked.map(b => b.field)).toContain('totalValue');
  });

  it('recusa reescrita de pagamentos', () => {
    const { blocked } = classifyUpdates(
      { payments: [{ amount: 1440, method: 'pix' }] },
      basePackage
    );
    expect(blocked.map(b => b.field)).toContain('payments');
  });

  it('recusa troca de especialidade', () => {
    const { blocked } = classifyUpdates({ sessionType: 'psicologia', specialty: 'psicologia' }, basePackage);
    expect(blocked.map(b => b.field).sort()).toEqual(['sessionType', 'specialty']);
  });

  it('recusa troca de profissional e aponta o fluxo em lote', () => {
    const { blocked } = classifyUpdates({ doctorId: 'outro-doctor-id' }, basePackage);
    expect(blocked).toHaveLength(1);
    expect(blocked[0].field).toBe('doctorId');
    expect(blocked[0].hint).toMatch(/sessões futuras/i);
  });

  it('recusa troca de paciente', () => {
    const { blocked } = classifyUpdates({ patientId: 'outro-paciente' }, basePackage);
    expect(blocked.map(b => b.field)).toContain('patientId');
  });
});

describe('classifyUpdates — payload legado sem intenção de mudança', () => {
  it('ignora campos protegidos reenviados com o valor atual', () => {
    const { blocked, allowed, ignored } = classifyUpdates(
      {
        patientId: basePackage.patient,
        doctorId: basePackage.doctor,
        specialty: 'fonoaudiologia',
        sessionType: 'fonoaudiologia',
        totalSessions: 8,
        sessionValue: 180,
        type: 'package', // dialeto da API → therapy → igual ao atual
        paymentType: 'full',
      },
      basePackage
    );

    expect(blocked).toEqual([]);
    expect(allowed).toEqual({});
    expect(ignored).toContain('type');
    expect(ignored).toContain('doctorId');
  });

  it('ignora campos que nem existem no schema (name, modality)', () => {
    const { blocked, ignored } = classifyUpdates(
      { name: 'Pacote package', modality: 'presencial' },
      basePackage
    );
    expect(blocked).toEqual([]);
    expect(ignored).toEqual(expect.arrayContaining(['name', 'modality']));
  });

  it('ignora payments vazio (front manda [] em per-session)', () => {
    const { blocked, ignored } = classifyUpdates({ payments: [] }, basePackage);
    expect(blocked).toEqual([]);
    expect(ignored).toContain('payments');
  });
});

describe('classifyUpdates — campo editável', () => {
  it('aceita notes', () => {
    const { allowed, blocked } = classifyUpdates({ notes: 'Paciente migrou para psico' }, basePackage);
    expect(blocked).toEqual([]);
    expect(allowed).toEqual({ notes: 'Paciente migrou para psico' });
  });

  it('ignora notes reenviado igual', () => {
    const { allowed, ignored } = classifyUpdates({ notes: '' }, basePackage);
    expect(allowed).toEqual({});
    expect(ignored).toContain('notes');
  });

  it('a lista de editáveis é deliberadamente mínima', () => {
    expect(EDITABLE_FIELDS).toEqual(['notes']);
  });
});

describe('buildBlockedMessage', () => {
  it('em pacote já iniciado, explica e aponta a transferência', () => {
    const { blocked } = classifyUpdates({ totalSessions: 4 }, basePackage);
    const msg = buildBlockedMessage(blocked, basePackage);
    expect(msg).toMatch(/já possui sessões realizadas/i);
    expect(msg).toMatch(/Transferir sessões/i);
  });

  it('em pacote sem sessões realizadas, usa o motivo específico do campo', () => {
    const virgin = { ...basePackage, sessionsDone: 0 };
    const { blocked } = classifyUpdates({ doctorId: 'outro' }, virgin);
    const msg = buildBlockedMessage(blocked, virgin);
    expect(msg).toMatch(/profissional/i);
    expect(msg).not.toMatch(/já possui sessões realizadas/i);
  });
});
