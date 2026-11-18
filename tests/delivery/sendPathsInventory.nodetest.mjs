// Inventário estático dos caminhos que mandam WhatsApp/e-mail para fora.
// Sem banco, sem rede. Falha quando aparece um caminho novo sem classificação,
// ou quando um caminho marcado como protegido deixa de usar o guarda.
//
//   node --test tests/delivery/sendPathsInventory.nodetest.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const SKIP_DIRS = new Set(['node_modules', 'tests', 'scripts', 'docs', '.git', 'coverage', 'dist']);

// Quem importa uma função que fala com o provedor.
const SENDER_IMPORT = /import\s*\{[^}]*\b(sendTextMessage|sendTemplateMessage|sendLocationMessage|sendMediaMessage|sendPasswordResetEmail|sendViaVPS|sendMessage(?:\s+as\s+\w+)?)\b[^}]*\}\s*from\s*['"][^'"]*(whatsappService|whatsappWebJsService|emailService|whatsappVPSService)(\.js)?['"]/s;

// Classificação. guarded = automático e passa por guardedSend (direto ou via helper).
// human/internal = disparo manual ou interno, fora da proteção por decisão documentada.
const INVENTORY = {
  'domains/whatsapp/workers/whatsappSendWorker.js': { kind: 'guarded', via: 'guardedSend' },
  'workers/notificationOrchestratorWorker.js': { kind: 'guarded', via: 'guardedSend' },
  'workers/followupOrchestratorWorker.js': { kind: 'guarded', via: 'guardedSend' },
  'services/leadRecoveryService.js': { kind: 'guarded', via: 'guardedSend' },
  'orchestrators/AmandaOrchestrator.js': { kind: 'guarded', via: 'guardedSend' },
  'services/amandaBookingService.js': { kind: 'guarded', via: 'guardedSend' },
  'workers/entrypoints/whatsapp-child.js': { kind: 'guarded', via: 'deliverWhatsAppWebJob' },
  // Camada de transporte: é o que os caminhos acima chamam.
  'services/whatsappService.js': { kind: 'transport', reason: 'Cloud API + fallback WhatsApp Web; protegido pelo chamador' },
  // Fora da proteção, de propósito:
  'controllers/whatsappController.js': { kind: 'human', reason: 'secretária envia pelo chat; clicar de novo é intenção' },
  'middleware/whatsappGuard.js': { kind: 'internal', reason: 'alerta ao admin; repetição tolerada' },
  'routes/whatsappVPS.js': { kind: 'internal', reason: 'rota administrativa de teste do VPS' },
  'controllers/authController.js': { kind: 'human', reason: 'redefinição de senha pedida pelo usuário; novo link a cada pedido' },
};

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.isDirectory()) { if (!SKIP_DIRS.has(e.name)) walk(path.join(dir, e.name), out); }
    else if (e.name.endsWith('.js')) out.push(path.join(dir, e.name));
  }
  return out;
}

const found = walk(ROOT)
  .filter(f => SENDER_IMPORT.test(fs.readFileSync(f, 'utf8')))
  .map(f => path.relative(ROOT, f).split(path.sep).join('/'))
  .sort();

test('todo arquivo que importa uma função de envio está classificado', () => {
  const unclassified = found.filter(f => !INVENTORY[f]);
  assert.deepEqual(unclassified, [], `classifique em tests/delivery/sendPathsInventory e docs/ENVIOS_ANTI_REENVIO.md: ${unclassified.join(', ')}`);
});

test('caminhos automáticos marcados como protegidos usam o guarda', () => {
  for (const [file, c] of Object.entries(INVENTORY)) {
    if (c.kind !== 'guarded') continue;
    const src = fs.readFileSync(path.join(ROOT, file), 'utf8');
    assert.match(src, new RegExp(`\\b${c.via}\\b`), `${file} deveria usar ${c.via}`);
  }
});

test('o helper do WhatsApp Web usa o guarda com chave pelo jobId', () => {
  const src = fs.readFileSync(path.join(ROOT, 'workers/entrypoints/whatsappWebDelivery.js'), 'utf8');
  assert.match(src, /guardedSend/);
  assert.match(src, /wweb:send:\$\{jobId\}/);
});

test('e-mail automático passa pelo provedor com registro por job', () => {
  const src = fs.readFileSync(path.join(ROOT, 'services/communication/delivery/EmailDeliveryProvider.js'), 'utf8');
  assert.match(src, /idempotency/i);
});

test('inventário não aponta para arquivo que não existe mais', () => {
  for (const file of Object.keys(INVENTORY)) assert.ok(fs.existsSync(path.join(ROOT, file)), file);
});

test('a varredura acha os caminhos conhecidos (teste não é vazio)', () => {
  for (const f of ['workers/entrypoints/whatsapp-child.js', 'services/whatsappService.js', 'controllers/whatsappController.js', 'orchestrators/AmandaOrchestrator.js']) {
    assert.ok(found.includes(f), `varredura não achou ${f}; achou: ${found.join(', ')}`);
  }
});
