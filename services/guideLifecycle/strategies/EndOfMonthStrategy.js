// services/guideLifecycle/strategies/EndOfMonthStrategy.js
import { BaseStrategy } from './BaseStrategy.js';
import {
  startOfDayUTC,
  subDaysUTC,
  isSameDayUTC,
  isAfterDayUTC,
  differenceInDaysUTC
} from '../utils/dateUtils.js';
import { GuideAlert } from '../domain/GuideAlert.js';

export class EndOfMonthStrategy extends BaseStrategy {
  /**
   * A data de expiração da guia é a fonte única de verdade.
   * A política end_of_month afeta o comportamento de renovação,
   * não redefine a data de vencimento da guia.
   */
  getExpirationDate(guide, today) {
    const baseDate = guide.expiresAt ? new Date(guide.expiresAt) : new Date(today);
    return startOfDayUTC(baseDate);
  }

  isExpired(guide, today) {
    const expiration = this.getExpirationDate(guide, today);
    if (!expiration) return false;
    return isAfterDayUTC(today, expiration) || isSameDayUTC(today, expiration);
  }

  isNearExpiration(guide, today) {
    const expiration = this.getExpirationDate(guide, today);
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
      alerts.push(GuideAlert.expired({
        expirationDate: this.getExpirationDate(guide, today).toISOString()
      }));
    } else if (this.isNearExpiration(guide, today)) {
      const expiration = this.getExpirationDate(guide, today);
      const remainingDays = differenceInDaysUTC(expiration, today);

      alerts.push(GuideAlert.expiringSoon({
        remainingDays,
        expirationDate: expiration.toISOString()
      }));
    }

    return alerts;
  }
}
