// services/guideLifecycle/strategies/UntilConsumedStrategy.js
import { BaseStrategy } from './BaseStrategy.js';
import { GuideAlert } from '../domain/GuideAlert.js';

export class UntilConsumedStrategy extends BaseStrategy {
  getRemainingSessions(guide) {
    const total = guide.totalSessions ?? 0;
    const used = guide.usedSessions ?? 0;
    return Math.max(0, total - used);
  }

  isExpired(guide) {
    return this.getRemainingSessions(guide) === 0;
  }

  isNearExpiration(guide) {
    const remaining = this.getRemainingSessions(guide);
    return remaining > 0 && remaining <= 2;
  }

  mustRenew(guide) {
    return this.isExpired(guide);
  }

  getAlerts(guide) {
    const alerts = [];
    const remaining = this.getRemainingSessions(guide);

    if (remaining === 0) {
      alerts.push(GuideAlert.exhausted({
        remainingSessions: 0,
        totalSessions: guide.totalSessions ?? 0
      }));
    } else if (remaining <= 2) {
      alerts.push(GuideAlert.lowSessions({
        remainingSessions: remaining,
        totalSessions: guide.totalSessions ?? 0
      }));
    }

    return alerts;
  }
}
