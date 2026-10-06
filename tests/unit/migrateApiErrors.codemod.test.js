import { describe, it, expect } from 'vitest';
import { transformSource } from '../../scripts/codemods/migrate-api-errors.mjs';

const run = (src) => transformSource(src, { filePath: '/back/routes/x.js', backRoot: '/back' });
const wrap = (body) => `import express from 'express';\n\nrouter.post('/', async (req, res) => {\n  try {\n${body}\n  } catch (error) {\n    res.status(500).json({ success: false, error: error.message });\n  }\n});\n`;

describe('migrate-api-errors codemod', () => {
  it('converte errorCode + message + correlationId (extra) e mantém o return', () => {
    const r = run(wrap(`    return res.status(400).json({
      success: false,
      errorCode: 'INVALID_SPECIALTY',
      message: \`Especialidade inválida. Válidas: \${VALID.join(', ')}\`,
      correlationId
    });`));
    expect(r.converted).toBe(2); // o erro + o catch
    expect(r.source).toContain("return sendApiError(");
    expect(r.source).toContain("new AppError('INVALID_SPECIALTY', `Especialidade inválida. Válidas: ${VALID.join(', ')}`");
    expect(r.source).toContain('status: 400');
    expect(r.source).toContain('extra: { correlationId }');
    expect(r.source).toContain('sendApiError(res, error, req)'); // catch 500
  });

  it('só `error` vira mensagem; `error` + `message` diferentes preservam `legacyError`', () => {
    const a = run(`import x from 'y';\nfunction h(req, res) { return res.status(404).json({ success: false, error: 'Paciente não encontrado' }); }`);
    expect(a.source).toContain("new AppError('NOT_FOUND', 'Paciente não encontrado', { status: 404 })");

    const b = run(`import x from 'y';\nfunction h(req, res) { return res.status(409).json({ success: false, error: 'Conflito de agenda médica', message: 'Horário ocupado', conflict: { a: 1, b: [1, 2] }, suggestion: 'Escolha outro' }); }`);
    expect(b.source).toContain("legacyError: 'Conflito de agenda médica'");
    expect(b.source).toContain("'Horário ocupado'");
    expect(b.source).toContain('conflict: { a: 1, b: [1, 2] }');
    expect(b.source).toContain("suggestion: 'Escolha outro'");
  });

  it('vírgulas e chaves dentro de strings/templates não confundem o leitor', () => {
    const r = run(`import x from 'y';\nfunction h(req, res) { return res.status(400).json({ success: false, code: 'X', message: "a, b: {c}", data: { t: \`\${a}, \${ {k: 1}.k }\` } }); }`);
    expect(r.manual).toEqual([]);
    expect(r.source).toContain(`new AppError('X', "a, b: {c}"`);
    expect(r.source).toContain('extra: { data: { t: `${a}, ${ {k: 1}.k }` } }');
  });

  it('adiciona os imports com o caminho relativo certo, uma única vez', () => {
    const r = run(wrap(`    return res.status(400).json({ success: false, error: 'x' });`));
    expect(r.source).toContain("import { sendApiError } from '../errors/buildErrorResponse.js';");
    expect(r.source).toContain("import { AppError } from '../errors/AppError.js';");
    expect(r.source.match(/import \{ sendApiError \}/g)).toHaveLength(1);
    const again = run(r.source);
    expect(again.changed).toBe(false);
  });

  it('usa o nome real do parâmetro de request', () => {
    const r = run(`import x from 'y';\nasync function h(request, res) { return res.status(400).json({ success: false, error: 'x' }); }`);
    expect(r.source).toContain('}), request)');
  });

  it('o que não é seguro vira manual e não é tocado', () => {
    const spread = run(`import x from 'y';\nfunction h(req, res) { return res.status(400).json({ success: false, ...extra }); }`);
    expect(spread.changed).toBe(false);
    expect(spread.manual[0].reason).toMatch(/complexa/);

    const ok = run(`import x from 'y';\nfunction h(req, res) { return res.status(200).json({ success: true }); }`);
    expect(ok.changed).toBe(false);

    const dynamic = run(`import x from 'y';\nfunction h(req, res) { return res.status(code).json({ success: false, error: 'x' }); }`);
    expect(dynamic.changed).toBe(false);
  });

  it('catch com código próprio NÃO vira repasse do erro (mantém o código declarado)', () => {
    const r = run(`import x from 'y';\nfunction h(req, res) { return res.status(500).json({ success: false, code: 'BOOM', error: err.message }); }`);
    expect(r.source).toContain("new AppError('BOOM', err.message");
  });

  it('é idempotente: rodar duas vezes não muda mais nada', () => {
    const once = run(wrap(`    return res.status(409).json({ success: false, error: 'dup', code: 'DUP' });`));
    expect(run(once.source).changed).toBe(false);
  });
});
