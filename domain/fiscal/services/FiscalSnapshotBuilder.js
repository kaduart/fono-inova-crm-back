// domain/fiscal/services/FiscalSnapshotBuilder.js
// A própria DPS enviada é um snapshot (Fase 2 v3, Seção 2.7) — precisa sobreviver a mudanças
// futuras em Patient/FiscalProfile/Doctor. Toda tentativa (FiscalSubmission) gera um
// FiscalSnapshot NOVO, nunca reutiliza um snapshot de tentativa anterior — mesmo que os dados de
// origem não tenham mudado, a garantia de "consigo reconstruir exatamente o que foi enviado
// naquela tentativa" depende de nunca compartilhar o registro entre tentativas.
//
// Escopo deste PR2 (documentado, não silencioso): monta a representação JSON estruturada da
// DPS a partir dos dados já disponíveis no domínio. NÃO serializa XML nem assina digitalmente —
// isso é DpsBuilder + CertificateManager, na Provider/Adapter Layer (PR3). O campo `xml` fica
// null até lá.

import crypto from 'crypto';
import Patient from '../../../models/Patient.js';
import Doctor from '../../../models/Doctor.js';
import { fiscalProfileRepository } from '../../../infrastructure/persistence/FiscalProfileRepository.js';
import { fiscalSnapshotRepository } from '../../../infrastructure/persistence/FiscalSnapshotRepository.js';

// Versão do leiaute confirmada na Fase 1.5 (dps_field_matrix.md) — atualizar quando uma nova
// pesquisa confirmar versão mais recente do Anexo I, nunca "chutar" incremento.
const CONFIRMED_SCHEMA_VERSION = 'ANEXO_I-v1.01-20260209';
const MANUAL_VERSION = 'nfse-fase1.5-dps_field_matrix-2026-07-16';

/**
 * @param {Object} fiscalInvoice - documento FiscalInvoice (com items, patient, professional, fiscalProfileId)
 * @param {string} fiscalSubmissionId - tentativa à qual este snapshot pertence (1:1)
 * @returns {Promise<Object>} FiscalSnapshot persistido
 */
export async function buildSnapshot(fiscalInvoice, fiscalSubmissionId, { session } = {}) {
  const [patient, professional, fiscalProfile] = await Promise.all([
    Patient.findById(fiscalInvoice.patient),
    fiscalInvoice.professional ? Doctor.findById(fiscalInvoice.professional) : null,
    fiscalProfileRepository.findById(fiscalInvoice.fiscalProfileId)
  ]);

  if (!patient) throw new Error('SNAPSHOT_BUILD_FAILED: paciente não encontrado');
  if (!fiscalProfile) throw new Error('SNAPSHOT_BUILD_FAILED: perfil fiscal não encontrado');

  const dpsJson = {
    infDPS: {
      tpAmb: fiscalProfile.ambiente === 'producao' ? 1 : 2,
      dCompet: fiscalInvoice.dCompet,
      prest: {
        cnpj: fiscalProfile.cnpj,
        xNome: fiscalProfile.razaoSocial,
        im: fiscalProfile.inscricaoMunicipal,
        professional: professional ? { id: String(professional._id), nome: professional.fullName } : null
      },
      toma: {
        id: String(patient._id),
        nome: patient.fullName,
        cpf: patient.cpf || null
      },
      serv: {
        cTribNac: fiscalInvoice.serviceCode,
        xDescServ: fiscalInvoice.serviceDescription,
        cLocPrestacao: fiscalProfile.municipioIBGE
      },
      valores: {
        vServ: fiscalInvoice.valorServico,
        vLiq: fiscalInvoice.valorLiquido,
        vISSQN: fiscalInvoice.vISSQN
      },
      itens: (fiscalInvoice.items || []).map((item) => ({
        description: item.description,
        quantity: item.quantity,
        unitValue: item.unitValue,
        totalValue: item.totalValue,
        serviceDate: item.serviceDate
      }))
    }
  };

  const hash = crypto.createHash('sha256').update(JSON.stringify(dpsJson)).digest('hex');

  return fiscalSnapshotRepository.create(
    {
      fiscalSubmission: fiscalSubmissionId,
      xml: null, // preenchido pelo DpsBuilder na Provider/Adapter Layer (PR3)
      json: dpsJson,
      hash,
      schemaVersion: CONFIRMED_SCHEMA_VERSION,
      manualVersion: MANUAL_VERSION
    },
    { session }
  );
}
