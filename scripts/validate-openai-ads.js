import dotenv from 'dotenv';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { OPENAI_ADS_PIXEL_ID, buildOpenAIAppointmentEvent } from '../services/openaiAdsConversionsService.js';

// This local diagnostic explicitly validates the file the user just updated,
// rather than an older credential inherited from the terminal environment.
dotenv.config({ path: fileURLToPath(new URL('../.env', import.meta.url)), override: true });
const apiKey = process.env.OPENAI_ADS_CONVERSIONS_API_KEY?.trim();
const pixelId = process.argv[2] || OPENAI_ADS_PIXEL_ID;
if (!/^[A-Za-z0-9]+$/.test(pixelId)) throw new Error('Invalid pixel ID');
if (!apiKey) {
  console.error('Chave de conversões não configurada.');
  process.exitCode = 1;
} else {
  try {
    const response = await fetch(`https://bzr.openai.com/v1/events?pid=${pixelId}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ validate_only: true, events: [buildOpenAIAppointmentEvent({
        appointmentId: `validation-${randomUUID()}`, eventTime: new Date(),
      })] }),
      signal: AbortSignal.timeout(15000),
    });
    // Deliberately omit raw responses and secrets from console output.
    const body = await response.json().catch(() => null);
    const errors = Array.isArray(body?.errors) ? body.errors.length : body?.error ? 1 : 0;
    const detail = JSON.stringify(body?.error || body?.errors || body?.message || '')
      .split(apiKey).join('[REDACTED]')
      .replace(/sk-[A-Za-z0-9_-]+/g, '[REDACTED]')
      .replace(/Bearer\s+[^\s"\\]+/gi, 'Bearer [REDACTED]')
      .slice(0, 500);
    const message = detail.toLowerCase();
    const category = /invalid.*(key|token)|(key|token).*invalid/.test(message) ? 'invalid_credential'
      : /permission|forbidden|access|scope/.test(message) ? 'access_denied'
      : /pixel/.test(message) ? 'pixel_configuration'
      : 'unspecified';
    console.log(JSON.stringify({ mode: 'validate_only', httpStatus: response.status, errors, category, detail }));
    if (!response.ok || errors) process.exitCode = 1;
  } catch {
    console.error('Validação indisponível: erro de rede ou timeout.');
    process.exitCode = 1;
  }
}
