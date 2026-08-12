/**
 * Fonte única da versão do Chrome usada pelo WhatsApp Web.
 *
 * Importado por installChrome.js (instala) e whatsappWebJsService.js (resolve o
 * binário). Manter os dois lados no mesmo valor não é detalhe: em 12/08/2026 o
 * build instalou a versão certa em chrome/ mas o runtime pegou outra de
 * .cache/puppeteer/, e o WhatsApp ficou fora do ar mesmo com o pin "aplicado".
 *
 * Chrome quebra o Client.initialize com "Navigating frame was detached" em
 * versões diferentes desta — confirmado em 151.0.7922.138 e 148.0.7778.97.
 * Só troque este valor validando QR + conexão logo depois do deploy.
 */
export const PINNED_CHROME_VERSION = process.env.CHROME_VERSION || '151.0.7922.77';

/** Subpath do binário dentro de cada diretório de instalação. */
export const chromeBinarySubpath = (version = PINNED_CHROME_VERSION) =>
  `linux-${version}/chrome-linux64/chrome`;
