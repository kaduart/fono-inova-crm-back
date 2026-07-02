// services/guideLifecycle/strategies/BaseStrategy.js

/**
 * Interface base para estratégias de ciclo de vida de guia.
 */
export class BaseStrategy {
  constructor(policy) {
    this.policy = policy;
  }

  getExpirationDate(guide, today) {
    return null;
  }

  isExpired(guide, today) {
    return false;
  }

  isNearExpiration(guide, today) {
    return false;
  }

  getAlerts(guide, today) {
    return [];
  }

  mustRenew(guide, today) {
    return false;
  }

  evaluate(guide, today) {
    return {
      expired: this.isExpired(guide, today),
      nearExpiration: this.isNearExpiration(guide, today),
      mustRenew: this.mustRenew(guide, today),
      alerts: this.getAlerts(guide, today)
    };
  }
}
