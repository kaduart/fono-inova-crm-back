// services/guideLifecycle/strategies/AuthorizationValidityStrategy.js
import { BaseStrategy } from './BaseStrategy.js';
import {
  startOfDayUTC,
  subDaysUTC,
  isSameDayUTC,
  isAfterDayUTC,
  differenceInDaysUTC
} from '../utils/dateUtils.js';
import { GuideAlert } from '../domain/GuideAlert.js';

export class AuthorizationValidityStrategy extends BaseStrategy {
  getExpirationDate(guide) {
    return guide.expiresAt ? new Date(guide.expiresAt) : null;
  }

  isExpired(guide, today) {
    const expiration = this.getExpirationDate(guide);
    if (!expiration) return false;
    return isAfterDayUTC(today, expiration) || isSameDayUTC(today, expiration);
  }

  isNearExpiration(guide, today) {
    const expiration = this.getExpirationDate(guide);
    if (!expiration) return false;

    const warningDays = this.policy?.expirationWarningDays ?? 5;
    const warningStart = subDaysUTC(expiration, warningDays);
    const todayStart = startOfDayUTC(today);

    return (
      !this.isExpired(guide, today) &&
      (isAfterDayUTC(todayStart, warningStart) || isSameDayUTC(todayStart, warningStart))
    );
  }

  mustRenew(guide, today) {
    return this.isExpired(guide, today) || this.isNearExpiration(guide, today);
  }

  getAlerts(guide, today) {
    const alerts = [];

    if (this.isExpired(guide, today)) {
      alerts.push(GuideAlert.authorizationExpired({
        expirationDate: this.getExpirationDate(guide).toISOString()
      }));
    } else if (this.isNearExpiration(guide, today)) {
      const expiration = this.getExpirationDate(guide);
      const remainingDays = differenceInDaysUTC(expiration, today);

      alerts.push(GuideAlert.authorizationExpiringSoon({
        remainingDays,
        expirationDate: expiration.toISOString()
      }));
    }

    return alerts;
  }
}
