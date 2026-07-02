// services/guideLifecycle/StrategyFactory.js
import { EndOfMonthStrategy } from './strategies/EndOfMonthStrategy.js';
import { UntilConsumedStrategy } from './strategies/UntilConsumedStrategy.js';
import { FixedDateStrategy } from './strategies/FixedDateStrategy.js';
import { AuthorizationValidityStrategy } from './strategies/AuthorizationValidityStrategy.js';

/**
 * Fábrica de estratégias de ciclo de vida de guia.
 *
 * Recebe uma GuidePolicy e retorna a estratégia correspondente.
 * Não contém regra de negócio — apenas roteamento.
 */
export class StrategyFactory {
  static create(policy) {
    const renewalType = policy?.renewalType;

    switch (renewalType) {
      case 'end_of_month':
        return new EndOfMonthStrategy(policy);
      case 'until_consumed':
        return new UntilConsumedStrategy(policy);
      case 'fixed_date':
        return new FixedDateStrategy(policy);
      case 'authorization_validity':
        return new AuthorizationValidityStrategy(policy);
      default:
        return new UntilConsumedStrategy(policy);
    }
  }
}
