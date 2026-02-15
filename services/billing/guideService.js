// services/billing/guideService.js
import mongoose from 'mongoose';
import InsuranceGuide from '../../models/InsuranceGuide.js';

/**
 * 🏥 Guide Service
 *
 * Gerencia operações de guias de convênio.
 * Wrapper dos métodos do model InsuranceGuide para service layer.
 *
 * @module guideService
 */

class GuideService {

  /**
   * Busca uma guia válida para agendamento
   *
   * @param {Object} params - Parâmetros de busca
   * @param {ObjectId|string} params.patientId - ID do paciente
   * @param {string} params.specialty - Especialidade
   * @param {Date} [params.date=new Date()] - Data do agendamento
   * @returns {Promise<InsuranceGuide>} Guia válida encontrada
   * @throws {Error} PACIENTE_SEM_GUIA_ATIVA
   *
   * @example
   * const guide = await guideService.findValidGuide({
   *   patientId: '507f1f77bcf86cd799439011',
   *   specialty: 'fonoaudiologia',
   *   date: new Date('2025-02-15')
   * });
   */
  async findValidGuide({ patientId, specialty, date = new Date() }) {
    try {
      // Delega para método estático do model
      const guide = await InsuranceGuide.findValid(patientId, specialty, date);

      if (!guide) {
        const error = new Error(
          `Paciente não possui guia ativa para ${specialty}`
        );
        error.code = 'PACIENTE_SEM_GUIA_ATIVA';
        error.details = { patientId, specialty, date };
        throw error;
      }

      return guide;

    } catch (error) {
      // Propagar erro já tratado
      if (error.code === 'PACIENTE_SEM_GUIA_ATIVA') {
        throw error;
      }

      // Encapsular erros inesperados
      throw new Error(`Erro ao buscar guia válida: ${error.message}`);
    }
  }

  /**
   * Consome uma sessão da guia (incrementa contador)
   * ⚠️ Deve ser chamado dentro de uma transação MongoDB
   *
   * @param {ObjectId|string} guideId - ID da guia
   * @param {ClientSession} mongoSession - Sessão MongoDB para transação
   * @returns {Promise<Object>} { remaining, status, used, total }
   * @throws {Error} Se guia não encontrada, esgotada ou inativa
   *
   * @example
   * const session = await mongoose.startSession();
   * session.startTransaction();
   * try {
   *   const result = await guideService.consumeGuideSession(guideId, session);
   *   console.log(`Restam ${result.remaining} sessões`);
   *   await session.commitTransaction();
   * } finally {
   *   session.endSession();
   * }
   */
  async consumeGuideSession(guideId, mongoSession) {
    if (!mongoSession) {
      throw new Error('mongoSession é obrigatório para consumeGuideSession');
    }

    try {
      // Buscar guia dentro da transação
      const guide = await InsuranceGuide.findById(guideId).session(mongoSession);

      if (!guide) {
        const error = new Error('Guia não encontrada');
        error.code = 'GUIDE_NOT_FOUND';
        throw error;
      }

      // Validar e incrementar (método do model)
      await guide.consumeSession(mongoSession);

      // Retornar resumo estruturado
      return {
        remaining: guide.remaining,
        status: guide.status,
        used: guide.usedSessions,
        total: guide.totalSessions
      };

    } catch (error) {
      throw error;
    }
  }

  /**
   * Libera uma sessão da guia (decrementa contador)
   * Usado quando um agendamento é cancelado
   * ⚠️ Deve ser chamado dentro de uma transação MongoDB
   *
   * @param {ObjectId|string} guideId - ID da guia
   * @param {ClientSession} mongoSession - Sessão MongoDB para transação
   * @returns {Promise<InsuranceGuide>} Guia atualizada
   * @throws {Error} Se guia não encontrada
   *
   * @example
   * const session = await mongoose.startSession();
   * session.startTransaction();
   * try {
   *   const guide = await guideService.releaseGuideSession(guideId, session);
   *   console.log(`Sessão liberada. Agora tem ${guide.remaining} disponíveis`);
   *   await session.commitTransaction();
   * } finally {
   *   session.endSession();
   * }
   */
  async releaseGuideSession(guideId, mongoSession) {
    if (!mongoSession) {
      throw new Error('mongoSession é obrigatório para releaseGuideSession');
    }

    try {
      // Buscar guia dentro da transação
      const guide = await InsuranceGuide.findById(guideId).session(mongoSession);

      if (!guide) {
        const error = new Error('Guia não encontrada');
        error.code = 'GUIDE_NOT_FOUND';
        throw error;
      }

      // Decrementar usedSessions (mínimo 0)
      if (guide.usedSessions > 0) {
        guide.usedSessions -= 1;
      }

      // Se estava 'exhausted' e agora tem saldo, reativar
      if (guide.status === 'exhausted' && guide.usedSessions < guide.totalSessions) {
        // Verificar se não expirou antes de reativar
        const now = new Date();
        if (guide.expiresAt >= now) {
          guide.status = 'active';
        }
      }

      // Salvar dentro da transação
      await guide.save({ session: mongoSession });

      return guide;

    } catch (error) {
      throw error;
    }
  }

  /**
   * Retorna saldo agregado de guias ativas do paciente
   *
   * @param {ObjectId|string} patientId - ID do paciente
   * @param {string} [specialty] - Filtrar por especialidade (opcional)
   * @returns {Promise<Object>} { total, used, remaining, guides: [...] }
   *
   * @example
   * // Todas as especialidades
   * const balance = await guideService.getGuideBalance(patientId);
   * // { total: 20, used: 8, remaining: 12, guides: [...] }
   *
   * // Especialidade específica
   * const fonoBalance = await guideService.getGuideBalance(patientId, 'fonoaudiologia');
   */
  async getGuideBalance(patientId, specialty = null) {
    try {
      // Delega para método estático do model
      const balance = await InsuranceGuide.getBalance(patientId, specialty);

      return balance;

    } catch (error) {
      throw new Error(`Erro ao consultar saldo de guias: ${error.message}`);
    }
  }
}

// Exportar instância única (singleton)
export default new GuideService();
