import FiscalDpsSequence from '../../models/FiscalDpsSequence.js';
import { fiscalInvoiceRepository } from '../../infrastructure/persistence/FiscalInvoiceRepository.js';

const OWN_APP_SERIES = 1;

function digits(value) {
  return String(value || '').replace(/\D/g, '');
}

export function buildDpsId({ municipioIBGE, cnpj, serie, nDPS }) {
  const municipality = digits(municipioIBGE);
  const federalRegistration = digits(cnpj);
  if (municipality.length !== 7) throw new Error('DPS_MUNICIPIO_IBGE_INVALIDO');
  if (federalRegistration.length !== 14) throw new Error('DPS_CNPJ_PRESTADOR_INVALIDO');
  if (!Number.isInteger(serie) || serie < 1 || serie > 49999) throw new Error('DPS_SERIE_INVALIDA');
  if (!Number.isInteger(nDPS) || nDPS < 1 || nDPS > 999999999999999) throw new Error('DPS_NUMERO_INVALIDO');

  // Tipo de inscrição federal 2 = CNPJ. O identificador completo possui exatamente 45 posições.
  return `DPS${municipality}2${federalRegistration}${String(serie).padStart(5, '0')}${String(nDPS).padStart(15, '0')}`;
}

export async function ensureDpsIdentity(fiscalInvoice, fiscalProfile) {
  if (fiscalInvoice.dpsId && fiscalInvoice.serie && fiscalInvoice.nDPS) return fiscalInvoice;

  const cnpj = digits(fiscalProfile.cnpj);
  const serie = fiscalInvoice.serie || OWN_APP_SERIES;
  const key = `${cnpj}:${serie}`;
  const counter = await FiscalDpsSequence.findOneAndUpdate(
    { key },
    { $inc: { value: 1 }, $setOnInsert: { key } },
    { new: true, upsert: true, setDefaultsOnInsert: true }
  );
  const nDPS = counter.value;
  const dpsId = buildDpsId({ municipioIBGE: fiscalProfile.municipioIBGE, cnpj, serie, nDPS });

  return fiscalInvoiceRepository.updateFields(fiscalInvoice._id, { serie, nDPS, dpsId });
}
