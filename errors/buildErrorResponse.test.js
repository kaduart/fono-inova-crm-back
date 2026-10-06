import { describe, it, expect, beforeAll } from 'vitest';
import { buildErrorResponse } from './buildErrorResponse.js';
import { AppError } from './AppError.js';
import { registerHumanizer } from './errorCatalog.js';

beforeAll(() => {
  registerHumanizer(
    (code) => code === 'TESTE_DOMINIO',
    async () => ({ message: 'Fulano — sessão de 29/06/2026: já pago.', title: 'Pagamento já baixado', action: 'Avise o financeiro.', items: [{ sessionId: 's1' }] })
  );
  registerHumanizer((code) => code === 'TESTE_QUEBRADO', async () => { throw new Error('tradutor caiu'); });
});

describe('buildErrorResponse', () => {
  it('mantém `error` e `code` (compatibilidade) e acrescenta `message`', async () => {
    const { status, body } = await buildErrorResponse(new AppError('QUALQUER_COISA', 'Falhou', { status: 422 }));
    expect(status).toBe(422);
    expect(body).toMatchObject({ success: false, code: 'QUALQUER_COISA', message: 'Falhou', error: 'Falhou' });
  });

  it('usa o tradutor do domínio e preserva o texto técnico', async () => {
    const err = Object.assign(new Error('Payment 6a3c… está em paid'), { code: 'TESTE_DOMINIO', status: 409 });
    const { status, body } = await buildErrorResponse(err);
    expect(status).toBe(409);
    expect(body.message).toContain('Fulano');
    expect(body.error).toBe(body.message);
    expect(body.title).toBe('Pagamento já baixado');
    expect(body.action).toBe('Avise o financeiro.');
    expect(body.items).toHaveLength(1);
    expect(body.technicalMessage).toBe('Payment 6a3c… está em paid');
  });

  it('tradutor que falha nunca derruba a resposta', async () => {
    const err = Object.assign(new Error('texto original'), { code: 'TESTE_QUEBRADO', status: 409 });
    const { body } = await buildErrorResponse(err);
    expect(body.message).toBe('texto original');
  });

  it('catálogo completa status, título e ação de códigos genéricos', async () => {
    const { status, body } = await buildErrorResponse(Object.assign(new Error('x'), { code: 'FORBIDDEN' }));
    expect(status).toBe(403);
    expect(body.title).toBe('Sem permissão');
    expect(body.message).toContain('Sem permissão');
    expect(body.message).toContain('administrador');
  });

  it('violação de invariante financeira é 409, não 500', async () => {
    const err = Object.assign(new Error('não pode'), { name: 'PaymentInvariantError', code: 'PAYMENT_STATUS_NOT_BILLABLE' });
    expect((await buildErrorResponse(err)).status).toBe(409);
  });

  it('erro de validação do Mongoose lista os campos', async () => {
    const err = Object.assign(new Error('v'), {
      name: 'ValidationError',
      errors: { a: { path: 'nome', message: 'Nome é obrigatório' }, b: { path: 'cpf', message: 'CPF inválido' } },
    });
    const { status, body } = await buildErrorResponse(err);
    expect(status).toBe(400);
    expect(body.code).toBe('VALIDATION_ERROR');
    expect(body.message).toBe('Dados inválidos: Nome é obrigatório; CPF inválido');
    expect(body.errors).toEqual([{ field: 'nome', message: 'Nome é obrigatório' }, { field: 'cpf', message: 'CPF inválido' }]);
  });

  it('chave duplicada do Mongo vira 409 DUPLICATE_KEY', async () => {
    const { status, body } = await buildErrorResponse(Object.assign(new Error('E11000'), { code: 11000 }));
    expect(status).toBe(409);
    expect(body.code).toBe('DUPLICATE_KEY');
  });

  it('erro de sistema (ECONNRESET) vira INTERNAL_ERROR 500 e não passa pelo tradutor', async () => {
    const { status, body } = await buildErrorResponse(Object.assign(new Error('socket'), { code: 'ECONNRESET' }));
    expect(status).toBe(500);
    expect(body.code).toBe('INTERNAL_ERROR');
  });

  it('inclui correlationId quando informado e stack só se pedido', async () => {
    const err = new AppError('X', 'm');
    expect((await buildErrorResponse(err, { correlationId: 'abc' })).body.correlationId).toBe('abc');
    expect((await buildErrorResponse(err)).body.stack).toBeUndefined();
    expect((await buildErrorResponse(err, { includeStack: true })).body.stack).toBeDefined();
  });
});
