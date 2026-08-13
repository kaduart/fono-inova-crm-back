/**
 * 🧪 Contrato do payload dos eventos de Appointment
 *
 * Origem: incidente de 2026-08-12. O `packageProjectionWorker` reconstrói a
 * PackagesView em APPOINTMENT_CANCELLED/COMPLETED/UPDATED/DELETED, mas só
 * quando o payload traz `packageId`:
 *
 *     case 'APPOINTMENT_CANCELLED':
 *       if (packageId) return await handlePackageBuild(packageId, ...);
 *       return { operation: 'ignored', reason: 'no_package_id' };
 *
 * O emissor de cancelamento não mandava esse campo. Resultado: evento gravado
 * como 'published', sem erro, sem retry, sem DLQ — e a view congelada. 30 de
 * 288 pacotes ficaram divergentes, alguns por meses.
 *
 * Este teste lê o código-fonte dos emissores e falha se algum voltar a montar
 * o payload sem `packageId`. É um teste de contrato estático de propósito:
 * não depende de Mongo, roda em qualquer ambiente e protege exatamente a
 * ligação que quebrou — a que ninguém vê quando olha só o domínio.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const commandsDir = resolve(here, '../../services/appointment/commands');

/** Emissores de evento de appointment consumidos pelo packageProjectionWorker. */
const EMITTERS = [
  { file: 'cancelAppointmentCommand.js', event: 'APPOINTMENT_CANCELLED' },
  { file: 'deleteAppointmentCommand.js', event: 'APPOINTMENT_DELETED' },
  { file: 'updateAppointmentCommand.js', event: 'APPOINTMENT_UPDATED' },
  { file: 'expirePreAgendamentoCommand.js', event: 'APPOINTMENT_UPDATED' },
  { file: 'confirmPreAgendamentoCommand.js', event: 'APPOINTMENT_UPDATED' },
];

/**
 * Remove comentários antes de inspecionar o payload.
 * Sem isso, um comentário que só CITA "packageId" faz o teste passar com o
 * campo ausente — foi exatamente o falso negativo pego ao validar este teste.
 */
function stripComments(code) {
  return code
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/[^\n]*/g, '');
}

/**
 * Extrai o bloco `payload: { ... }` que segue o eventType informado.
 * Contagem de chaves em vez de regex guloso, para não capturar o arquivo todo.
 */
function extractPayloadBlock(source, eventType) {
  const eventIdx = source.indexOf(eventType);
  if (eventIdx === -1) return null;

  const payloadIdx = source.indexOf('payload:', eventIdx);
  if (payloadIdx === -1) return null;

  const start = source.indexOf('{', payloadIdx);
  if (start === -1) return null;

  let depth = 0;
  for (let i = start; i < source.length; i++) {
    if (source[i] === '{') depth++;
    else if (source[i] === '}') {
      depth--;
      if (depth === 0) return source.slice(start, i + 1);
    }
  }
  return null;
}

describe('payload dos eventos de Appointment (contrato com packageProjectionWorker)', () => {
  for (const { file, event } of EMITTERS) {
    it(`${file} inclui packageId no payload de ${event}`, () => {
      const source = stripComments(readFileSync(resolve(commandsDir, file), 'utf8'));
      const payload = extractPayloadBlock(source, event);

      expect(payload, `bloco payload de ${event} não encontrado em ${file}`).toBeTruthy();
      // Exige a CHAVE `packageId:`, não a menção da palavra.
      expect(
        /(^|[\s,{])packageId\s*:/.test(payload),
        `${file} emite ${event} sem a chave packageId — o packageProjectionWorker vai ` +
        `descartar o evento em "ignored / no_package_id" e a PackagesView não será reconstruída.`
      ).toBe(true);
    });
  }

  it('o worker continua exigindo packageId (se mudar, este contrato muda junto)', () => {
    const worker = readFileSync(
      resolve(here, '../../domains/billing/workers/packageProjectionWorker.js'),
      'utf8'
    );
    expect(worker).toContain("reason: 'no_package_id'");
  });
});

describe('cancelSource', () => {
  it("aceita 'converted_to_package' (transferência de sessões entre pacotes)", () => {
    const model = readFileSync(resolve(here, '../../models/Appointment.js'), 'utf8');
    const enumLine = model
      .split('\n')
      .find(line => line.includes("'guide_closure'") && line.includes('enum'));

    expect(enumLine).toBeTruthy();
    expect(enumLine).toContain('converted_to_package');
  });
});
