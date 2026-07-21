// services/communication/InsuranceRuleService.js
import Convenio from '../../models/Convenio.js';

function buildFallbackRules(convenio, purpose) {
  const gp = convenio?.guidePolicy;
  if (!gp) return null;

  if (purpose === 'billing') {
    return {
      defaultEmail: gp.billingEmail || null,
      defaultSubject: 'Documentação para Faturamento',
      requiredDocuments: [
        { type: 'attendance_list', label: 'Lista de Presença', required: true },
        { type: 'guide', label: 'Guia', required: true },
        { type: 'invoice', label: 'Nota Fiscal', required: false },
        { type: 'report', label: 'Relatório', required: false }
      ]
    };
  }

  if (purpose === 'authorization') {
    return {
      defaultEmail: gp.priorAuthEmail || null,
      defaultSubject: 'Solicitação de Autorização de Atendimento',
      requiredDocuments: [
        { type: 'medical_order', label: 'Pedido Médico', required: true },
        { type: 'insurance_card', label: 'Carteirinha', required: true },
        { type: 'id_document', label: 'RG', required: false },
        { type: 'print_portal', label: 'Print Portal', required: false }
      ]
    };
  }

  return null;
}

export function getRulesForPurpose(convenio, purpose) {
  // Regras específicas do purpose têm prioridade
  if (convenio?.communicationRules?.[purpose]) {
    return convenio.communicationRules[purpose];
  }
  // Fallback por purpose
  if (purpose === 'authorization') {
    return convenio?.authorizationRules || convenio?.communicationRules?.authorization || buildFallbackRules(convenio, purpose) || null;
  }
  if (purpose === 'billing') {
    return buildFallbackRules(convenio, purpose) || null;
  }
  return buildFallbackRules(convenio, purpose) || null;
}

export function getRulesForInsuranceByConvenio(convenio, purpose) {
  return getRulesForPurpose(convenio, purpose);
}

export async function getRulesForInsurance(insuranceProvider, purpose = 'authorization') {
  const convenio = await Convenio.findOne({ code: insuranceProvider.toLowerCase() }).select('communicationRules authorizationRules guidePolicy').lean();
  return getRulesForPurpose(convenio, purpose);
}

export async function updateRulesForInsurance(insuranceProvider, purpose = 'authorization', rules) {
  const updatePath = `communicationRules.${purpose}`;
  const convenio = await Convenio.findOneAndUpdate(
    { code: insuranceProvider.toLowerCase() },
    { $set: { [updatePath]: rules } },
    { new: true, runValidators: true }
  ).select('communicationRules authorizationRules');
  return getRulesForPurpose(convenio, purpose);
}

export function getRequiredDocumentTypes(rules) {
  if (!rules || !rules.requiredDocuments) return [];
  return rules.requiredDocuments.filter(d => d.required).map(d => d.type);
}

export function getAllDocumentTypes(rules) {
  if (!rules || !rules.requiredDocuments) return [];
  return rules.requiredDocuments.map(d => ({ type: d.type, label: d.label, required: d.required }));
}
