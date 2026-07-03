// services/guideLifecycle/GuideLifecycleService.js
import { StrategyFactory } from './StrategyFactory.js';
import Convenio from '../../models/Convenio.js';

/**
 * Serviço central de ciclo de vida de guias de convênio.
 *
 * Responsabilidade única: avaliar uma guia e retornar seu estado,
 * elegibilidade e alertas, de acordo com a política do convênio.
 */
export class GuideLifecycleService {
  /**
   * Avalia uma guia buscando a política do convênio automaticamente.
   */
  static async evaluate(guide, today = new Date()) {
    const insurance = guide?.insurance;

    if (!insurance) {
      return this.buildResult(guide, {
        expired: false,
        nearExpiration: false,
        mustRenew: false,
        alerts: []
      }, today);
    }

    const policy = await this.getPolicyByInsurance(insurance);
    return this.evaluateWithPolicy(guide, policy, today);
  }

  /**
   * Avalia uma guia com uma política já conhecida.
   * Útil para testes e cenários em que a política já foi carregada.
   */
  static evaluateWithPolicy(guide, policy, today = new Date()) {
    const strategy = StrategyFactory.create(policy);
    const strategyResult = strategy.evaluate(guide, today);

    return this.buildResult(guide, strategyResult, today);
  }

  /**
   * Busca a política do convênio pelo código.
   */
  static async getPolicyByInsurance(insurance) {
    try {
      const convenio = await Convenio.findOne({ code: insurance.toLowerCase().trim() }).lean();
      return convenio?.guidePolicy ?? null;
    } catch (err) {
      console.error(`[GuideLifecycleService] Erro ao buscar política do convênio ${insurance}:`, err);
      return null;
    }
  }

  /**
   * Monta o resultado final padronizado.
   */
  static buildResult(guide, strategyResult, today) {
    const status = guide?.status;
    const isSuperseded = status === 'superseded';
    const isCancelled = status === 'cancelled';
    const isExhausted = status === 'exhausted';
    const isActive = status === 'active';
    // 'linked' = guia já convertida/vinculada a um pacote, mas ainda operável.
    // Todo o resto do domínio (InsuranceGuide.findValid, ConvenioMetricsService,
    // autoLinkOrphanSessions) já consulta status: { $in: ['active', 'linked'] } —
    // sem isso aqui, canOperate rejeitava silenciosamente toda guia 'linked'.
    const isOperableStatus = isActive || status === 'linked';

    const expired = strategyResult.expired || isExhausted;

    // Status terminais não precisam de alertas de expiração — o próprio status já comunica o estado.
    const isTerminalStatus = isCancelled || status === 'expired' || isSuperseded;
    const EXPIRATION_ALERTS = ['EXPIRED', 'EXPIRING_SOON'];
    const alerts = isTerminalStatus
      ? strategyResult.alerts.filter(a => !EXPIRATION_ALERTS.includes(a.code))
      : strategyResult.alerts;

    const hasBlockingAlert = alerts.some(a => a.severity === 'error');

    const canOperate = isOperableStatus && !isSuperseded && !isCancelled;

    return {
      state: {
        status: status || 'active'
      },
      eligibility: {
        canSchedule: canOperate && !hasBlockingAlert,
        canBill: canOperate && !hasBlockingAlert,
        canRenew: canOperate && !isSuperseded && (expired || strategyResult.nearExpiration || isExhausted),
        canEdit: canOperate && !isSuperseded,
        canBeSuperseded: canOperate && !isSuperseded && !expired
      },
      alerts
    };
  }
}
