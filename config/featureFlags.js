/**
 * Feature Flags - Transição 4.0 Event-Driven
 * 
 * Controle granular de ativação do novo fluxo
 */

export const FeatureFlags = {
  // Fluxos de agendamento
  CREATE: {
    USE_V2: process.env.FF_CREATE_V2 === 'true',
    PERCENTAGE_V2: parseInt(process.env.FF_CREATE_PERCENTAGE || '0'),
  },
  
  COMPLETE: {
    USE_V2: process.env.FF_COMPLETE_V2 === 'true',
    PERCENTAGE_V2: parseInt(process.env.FF_COMPLETE_PERCENTAGE || '0'),
  },
  
  CANCEL: {
    USE_V2: process.env.FF_CANCEL_V2 === 'true',
    PERCENTAGE_V2: parseInt(process.env.FF_CANCEL_PERCENTAGE || '0'),
  },
  
  // Verifica se deve usar V2 baseado no patientId (canary)
  shouldUseV2: function(flag, patientId) {
    if (process.env.FF_EMERGENCY_ROLLBACK === 'true') {
      return false;
    }
    
    if (!this[flag].USE_V2) return false;
    
    if (this[flag].PERCENTAGE_V2 >= 100) return true;
    
    // Canary: usa hash do patientId para decidir
    if (patientId) {
      const hash = patientId.toString().split('').reduce((a,b) => a + b.charCodeAt(0), 0);
      return (hash % 100) < this[flag].PERCENTAGE_V2;
    }
    
    return false;
  },
  
  // 💰 Feature Flag: Ledger Financial View (V1 → V2)
  FINANCIAL: {
    USE_LEDGER: process.env.FF_FINANCIAL_LEDGER === 'true',
    PERCENTAGE_LEDGER: parseInt(process.env.FF_FINANCIAL_LEDGER_PERCENTAGE || '0'),
  },
  
  // Status atual das flags
  getStatus: function() {
    return {
      emergencyRollback: process.env.FF_EMERGENCY_ROLLBACK === 'true',
      create: { useV2: this.CREATE.USE_V2, percentage: this.CREATE.PERCENTAGE_V2 },
      complete: { useV2: this.COMPLETE.USE_V2, percentage: this.COMPLETE.PERCENTAGE_V2 },
      cancel: { useV2: this.CANCEL.USE_V2, percentage: this.CANCEL.PERCENTAGE_V2 },
      financial: { useLedger: this.FINANCIAL.USE_LEDGER, percentage: this.FINANCIAL.PERCENTAGE_LEDGER },
    };
  }
};
