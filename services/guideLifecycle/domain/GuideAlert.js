// services/guideLifecycle/domain/GuideAlert.js

/**
 * Objeto de domínio para alertas do ciclo de vida de guias.
 */
export class GuideAlert {
  constructor(code, severity, metadata = {}) {
    this.code = code;
    this.severity = severity;
    this.metadata = metadata;
  }

  toJSON() {
    return {
      code: this.code,
      severity: this.severity,
      metadata: this.metadata
    };
  }

  static expired({ expirationDate } = {}) {
    return new GuideAlert('EXPIRED', 'error', { expirationDate });
  }

  static expiringSoon({ remainingDays, expirationDate } = {}) {
    return new GuideAlert('EXPIRING_SOON', 'warning', { remainingDays, expirationDate });
  }

  static authorizationExpired({ expirationDate } = {}) {
    return new GuideAlert('AUTHORIZATION_EXPIRED', 'error', { expirationDate });
  }

  static authorizationExpiringSoon({ remainingDays, expirationDate } = {}) {
    return new GuideAlert('AUTHORIZATION_EXPIRING_SOON', 'warning', { remainingDays, expirationDate });
  }

  static exhausted({ remainingSessions, totalSessions } = {}) {
    return new GuideAlert('EXHAUSTED', 'error', { remainingSessions, totalSessions });
  }

  static lowSessions({ remainingSessions, totalSessions } = {}) {
    return new GuideAlert('LOW_SESSIONS', 'warning', { remainingSessions, totalSessions });
  }
}
