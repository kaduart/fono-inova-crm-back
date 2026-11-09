/**
 * Fonte única da versão do Chrome usada pelo WhatsApp Web.
 *
 * Importado por installChrome.js (instala) e whatsappWebJsService.js (resolve o
 * binário). Manter os dois lados no mesmo valor não é detalhe: em 12/08/2026 o
 * build instalou a versão certa em chrome/ mas o runtime pegou outra de
 * .cache/puppeteer/, e o WhatsApp ficou fora do ar mesmo com o pin "aplicado".
 *
 * Histórico:
 * - 08/2026: 151.0.7922.138 e 148.0.7778.97 quebravam o Client.initialize com
 *   "Navigating frame was detached"; ficamos em 151.0.7922.77.
 * - 09/11/2026: o WhatsApp Web mudou e o 151.0.7922.77 passou a morrer com
 *   SIGTRAP ~0,2s depois do initialize (log com dumpio, PR #38). Subimos para o
 *   estável 157.0.8103.38 (validado em prod: sessão reaproveitada, sem QR).
 * Só troque este valor validando conexão logo depois do deploy. A env
 * CHROME_VERSION no Render sobrepõe este valor (serve para testar sem deploy).
 */
export const PINNED_CHROME_VERSION = process.env.CHROME_VERSION || '157.0.8103.38';

/** Subpath do binário dentro de cada diretório de instalação. */
export const chromeBinarySubpath = (version = PINNED_CHROME_VERSION) =>
  `linux-${version}/chrome-linux64/chrome`;
