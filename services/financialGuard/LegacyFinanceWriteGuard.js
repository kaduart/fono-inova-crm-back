/**
 * 🚨 LegacyFinanceWriteGuard
 *
 * Intercepta writes financeiros V1 (isPaid, paymentStatus) e:
 * 1. Loga com stack trace
 * 2. Em modo STRICT: bloqueia o write
 * 3. Em modo WARN: permite mas loga
 * 4. Redireciona para ledger quando possível
 *
 * Modos:
 * - 'warn' (default): loga warning, permite write
 * - 'strict': loga erro, bloqueia write
 * - 'noop': loga warning, ignora write (transforma em no-op)
 *
 * Uso:
 *   LegacyFinanceWriteGuard.setSessionPaid(session, true, { reason: 'complete' })
 *   LegacyFinanceWriteGuard.setAppointmentStatus(appointment, 'paid', { reason: 'settle' })
 */

const MODE = process.env.LEGACY_GUARD_MODE || 'warn';

class LegacyFinanceWriteGuard {
  static log(action, entity, field, value, meta = {}) {
    const entry = {
      timestamp: new Date().toISOString(),
      action,
      entity: entity?._id?.toString?.() || entity?.id || 'unknown',
      entityType: entity?.constructor?.name || 'Object',
      field,
      value,
      mode: MODE,
      ...meta,
      stack: new Error().stack.split('\n').slice(3, 8).join('\n')
    };

    if (MODE === 'strict') {
      console.error('🚨 [LEGACY GUARD] BLOCKED:', JSON.stringify(entry, null, 2));
      throw new Error(
        `LEGACY_WRITE_BLOCKED: Tentativa de escrever '${field}'=${value} em ${entry.entityType}. ` +
        `Use o ledger (Payment) como fonte de verdade. Contexto: ${meta.reason || 'unknown'}`
      );
    }

    if (MODE === 'noop') {
      console.warn('🚨 [LEGACY GUARD] NOOP:', JSON.stringify(entry, null, 2));
      return false; // indica que o write foi ignorado
    }

    // warn mode
    console.warn('⚠️  [LEGACY GUARD] WARN:', JSON.stringify(entry, null, 2));
    return true; // permite o write
  }

  /**
   * Setter centralizado para session.isPaid
   */
  static setSessionPaid(session, value, meta = {}) {
    const allowed = this.log('SET_SESSION_PAID', session, 'isPaid', value, meta);
    if (allowed && MODE !== 'noop') {
      session.isPaid = value;
    }
    return allowed;
  }

  /**
   * Setter centralizado para session.paymentStatus
   */
  static setSessionPaymentStatus(session, value, meta = {}) {
    const allowed = this.log('SET_SESSION_PAYMENT_STATUS', session, 'paymentStatus', value, meta);
    if (allowed && MODE !== 'noop') {
      session.paymentStatus = value;
    }
    return allowed;
  }

  /**
   * Setter centralizado para appointment.isPaid
   */
  static setAppointmentPaid(appointment, value, meta = {}) {
    const allowed = this.log('SET_APPOINTMENT_PAID', appointment, 'isPaid', value, meta);
    if (allowed && MODE !== 'noop') {
      appointment.isPaid = value;
    }
    return allowed;
  }

  /**
   * Setter centralizado para appointment.paymentStatus
   */
  static setAppointmentPaymentStatus(appointment, value, meta = {}) {
    const allowed = this.log('SET_APPOINTMENT_PAYMENT_STATUS', appointment, 'paymentStatus', value, meta);
    if (allowed && MODE !== 'noop') {
      appointment.paymentStatus = value;
    }
    return allowed;
  }

  /**
   * Setter centralizado para package.totalPaid
   * REDIRECIONA para recalcular do ledger
   */
  static setPackageTotalPaid(pkg, value, meta = {}) {
    this.log('SET_PACKAGE_TOTAL_PAID', pkg, 'totalPaid', value, meta);

    // Em vez de setar manualmente, recalcula do ledger
    // Mas em modo warn/noop, permite o override para não quebrar fluxos antigos
    if (MODE === 'strict') {
      throw new Error(
        'Use PackageRecalculationService ou FinancialGuard para atualizar totalPaid. ' +
        'Não setar manualmente.'
      );
    }

    pkg.totalPaid = value;
    return true;
  }

  /**
   * Getter do modo atual
   */
  static getMode() {
    return MODE;
  }

  /**
   * Verifica se está em modo strict
   */
  static isStrict() {
    return MODE === 'strict';
  }
}

export default LegacyFinanceWriteGuard;
