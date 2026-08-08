// Catálogo fiscal das especialidades efetivamente oferecidas pela clínica. Os códigos cTribNac
// vêm da Lista de Serviço Nacional (Anexo B v1.01-20260122). O enquadramento IBS/CBS de saúde
// usa o Anexo VIII v1.01.00: cIndOp 030101, CST 200 e cClassTrib 200029.
export const FISCAL_SERVICE_CATALOG = Object.freeze([
  { key: 'fonoaudiologia', label: 'Fonoaudiologia', serviceCode: '040803', municipalServiceCode: '040803', nbsCode: '123019900', description: 'Prestação de serviços de Fonoaudiologia' },
  { key: 'terapia_ocupacional', label: 'Terapia Ocupacional', serviceCode: '040801', municipalServiceCode: '040801', nbsCode: '123019900', description: 'Prestação de serviços de Terapia Ocupacional' },
  { key: 'fisioterapia', label: 'Fisioterapia', serviceCode: '040802', municipalServiceCode: '040802', nbsCode: '123019200', description: 'Prestação de serviços de Fisioterapia' },
  { key: 'psicologia', label: 'Psicologia', serviceCode: '041601', municipalServiceCode: '041601', nbsCode: '123019800', description: 'Prestação de serviços de Psicologia' },
  { key: 'neuropsicologia', label: 'Neuropsicologia', serviceCode: '041601', municipalServiceCode: '041601', nbsCode: '123019800', description: 'Prestação de serviços de Neuropsicologia' },
  { key: 'pediatria', label: 'Pediatria', serviceCode: '040101', municipalServiceCode: '040101', nbsCode: '123012200', description: 'Prestação de serviços médicos em Pediatria' },
  { key: 'neuroped', label: 'Neuropediatria', serviceCode: '040101', municipalServiceCode: '040101', nbsCode: '123012200', description: 'Prestação de serviços médicos em Neuropediatria' },
  { key: 'musicoterapia', label: 'Musicoterapia', serviceCode: '040901', municipalServiceCode: '040901', nbsCode: '123019900', description: 'Prestação de serviços de Musicoterapia' },
  { key: 'psicomotricidade', label: 'Psicomotricidade', serviceCode: '040901', municipalServiceCode: '040901', nbsCode: '123019900', description: 'Prestação de serviços de Psicomotricidade' },
  { key: 'psicopedagogia', label: 'Psicopedagogia clínica', serviceCode: '040901', municipalServiceCode: '040901', nbsCode: '123019900', description: 'Prestação de serviços de Psicopedagogia clínica' }
]);

const aliases = Object.freeze({
  neuropediatria: 'neuroped',
  neuropediatra: 'neuroped',
  terapeuta_ocupacional: 'terapia_ocupacional',
  'terapia ocupacional': 'terapia_ocupacional'
});

export function normalizeSpecialtyKey(value) {
  const normalized = String(value || '').trim().toLowerCase();
  return aliases[normalized] || normalized;
}

export function findFiscalServiceBySpecialty(specialty) {
  const key = normalizeSpecialtyKey(specialty);
  return FISCAL_SERVICE_CATALOG.find((service) => service.key === key) || null;
}

export function findFiscalServiceByCode(serviceCode) {
  const code = String(serviceCode || '').replace(/\D/g, '').padStart(6, '0');
  return FISCAL_SERVICE_CATALOG.find((service) => service.serviceCode === code) || null;
}
