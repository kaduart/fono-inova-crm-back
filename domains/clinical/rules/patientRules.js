// back/domains/clinical/rules/patientRules.js
/**
 * Patient Domain Rules
 * 
 * Regras de negócio extraídas dos controllers:
 * - whatsappController.js (RN-001)
 * - leadController.js (RN-002)
 * - convenioPackageController.js (RN-005)
 */

/**
 * RN-PATIENT-001: Lookup de Paciente por Telefone (WhatsApp)
 * Fonte: whatsappController.js:1807
 * 
 * Regra: Ao receber mensagem de número desconhecido, buscar paciente pelo telefone.
 * Se encontrado: usar dados existentes e marcar como "virou_paciente"
 * Se não encontrado: criar novo lead com status "novo"
 */
export const PatientLookupRules = {
  // Busca por telefone é o método padrão de identificação
  identificationField: 'phone',
  
  // Se paciente existe
  onFound: {
    status: 'virou_paciente',
    conversionScore: 100,
    action: 'use_existing_data'
  },
  
  // Se paciente não existe
  onNotFound: {
    status: 'novo',
    conversionScore: 0,
    action: 'create_lead'
  }
};

/**
 * RN-PATIENT-002: Conversão de Lead para Paciente
 * Fonte: leadController.js:522
 * 
 * Regra: Quando lead é convertido em paciente:
 * 1. Criar documento Patient com dados do lead
 * 2. Atualizar lead.status = 'virou_paciente'
 * 3. Vincular lead.convertedToPatient = patient._id
 */
export const LeadConversionRules = {
  trigger: 'lead_conversion',
  
  requiredData: [
    'fullName',
    'phone',
    'dateOfBirth'
  ],
  
  optionalData: [
    'healthPlan',
    'insuranceProvider'
  ],
  
  actions: {
    createPatient: true,
    updateLeadStatus: 'virou_paciente',
    linkLeadToPatient: true
  }
};

/**
 * RN-PATIENT-003: Atualização de Paciente com Pacote/Convênio
 * Fonte: convenioPackageController.js
 * 
 * Regra: Quando paciente adquire pacote de convênio,
 * adicionar referência ao array patient.packages
 */
export const PatientPackageRules = {
  // Paciente pode ter múltiplos pacotes (addToSet)
  packageArrayStrategy: 'addToSet',
  
  // Validação de pacote único por tipo (se necessário)
  preventDuplicatePackageTypes: false,
  
  // Ação ao adicionar pacote
  onPackageAdd: {
    updatePatient: true,
    addToPackagesArray: true
  }
};

/**
 * RN-PATIENT-004: Validações de Criação de Paciente
 * 
 * Regras obrigatórias para criar um paciente válido
 */
export const PatientValidationRules = {
  requiredFields: {
    fullName: {
      rule: 'min_length_3',
      message: 'Nome deve ter pelo menos 3 caracteres'
    },
    phone: {
      rule: 'valid_brazilian_phone',
      message: 'Telefone deve ser válido (DDD + número)'
    }
  },
  
  optionalFields: {
    dateOfBirth: {
      rule: 'valid_date_or_null',
      message: 'Data de nascimento deve ser válida'
    },
    email: {
      rule: 'valid_email_or_null',
      message: 'Email deve ser válido'
    }
  },
  
  uniqueness: {
    phone: {
      scope: 'global',
      message: 'Telefone já cadastrado'
    }
  }
};

// Exporta todas as regras
export const PatientRules = {
  lookup: PatientLookupRules,
  conversion: LeadConversionRules,
  package: PatientPackageRules,
  validation: PatientValidationRules
};

export default PatientRules;
