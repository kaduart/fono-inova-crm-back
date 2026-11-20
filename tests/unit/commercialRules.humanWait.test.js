import { describe, it, expect } from 'vitest';
import { humanWait, leadAssignee, currentHandoffAt, waitKeyOf } from '../../services/commercial/commercialRules.js';

// Datas fictícias, 20/11 no horário de Brasília (-03:00)
const t = hhmm => new Date(`2026-11-20T${hhmm}:00-03:00`);
const amanha = hhmm => new Date(`2026-11-21T${hhmm}:00-03:00`);
const ANA = '64b000000000000000000a11';

// Estado que o transferir_para_equipe da Amanda grava (services/agent/amanda/tools.js)
const encaminhado = at => ({
  currentState: 'HANDOFF',
  autoReplyEnabled: true,
  manualControl: { active: true, takenOverAt: at, takenOverBy: null },
  amandaAgent: { handoff: { motivo: 'quer falar com atendente', at } },
});

describe('fila "Lead sem resposta": cronômetro começa no encaminhamento da Amanda', () => {
  it('encaminhado sem resposta humana: espera desde o encaminhamento, ninguém assumiu', () => {
    const lead = encaminhado(t('09:00'));
    const w = humanWait({ lead, lastInboundAt: t('08:58') });
    expect(w).toMatchObject({ state: 'esperando', reason: 'handoff' });
    expect(w.since).toEqual(t('09:00'));
    expect(leadAssignee(lead)).toEqual({ kind: 'ninguem' });
  });

  it('resposta da Amanda (sentBy amanda) não conta: só a resposta manual aceita', () => {
    // a rota só passa como lastHumanReplyAt mensagens sentBy 'manual' com status sent/delivered/read
    const w = humanWait({ lead: encaminhado(t('09:00')), lastInboundAt: t('08:58'), lastHumanReplyAt: null });
    expect(w.state).toBe('esperando');
  });

  it('envio manual que FALHOU não tira da fila (nenhuma Message aceita é gravada)', () => {
    // sendViaWhatsAppWeb só grava Message com status 'sent' depois do envio aceito;
    // a falha fica no deliveryGuard e não chega como lastHumanReplyAt
    const w = humanWait({ lead: encaminhado(t('09:00')), lastInboundAt: t('08:58'), lastHumanReplyAt: null });
    expect(w).toMatchObject({ state: 'esperando', reason: 'handoff' });
    expect(w.since).toEqual(t('09:00'));
  });

  it('resposta manual aceita depois do encaminhamento tira da fila', () => {
    const w = humanWait({ lead: encaminhado(t('09:00')), lastInboundAt: t('08:58'), lastHumanReplyAt: t('09:12') });
    expect(w).toMatchObject({ state: 'respondido', closedBy: 'mensagem' });
  });

  it('nova mensagem do lead depois da resposta volta para a fila, desde a mensagem', () => {
    const w = humanWait({ lead: encaminhado(t('09:00')), lastInboundAt: t('09:30'), lastHumanReplyAt: t('09:12') });
    expect(w).toMatchObject({ state: 'esperando', reason: 'nova_mensagem' });
    expect(w.since).toEqual(t('09:30'));
  });

  it('novo encaminhamento depois de uma resposta anterior: resposta de ontem não encerra', () => {
    const lead = encaminhado(amanha('10:00'));
    const w = humanWait({ lead, lastInboundAt: amanha('09:59'), lastHumanReplyAt: t('09:12') });
    expect(w).toMatchObject({ state: 'esperando', reason: 'handoff' });
    expect(w.since).toEqual(amanha('10:00'));
  });
});

describe('"Marcar como respondido" (resposta pelo celular)', () => {
  it('marcação do encaminhamento atual encerra a espera', () => {
    const w = humanWait({
      lead: encaminhado(t('09:00')), lastInboundAt: t('08:58'),
      lastReplyMark: { at: t('09:20'), handoffAt: t('09:00') },
    });
    expect(w).toMatchObject({ state: 'respondido', closedBy: 'marcacao' });
  });

  it('marcação de um encaminhamento anterior não vale para o novo', () => {
    const w = humanWait({
      lead: encaminhado(amanha('10:00')), lastInboundAt: amanha('09:59'),
      lastReplyMark: { at: amanha('10:05'), handoffAt: t('09:00') },
    });
    expect(w).toMatchObject({ state: 'esperando', reason: 'handoff' });
  });

  it('marcação sem encaminhamento registrado não encerra um encaminhamento atual', () => {
    const w = humanWait({
      lead: encaminhado(t('09:00')), lastInboundAt: t('08:58'),
      lastReplyMark: { at: t('09:20'), handoffAt: null },
    });
    expect(w.state).toBe('esperando');
  });
});

describe('responsável pelo lead', () => {
  it('atendente que pausou a Amanda aparece pelo id', () => {
    const lead = encaminhado(t('09:00'));
    lead.manualControl = { active: true, takenOverAt: t('09:03'), takenOverBy: ANA };
    expect(leadAssignee(lead)).toEqual({ kind: 'atendente', id: ANA });
  });

  it('pausa pelo token da Agenda Externa (sem usuário): responsável não identificado', () => {
    const lead = encaminhado(t('09:00'));
    lead.manualControl = { active: true, takenOverAt: t('09:03'), takenOverBy: null };
    expect(leadAssignee(lead)).toEqual({ kind: 'nao_identificado' });
    // e o lead continua esperando, porque pausar não é responder
    expect(humanWait({ lead, lastInboundAt: t('08:58') }).state).toBe('esperando');
  });

  it('pausa manual sem encaminhamento e sem usuário: não identificado', () => {
    const lead = { currentState: 'GREETING', manualControl: { active: true, takenOverAt: t('09:03'), takenOverBy: null } };
    expect(leadAssignee(lead)).toEqual({ kind: 'nao_identificado' });
  });
});

describe('leads com a Amanda', () => {
  it('Amanda ativa e sem encaminhamento: fica só na contagem separada', () => {
    const lead = { currentState: 'GREETING', autoReplyEnabled: true, manualControl: { active: false } };
    expect(humanWait({ lead, lastInboundAt: t('09:00') }).state).toBe('com_amanda');
  });

  it('"Retomar Amanda" encerra o encaminhamento (estado volta a GREETING)', () => {
    const lead = { ...encaminhado(t('09:00')), currentState: 'GREETING', manualControl: { active: false } };
    expect(currentHandoffAt(lead)).toBeNull();
    expect(humanWait({ lead, lastInboundAt: t('09:30') }).state).toBe('com_amanda');
  });

  it('Amanda desligada para o lead sem encaminhamento: espera desde a última mensagem dele', () => {
    const lead = { currentState: 'GREETING', autoReplyEnabled: false, manualControl: { active: false } };
    const w = humanWait({ lead, lastInboundAt: t('09:00') });
    expect(w).toMatchObject({ state: 'esperando', reason: 'nova_mensagem' });
  });
});

describe('teste de aceite do analista (Ana)', () => {
  it('encaminha, Ana pausa, 10 min com Ana; resposta aceita sai; encaminhamento no dia seguinte reinicia com "ninguém assumiu"', () => {
    const lead = encaminhado(t('09:00'));
    lead.manualControl = { active: true, takenOverAt: t('09:02'), takenOverBy: ANA };
    let w = humanWait({ lead, lastInboundAt: t('08:58') });
    expect(w.state).toBe('esperando');
    expect(new Date('2026-11-20T09:10:00-03:00') - w.since).toBe(10 * 60_000);
    expect(leadAssignee(lead)).toEqual({ kind: 'atendente', id: ANA });

    w = humanWait({ lead, lastInboundAt: t('08:58'), lastHumanReplyAt: t('09:11') });
    expect(w.state).toBe('respondido');

    const novo = encaminhado(amanha('10:00'));
    w = humanWait({ lead: novo, lastInboundAt: amanha('09:59'), lastHumanReplyAt: t('09:11') });
    expect(w).toMatchObject({ state: 'esperando', reason: 'handoff' });
    expect(leadAssignee(novo)).toEqual({ kind: 'ninguem' });
  });
});

describe('waitKeyOf: referência da espera vista na tela', () => {
  it('muda com novo encaminhamento e com nova mensagem; some quando respondido', () => {
    const a = humanWait({ lead: encaminhado(t('09:00')), lastInboundAt: t('08:58') });
    const b = humanWait({ lead: encaminhado(t('10:00')), lastInboundAt: t('08:58') });
    const nova = humanWait({ lead: encaminhado(t('09:00')), lastInboundAt: t('09:30'), lastHumanReplyAt: t('09:12') });
    const resp = humanWait({ lead: encaminhado(t('09:00')), lastInboundAt: t('08:58'), lastHumanReplyAt: t('09:12') });
    expect(waitKeyOf(a)).not.toBe(waitKeyOf(b));
    expect(waitKeyOf(nova)).toMatch(/^nova_mensagem\|/);
    expect(waitKeyOf(resp)).toBeNull();
  });
});
