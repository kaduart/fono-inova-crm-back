// services/email/providers/BaseEmailProvider.js
/**
 * Interface base para provedores de e-mail.
 * Todos os provedores devem implementar sendEmail.
 */

export class BaseEmailProvider {
  constructor(config = {}) {
    this.config = config;
  }

  /**
   * Envia um e-mail com possíveis anexos.
   * @param {Object} message
   * @param {string} message.to
   * @param {string} message.subject
   * @param {string} message.html
   * @param {string} [message.text]
   * @param {Array<{ url: string, name?: string, publicId?: string }>} [message.attachments]
   * @param {string} [message.customId]
   * @returns {Promise<{ success: boolean, messageId?: string, protocol?: string }>}
   */
  async sendEmail(message) {
    throw new Error('sendEmail deve ser implementado pelo provedor');
  }
}

export default BaseEmailProvider;
