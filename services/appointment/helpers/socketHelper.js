// back/services/appointment/helpers/socketHelper.js
/**
 * Socket Helper
 *
 * Responsabilidade única: emitir eventos socket.io de forma segura (nunca quebra o fluxo).
 */

import { getIo } from '../../../config/socket.js';

/**
 * Emite um evento via socket.io.
 *
 * @param {string} event - Nome do evento
 * @param {Object} payload - Payload do evento
 */
export async function emitSocket(event, payload) {
  try {
    const io = getIo();
    io.emit(event, payload);
    console.log(`📡 Socket emitido: ${event} ${payload?._id || ''}`);
  } catch (socketError) {
    console.error('⚠️ Erro ao emitir socket:', socketError.message);
  }
}

export default { emitSocket };
