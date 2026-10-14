/**
 * Parabéns de aniversário (cron 10h + botão do dashboard).
 * Tudo mockado: nenhuma mensagem real é enviada e nenhum banco é tocado.
 */
import moment from 'moment-timezone';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mockFindById, mockUpdateOne, mockFind, mockQueueAdd } = vi.hoisted(() => ({
  mockFindById: vi.fn(),
  mockUpdateOne: vi.fn(),
  mockFind: vi.fn(),
  mockQueueAdd: vi.fn(),
}));

vi.mock('../../models/Patient.js', () => ({
  default: { findById: mockFindById, updateOne: mockUpdateOne, find: mockFind },
}));
vi.mock('../../config/bullConfig.js', () => ({ whatsappSendQueue: { add: mockQueueAdd } }));

import { runBirthdayMessages } from '../../crons/birthdayMessage.cron.js';
import {
  buildBirthdayMessage,
  findBirthdayPatientsToSend,
  isBirthdayToday,
  sendBirthdayMessage,
  summarizeBirthdays,
} from '../../services/birthday/birthdayMessageService.js';

// 10h em Brasília de 22/09/2026
const NOW = moment.tz('2026-09-22T10:00:00', 'America/Sao_Paulo');
const MARIA = { _id: 'maria', fullName: 'Maria Luiza Silva', dateOfBirth: new Date('2023-09-22T00:00:00.000Z'), phone: '(62) 99124-2993' };

const chain = (value) => ({ select: () => ({ lean: async () => value }) });

beforeEach(() => {
  vi.clearAllMocks();
  mockFindById.mockReturnValue(chain({ ...MARIA }));
  mockUpdateOne.mockResolvedValue({ modifiedCount: 1 });
  mockQueueAdd.mockResolvedValue({ id: 'job-1' });
});

describe('isBirthdayToday', () => {
  it('lê o dia em UTC — meia-noite UTC de hoje é hoje, não ontem (Brasília é UTC-3)', () => {
    expect(isBirthdayToday('2023-09-22T00:00:00.000Z', NOW)).toBe(true);
  });

  it('outro dia ou outro mês não é hoje', () => {
    expect(isBirthdayToday('2023-09-21T00:00:00.000Z', NOW)).toBe(false);
    expect(isBirthdayToday('2023-10-22T00:00:00.000Z', NOW)).toBe(false);
    expect(isBirthdayToday(null, NOW)).toBe(false);
  });

  it('quem nasceu em 29/02 é parabenizado em 28/02 nos anos não bissextos, e só em 29/02 nos bissextos', () => {
    const leapDay = '2020-02-29T00:00:00.000Z';
    expect(isBirthdayToday(leapDay, moment.tz('2026-02-28T10:00:00', 'America/Sao_Paulo'))).toBe(true);
    expect(isBirthdayToday(leapDay, moment.tz('2028-02-28T10:00:00', 'America/Sao_Paulo'))).toBe(false);
    expect(isBirthdayToday(leapDay, moment.tz('2028-02-29T10:00:00', 'America/Sao_Paulo'))).toBe(true);
  });
});

describe('sendBirthdayMessage', () => {
  it('enfileira no WhatsApp com o número normalizado, o primeiro nome e jobId determinístico', async () => {
    const result = await sendBirthdayMessage('maria', { now: NOW });

    expect(result).toEqual({ sent: true, jobId: 'job-1' });
    const [name, payload, opts] = mockQueueAdd.mock.calls[0];
    expect(name).toBe('send-message');
    expect(payload.phone).toBe('5562991242993');
    expect(payload.message).toContain('*Maria*');
    expect(opts.jobId).toBe('birthday-maria-2026');
  });

  it('grava a trava do ano ANTES de enfileirar', async () => {
    const order = [];
    mockUpdateOne.mockImplementationOnce(async () => { order.push('claim'); return { modifiedCount: 1 }; });
    mockQueueAdd.mockImplementationOnce(async () => { order.push('enqueue'); return { id: 'j' }; });

    await sendBirthdayMessage('maria', { now: NOW });

    expect(order).toEqual(['claim', 'enqueue']);
    expect(mockUpdateOne.mock.calls[0][1].$set.birthdayMessageSentYear).toBe(2026);
  });

  it('não envia fora do dia do aniversário', async () => {
    mockFindById.mockReturnValue(chain({ ...MARIA, dateOfBirth: new Date('2023-09-01T00:00:00.000Z') }));

    expect(await sendBirthdayMessage('maria', { now: NOW })).toEqual({ sent: false, reason: 'not_birthday_today' });
    expect(mockUpdateOne).not.toHaveBeenCalled();
    expect(mockQueueAdd).not.toHaveBeenCalled();
  });

  it('não reenvia quando o ano já está marcado', async () => {
    mockFindById.mockReturnValue(chain({ ...MARIA, birthdayMessageSentYear: 2026 }));

    expect(await sendBirthdayMessage('maria', { now: NOW })).toEqual({ sent: false, reason: 'already_sent' });
    expect(mockQueueAdd).not.toHaveBeenCalled();
  });

  it('corrida: se outro processo ganhou a trava (modifiedCount 0), não enfileira', async () => {
    mockUpdateOne.mockResolvedValueOnce({ modifiedCount: 0 });

    expect(await sendBirthdayMessage('maria', { now: NOW })).toEqual({ sent: false, reason: 'already_sent' });
    expect(mockQueueAdd).not.toHaveBeenCalled();
  });

  it('telefone inválido ou vazio: não trava o ano e não enfileira', async () => {
    mockFindById.mockReturnValue(chain({ ...MARIA, phone: '' }));

    expect(await sendBirthdayMessage('maria', { now: NOW })).toEqual({ sent: false, reason: 'invalid_phone' });
    expect(mockUpdateOne).not.toHaveBeenCalled();
  });

  it('paciente inexistente', async () => {
    mockFindById.mockReturnValue(chain(null));
    expect(await sendBirthdayMessage('x', { now: NOW })).toEqual({ sent: false, reason: 'not_found' });
  });

  it('falha ao enfileirar devolve a trava e propaga o erro (permite tentar de novo)', async () => {
    mockQueueAdd.mockRejectedValueOnce(new Error('redis fora'));

    await expect(sendBirthdayMessage('maria', { now: NOW })).rejects.toThrow('redis fora');
    expect(mockUpdateOne).toHaveBeenCalledTimes(2);
    expect(mockUpdateOne.mock.calls[1][1].$set).toEqual({ birthdayMessageSentYear: null, birthdayMessageSentAt: null });
  });

  it('delayMs vira o delay do job', async () => {
    await sendBirthdayMessage('maria', { now: NOW, delayMs: 45000 });
    expect(mockQueueAdd.mock.calls[0][2].delay).toBe(45000);
  });
});

describe('findBirthdayPatientsToSend', () => {
  it('só pacientes ativos com telefone, ainda não enviados neste ano, que fazem aniversário hoje', async () => {
    const pedro = { _id: 'pedro', fullName: 'Pedro', dateOfBirth: new Date('2017-09-01T00:00:00.000Z'), phone: '62999990000' };
    mockFind.mockReturnValue(chain([MARIA, pedro]));

    const found = await findBirthdayPatientsToSend(NOW);

    expect(found.map((p) => p._id)).toEqual(['maria']);
    expect(mockFind.mock.calls[0][0]).toMatchObject({ status: { $in: ['active', null] }, birthdayMessageSentYear: { $ne: 2026 } });
  });
});

describe('runBirthdayMessages (cron 10h)', () => {
  it('sem aniversariantes não faz nada', async () => {
    mockFind.mockReturnValue(chain([]));
    expect(await runBirthdayMessages(NOW)).toEqual({ found: 0, sent: 0, skipped: 0, failed: 0 });
  });

  it('espaça as mensagens (delay crescente) e conta enviados', async () => {
    const outra = { ...MARIA, _id: 'alice', fullName: 'Alice Coutinho' };
    mockFind.mockReturnValue(chain([MARIA, outra]));
    mockFindById.mockImplementation((id) => chain(id === 'alice' ? outra : { ...MARIA }));

    const r = await runBirthdayMessages(NOW);

    expect(r).toEqual({ found: 2, sent: 2, skipped: 0, failed: 0 });
    const d0 = mockQueueAdd.mock.calls[0][2].delay ?? 0;
    const d1 = mockQueueAdd.mock.calls[1][2].delay;
    expect(d1).toBeGreaterThan(d0);
  });

  it('um paciente com erro não derruba os outros', async () => {
    const outra = { ...MARIA, _id: 'alice', fullName: 'Alice Coutinho' };
    mockFind.mockReturnValue(chain([MARIA, outra]));
    mockFindById.mockImplementation((id) => chain(id === 'alice' ? outra : { ...MARIA }));
    mockQueueAdd.mockRejectedValueOnce(new Error('boom')).mockResolvedValue({ id: 'j2' });

    const r = await runBirthdayMessages(NOW);

    expect(r).toMatchObject({ found: 2, sent: 1, failed: 1 });
  });
});

describe('buildBirthdayMessage', () => {
  it('usa só o primeiro nome e funciona sem nome', () => {
    expect(buildBirthdayMessage('Rebeca Santos de Souza')).toContain('*Rebeca*');
    expect(buildBirthdayMessage('')).toContain('um aniversário muito especial');
  });
});

describe('summarizeBirthdays (contagem que o dashboard exibe)', () => {
  const hoje = (id, extra = {}) => ({ _id: id, fullName: id, dateOfBirth: new Date('2023-09-22T00:00:00.000Z'), phone: '62991242993', status: 'active', ...extra });

  it('3 aniversariantes hoje, nenhum enviado: pendentes = 3', () => {
    const { meta } = summarizeBirthdays([hoje('a'), hoje('b'), hoje('c')], NOW);
    expect(meta).toEqual({ todayTotal: 3, todayPending: 3 });
  });

  it('enviou 1 manualmente: sobram 2, e o enviado vem marcado', () => {
    const { list, meta } = summarizeBirthdays([hoje('a', { birthdayMessageSentYear: 2026 }), hoje('b'), hoje('c')], NOW);
    expect(meta).toEqual({ todayTotal: 3, todayPending: 2 });
    expect(list.map((p) => p.birthdayMessageSent)).toEqual([true, false, false]);
  });

  it('enviou os 3: pendentes = 0 (o aviso some)', () => {
    const sent = { birthdayMessageSentYear: 2026 };
    const { meta } = summarizeBirthdays([hoje('a', sent), hoje('b', sent), hoje('c', sent)], NOW);
    expect(meta).toEqual({ todayTotal: 3, todayPending: 0 });
  });

  it('envio de ANO passado não conta como enviado', () => {
    const { meta } = summarizeBirthdays([hoje('a', { birthdayMessageSentYear: 2025 })], NOW);
    expect(meta.todayPending).toBe(1);
  });

  it('sem telefone válido ou inativo não ficam pendentes (não há o que enviar), mas contam no total', () => {
    const { meta } = summarizeBirthdays([hoje('a', { phone: '' }), hoje('b', { status: 'inactive' }), hoje('c')], NOW);
    expect(meta).toEqual({ todayTotal: 3, todayPending: 1 });
  });

  it('cadastro antigo SEM o campo status conta como ativo (caso real: Alice e Liz em 14/10/2026)', () => {
    const { meta } = summarizeBirthdays([hoje('a', { status: undefined }), hoje('b', { status: undefined }), hoje('c')], NOW);
    expect(meta).toEqual({ todayTotal: 3, todayPending: 3 });
  });

  it('lead não recebe parabéns', () => {
    const { meta } = summarizeBirthdays([hoje('a', { status: 'lead' })], NOW);
    expect(meta).toEqual({ todayTotal: 1, todayPending: 0 });
  });

  it('quem faz aniversário em outro dia do mês não entra na contagem de hoje', () => {
    const { meta } = summarizeBirthdays([hoje('a'), hoje('x', { dateOfBirth: new Date('2017-09-01T00:00:00.000Z') })], NOW);
    expect(meta).toEqual({ todayTotal: 1, todayPending: 1 });
  });
});
