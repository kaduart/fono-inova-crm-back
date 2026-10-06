#!/usr/bin/env node
/**
 * Codemod: migra respostas de erro montadas à mão para o envelope padrão (errors/).
 *
 *   res.status(409).json({ success: false, errorCode: 'X', message: 'texto', correlationId })
 *     →
 *   sendApiError(res, new AppError('X', 'texto', { status: 409, extra: { correlationId } }), req)
 *
 * Só transforma o padrão que reconhece COM CERTEZA; todo o resto vira "manual" no relatório.
 * Não usa AST (não há parser no projeto): um leitor próprio entende strings, templates, comentários
 * e chaves aninhadas, e recorta o texto original das expressões — nunca as reescreve.
 *
 * Regras:
 *  - exige `success: false` e status literal 4xx/5xx;
 *  - `message` vira a mensagem; se só houver `error`, ele vira a mensagem; se houver os dois e
 *    diferirem, `error` vai em `legacyError` (consumidores antigos que leem `error` não quebram);
 *  - `code`/`errorCode` vira o código (sem código: BAD_REQUEST, NOT_FOUND… ou INTERNAL_ERROR);
 *  - `details` vira `details`; QUALQUER outra chave de topo vai em `extra` (ex.: conflict, suggestion);
 *  - bloco de catch `res.status(500).json({ success:false, error: err.message })` vira
 *    `sendApiError(res, err, req)` — o erro real preserva `code`/`status` (violação de regra deixa de ser 500);
 *  - objeto com spread, método ou chave computada → manual.
 *
 * Uso:
 *   node scripts/codemods/migrate-api-errors.mjs <arquivo...>           (simulação: relatório, não grava)
 *   node scripts/codemods/migrate-api-errors.mjs --apply <arquivo...>   (grava)
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const RESERVED = new Set(['success', 'code', 'errorCode', 'message', 'error', 'details']);
const DEFAULT_CODE = { 400: 'BAD_REQUEST', 401: 'UNAUTHORIZED', 403: 'FORBIDDEN', 404: 'NOT_FOUND', 409: 'CONFLICT', 422: 'UNPROCESSABLE' };

// ── leitor de texto ──────────────────────────────────────────────────────────
function skipString(src, i) {
  const quote = src[i];
  if (quote === '`') {
    i++;
    while (i < src.length) {
      if (src[i] === '\\') { i += 2; continue; }
      if (src[i] === '`') return i + 1;
      if (src[i] === '$' && src[i + 1] === '{') {
        i = findClosing(src, i + 1, '{', '}') + 1;
        continue;
      }
      i++;
    }
    return i;
  }
  i++;
  while (i < src.length) {
    if (src[i] === '\\') { i += 2; continue; }
    if (src[i] === quote) return i + 1;
    i++;
  }
  return i;
}

function skipComment(src, i) {
  if (src[i] === '/' && src[i + 1] === '/') {
    const nl = src.indexOf('\n', i);
    return nl === -1 ? src.length : nl;
  }
  if (src[i] === '/' && src[i + 1] === '*') {
    const end = src.indexOf('*/', i + 2);
    return end === -1 ? src.length : end + 2;
  }
  return -1;
}

/** Índice do fechamento que casa com o `open` em `i`. */
function findClosing(src, i, open, close) {
  let depth = 0;
  while (i < src.length) {
    const c = src[i];
    if (c === '"' || c === "'" || c === '`') { i = skipString(src, i); continue; }
    const skip = skipComment(src, i);
    if (skip !== -1) { i = skip; continue; }
    if (c === open) depth++;
    else if (c === close) { depth--; if (depth === 0) return i; }
    i++;
  }
  return -1;
}

/** Divide o miolo de um objeto em propriedades de topo (vírgulas em profundidade 0). */
function splitTopLevel(body) {
  const parts = [];
  let depth = 0;
  let start = 0;
  let i = 0;
  while (i < body.length) {
    const c = body[i];
    if (c === '"' || c === "'" || c === '`') { i = skipString(body, i); continue; }
    const skip = skipComment(body, i);
    if (skip !== -1) { i = skip; continue; }
    if (c === '(' || c === '[' || c === '{') depth++;
    else if (c === ')' || c === ']' || c === '}') depth--;
    else if (c === ',' && depth === 0) { parts.push(body.slice(start, i)); start = i + 1; }
    i++;
  }
  parts.push(body.slice(start));
  return parts.map((p) => stripComments(p).trim()).filter(Boolean);
}

function stripComments(text) {
  let out = '';
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    if (c === '"' || c === "'" || c === '`') { const end = skipString(text, i); out += text.slice(i, end); i = end; continue; }
    const skip = skipComment(text, i);
    if (skip !== -1) { i = skip; continue; }
    out += c; i++;
  }
  return out;
}

/** "chave: valor" | "chave" (shorthand). Devolve null se não for simples (spread, método, computada). */
function parseProp(text) {
  if (text.startsWith('...')) return null;
  const m = text.match(/^(?:([A-Za-z_$][\w$]*)|'([^']+)'|"([^"]+)")\s*:\s*([\s\S]+)$/);
  if (m) return { key: m[1] || m[2] || m[3], value: m[4].trim() };
  if (/^[A-Za-z_$][\w$]*$/.test(text)) return { key: text, value: text };
  return null;
}

const isStringLiteral = (v) => /^(?:'(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*")$/.test(v);

// ── transformação ────────────────────────────────────────────────────────────
function nearestReqName(src, index) {
  const before = src.slice(0, index);
  const re = /\(\s*([A-Za-z_$][\w$]*)\s*,\s*res\b/g;
  let name = 'req';
  let m;
  while ((m = re.exec(before)) !== null) name = m[1];
  return name;
}

function relImport(filePath, target) {
  const from = path.dirname(filePath);
  let rel = path.relative(from, target).split(path.sep).join('/');
  if (!rel.startsWith('.')) rel = `./${rel}`;
  return rel;
}

/**
 * @returns {{ source:string, converted:number, manual:Array<{line:number,reason:string}>, changed:boolean }}
 */
export function transformSource(source, { filePath = 'file.js', backRoot = process.cwd() } = {}) {
  const re = /res\.status\(\s*(\d{3})\s*\)\s*\.json\(\s*\{/g;
  const edits = [];
  const manual = [];
  let m;

  while ((m = re.exec(source)) !== null) {
    const status = Number(m[1]);
    if (status < 400) continue;
    const callStart = m.index;
    const line = source.slice(0, callStart).split('\n').length;
    const braceOpen = callStart + m[0].length - 1;
    const braceClose = findClosing(source, braceOpen, '{', '}');
    if (braceClose === -1) { manual.push({ line, reason: 'objeto não fechado' }); continue; }
    let after = braceClose + 1;
    while (/\s/.test(source[after])) after++;
    if (source[after] !== ')') { manual.push({ line, reason: 'chamada fora do padrão' }); continue; }
    const callEnd = after + 1;

    const parts = splitTopLevel(source.slice(braceOpen + 1, braceClose));
    const props = new Map();
    let bad = null;
    for (const part of parts) {
      const prop = parseProp(part);
      if (!prop) { bad = `propriedade complexa: ${part.slice(0, 40)}`; break; }
      props.set(prop.key, prop.value);
    }
    if (bad) { manual.push({ line, reason: bad }); continue; }
    const successExpr = props.get('success');
    if (successExpr !== undefined && successExpr !== 'false') { manual.push({ line, reason: 'success diferente de false' }); continue; }

    const reqName = nearestReqName(source, callStart);
    const messageExpr = props.get('message');
    const errorExpr = props.get('error');
    const codeExpr = props.get('code') ?? props.get('errorCode');
    const indent = (source.slice(source.lastIndexOf('\n', callStart) + 1, callStart).match(/^\s*/) || [''])[0];

    // catch: res.status(500).json({ success:false, error: err.message }) → sendApiError(res, err, req)
    const caught = (errorExpr ?? messageExpr)?.match(/^([A-Za-z_$][\w$]*)\.message$/);
    const onlySimple = [...props.keys()].every((k) => ['success', 'error', 'message', 'code', 'errorCode'].includes(k));
    if (status >= 500 && caught && onlySimple && !(props.has('code') || props.has('errorCode'))) {
      edits.push({ start: callStart, end: callEnd, text: `sendApiError(res, ${caught[1]}, ${reqName})` });
      continue;
    }

    const message = messageExpr ?? errorExpr ?? "'Erro'";
    const code = codeExpr ?? `'${DEFAULT_CODE[status] || 'INTERNAL_ERROR'}'`;
    const opts = [`status: ${status}`];
    if (messageExpr !== undefined && errorExpr !== undefined && messageExpr !== errorExpr) opts.push(`legacyError: ${errorExpr}`);
    if (props.has('details')) opts.push(`details: ${props.get('details')}`);
    const extras = [...props.entries()].filter(([k]) => !RESERVED.has(k));
    if (extras.length) {
      const body = extras.map(([k, v]) => (k === v ? k : `${/^[A-Za-z_$][\w$]*$/.test(k) ? k : `'${k}'`}: ${v}`)).join(', ');
      opts.push(`extra: { ${body} }`);
    }
    const optsText = opts.join(', ');
    const one = `sendApiError(res, new AppError(${code}, ${message}, { ${optsText} }), ${reqName})`;
    const text = one.length + indent.length <= 110
      ? one
      : `sendApiError(\n${indent}  res,\n${indent}  new AppError(${code}, ${message}, {\n${opts.map((o) => `${indent}    ${o},`).join('\n')}\n${indent}  }),\n${indent}  ${reqName}\n${indent})`;
    edits.push({ start: callStart, end: callEnd, text });
  }

  if (!edits.length) return { source, converted: 0, manual, changed: false };

  let out = source;
  for (const e of edits.sort((a, b) => b.start - a.start)) out = out.slice(0, e.start) + e.text + out.slice(e.end);

  const needsAppError = edits.some((e) => e.text.includes('new AppError('));
  const imports = [];
  if (!/\bsendApiError\b[^;]*from/.test(out.split('\n').filter((l) => l.startsWith('import')).join('\n')) && !/import\s*\{[^}]*\bsendApiError\b[^}]*\}\s*from/.test(out)) {
    imports.push(`import { sendApiError } from '${relImport(filePath, path.join(backRoot, 'errors/buildErrorResponse.js'))}';`);
  }
  if (needsAppError && !/import\s*\{[^}]*\bAppError\b[^}]*\}\s*from/.test(out)) {
    imports.push(`import { AppError } from '${relImport(filePath, path.join(backRoot, 'errors/AppError.js'))}';`);
  }
  if (imports.length) {
    const importRe = /^import\b[^;]*?from\s*['"][^'"]+['"];?[ \t]*$/gm;
    let last = null;
    let im;
    while ((im = importRe.exec(out)) !== null) last = im;
    const at = last ? last.index + last[0].length : 0;
    out = out.slice(0, at) + (last ? '\n' : '') + imports.join('\n') + (last ? '' : '\n') + out.slice(at);
  }
  return { source: out, converted: edits.length, manual, changed: true };
}

// ── CLI ──────────────────────────────────────────────────────────────────────
const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const args = process.argv.slice(2);
  const apply = args.includes('--apply');
  const files = args.filter((a) => !a.startsWith('--'));
  if (!files.length) { console.error('Informe ao menos um arquivo.'); process.exit(1); }
  const backRoot = process.cwd();
  let total = 0;
  for (const file of files) {
    const abs = path.resolve(file);
    const raw = fs.readFileSync(abs, 'utf8');
    const crlf = raw.includes('\r\n');
    const result = transformSource(raw.split('\r\n').join('\n'), { filePath: abs, backRoot });
    total += result.converted;
    console.log(`${file}: ${result.converted} convertido(s), ${result.manual.length} manual(is)`);
    for (const item of result.manual) console.log(`   manual  linha ${item.line}: ${item.reason}`);
    if (apply && result.changed) fs.writeFileSync(abs, crlf ? result.source.split('\n').join('\r\n') : result.source);
  }
  console.log(`\nTotal: ${total} ponto(s) ${apply ? 'convertido(s) e GRAVADO(S)' : 'a converter (simulação — nada gravado)'}.`);
}
