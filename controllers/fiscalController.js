// controllers/fiscalController.js
// Controller REST mínimo para o MVP do módulo fiscal NFS-e.
// Responsabilidade: receber requisições HTTP, chamar os services de aplicação já existentes
// (IssueFiscalInvoiceService, RetryFiscalSubmissionService) e devolver respostas simples.
// Não contém regra de negócio — toda a regra fica nos services de domínio.

import mongoose from 'mongoose';
import { issueFiscalInvoiceService } from '../services/fiscal/IssueFiscalInvoiceService.js';
import { retryFiscalSubmissionService } from '../services/fiscal/RetryFiscalSubmissionService.js';
import { fiscalInvoiceRepository } from '../infrastructure/persistence/FiscalInvoiceRepository.js';
import { fiscalProfileRepository } from '../infrastructure/persistence/FiscalProfileRepository.js';
import { certificateRepository } from '../infrastructure/persistence/CertificateRepository.js';
import { fiscalAttachmentRepository } from '../infrastructure/persistence/FiscalAttachmentRepository.js';
import * as FiscalInvoiceService from '../domain/fiscal/services/FiscalInvoiceService.js';
import { FiscalInvoiceStatus, FiscalOriginType } from '../constants/fiscalEnums.js';
import Payment from '../models/Payment.js';
import FiscalInvoice from '../models/FiscalInvoice.js';
import { encryptBuffer, encryptString } from '../utils/certificateCrypto.js';
import { inspectPkcs12 } from '../fiscal-provider/CertificateManager.js';
import { testFiscalConnection } from '../services/fiscal/TestFiscalConnectionService.js';
import {
  FISCAL_SERVICE_CATALOG,
  findFiscalServiceByCode,
  findFiscalServiceBySpecialty
} from '../domain/fiscal/FiscalServiceCatalog.js';
import { sendApiError } from '../errors/buildErrorResponse.js';
import { AppError } from '../errors/AppError.js';

// ============================================================
// CONFIGURAÇÃO FISCAL (Perfil + Certificado)
// ============================================================

export async function getFiscalProfile(req, res) {
  try {
    const profile = await fiscalProfileRepository.findActiveByCnpj(req.query.cnpj);
    if (!profile) {
      return sendApiError(
        res,
        new AppError('NOT_FOUND', 'Perfil fiscal não encontrado', {
          status: 404,
          legacyError: 'FISCAL_PROFILE_NOT_FOUND',
        }),
        req
      );
    }
    res.json({ success: true, data: profile });
  } catch (error) {
    console.error('[FiscalController] getFiscalProfile error:', error);
    sendApiError(
      res,
      new AppError('INTERNAL_ERROR', error.message, {
        status: 500,
        legacyError: 'INTERNAL_ERROR',
      }),
      req
    );
  }
}

export async function upsertFiscalProfile(req, res) {
  try {
    const { cnpj, razaoSocial, municipioIBGE, cnae, codigoServicoLC116, inscricaoMunicipal, regimeTributario, ambiente, certificateRef, endereco } = req.body;
    if (!cnpj || !razaoSocial || !municipioIBGE) {
      return sendApiError(
        res,
        new AppError('BAD_REQUEST', 'cnpj, razaoSocial e municipioIBGE são obrigatórios', {
          status: 400,
          legacyError: 'MISSING_REQUIRED_FIELDS',
        }),
        req
      );
    }

    let profile = await fiscalProfileRepository.findActiveByCnpj(cnpj);
    if (profile) {
      profile = await fiscalProfileRepository.updateFields(profile._id, {
        razaoSocial, municipioIBGE, cnae, codigoServicoLC116, inscricaoMunicipal, regimeTributario, ambiente, certificateRef, endereco
      });
    } else {
      profile = await fiscalProfileRepository.create({
        cnpj, razaoSocial, municipioIBGE, cnae, codigoServicoLC116, inscricaoMunicipal, regimeTributario, ambiente, certificateRef, endereco, ativo: true
      });
    }
    res.json({ success: true, data: profile });
  } catch (error) {
    console.error('[FiscalController] upsertFiscalProfile error:', error);
    sendApiError(
      res,
      new AppError('INTERNAL_ERROR', error.message, {
        status: 500,
        legacyError: 'INTERNAL_ERROR',
      }),
      req
    );
  }
}

// Recebe o arquivo real do certificado (.pfx/.p12) via multipart (multer, ver fiscal.routes.js),
// VALIDA que é um PKCS#12 legível com a senha informada (abre de verdade, não só confere
// extensão) antes de salvar qualquer coisa, criptografa arquivo + senha em repouso (AES-256-GCM,
// utils/certificateCrypto.js) e nunca guarda nem devolve nenhum dos dois em texto/binário puro.
export async function createCertificate(req, res) {
  try {
    const { type, password, issuer, status } = req.body;
    if (!type || !password || !req.file) {
      return sendApiError(
        res,
        new AppError('BAD_REQUEST', 'arquivo do certificado (.pfx/.p12), senha e tipo são obrigatórios', {
          status: 400,
          legacyError: 'MISSING_REQUIRED_FIELDS',
        }),
        req
      );
    }

    // Abre o certificado de verdade agora — se a senha estiver errada ou o arquivo corrompido/
    // não for PKCS#12, o erro aparece aqui, não na primeira tentativa de emissão. Também extrai
    // metadados de auditoria (fileHash/thumbprint/serialNumber/subject) — 2026-07-29.
    let inspection;
    try {
      inspection = inspectPkcs12(req.file.buffer, password);
    } catch (error) {
      return sendApiError(
        res,
        new AppError('BAD_REQUEST', error.message, {
          status: 400,
          legacyError: 'CERTIFICADO_INVALIDO',
        }),
        req
      );
    }

    // Detecta upload duplicado do mesmo arquivo antes de gastar criptografia/gravação — comparação
    // é em texto puro (fileHash), não precisa decifrar nenhum certificado já salvo.
    const duplicate = await certificateRepository.findByFileHash(inspection.fileHash);
    if (duplicate) {
      return sendApiError(
        res,
        new AppError('CONFLICT', `Este mesmo arquivo já foi cadastrado em ${duplicate.createdAt?.toISOString().slice(0, 10)} (${duplicate.originalFilename}).`, {
          status: 409,
          legacyError: 'CERTIFICADO_DUPLICADO',
          extra: { existingCertificateId: duplicate._id },
        }),
        req
      );
    }

    // Certificado já vencido nunca é útil pra assinar nada — bloqueia aqui, não deixa entrar no
    // banco pra descobrir só na hora de emitir.
    if (new Date(inspection.notAfter) < new Date()) {
      return sendApiError(
        res,
        new AppError('BAD_REQUEST', `Este certificado venceu em ${new Date(inspection.notAfter).toISOString().slice(0, 10)} — não pode ser cadastrado.`, {
          status: 400,
          legacyError: 'CERTIFICADO_EXPIRADO',
        }),
        req
      );
    }

    const daysUntilExpiry = Math.floor((new Date(inspection.notAfter).getTime() - Date.now()) / (1000 * 60 * 60 * 24));

    const encryptedFile = encryptBuffer(req.file.buffer);
    const encryptedPassword = encryptString(password);

    const certificate = await certificateRepository.create({
      type,
      expiresAt: inspection.notAfter, // do certificado real, não do que o usuário digitou
      issuer: issuer || inspection.issuer,
      subject: inspection.subject,
      serialNumber: inspection.serialNumber,
      thumbprint: inspection.thumbprint,
      fileHash: inspection.fileHash,
      keyUsage: inspection.keyUsage,
      status,
      encryptedFile,
      encryptedPassword,
      originalFilename: req.file.originalname
    });

    const safe = certificate.toObject();
    delete safe.encryptedFile;
    delete safe.encryptedPassword;
    // Informativo pro admin conferir visualmente — nunca sobrescreve FiscalProfile.cnpj sozinho.
    safe.subjectInfo = { commonName: inspection.commonName, detectedCnpj: inspection.detectedCnpj, notBefore: inspection.notBefore };

    // Avisos que não bloqueiam o cadastro, só chamam atenção do admin.
    const warnings = [];
    if (daysUntilExpiry <= 30) {
      warnings.push(`Certificado vence em ${daysUntilExpiry} dia(s) (${new Date(inspection.notAfter).toISOString().slice(0, 10)}) — considere renovar em breve.`);
    }
    if (inspection.keyUsage && !inspection.keyUsage.digitalSignature) {
      warnings.push('O certificado não declara a extensão Key Usage "Digital Signature" — pode não ser adequado para assinar documentos fiscais.');
    }
    if (warnings.length) safe.warnings = warnings;

    res.status(201).json({ success: true, data: safe });
  } catch (error) {
    console.error('[FiscalController] createCertificate error:', error);
    sendApiError(
      res,
      new AppError('INTERNAL_ERROR', error.message, {
        status: 500,
        legacyError: 'INTERNAL_ERROR',
      }),
      req
    );
  }
}

export async function listCertificates(req, res) {
  try {
    const certificates = await certificateRepository.findByStatus(req.query.status || 'active');
    res.json({ success: true, data: certificates });
  } catch (error) {
    console.error('[FiscalController] listCertificates error:', error);
    sendApiError(
      res,
      new AppError('INTERNAL_ERROR', error.message, {
        status: 500,
        legacyError: 'INTERNAL_ERROR',
      }),
      req
    );
  }
}

/**
 * Diagnóstico de conectividade mTLS — carrega o certificado, monta o https.Agent, faz UMA
 * chamada GET real contra o provider e devolve um relatório estruturado. Não emite nada, não
 * assina XML. Pensado pra checar rapidamente "o certificado ainda está funcionando?" sem precisar
 * escrever script descartável — sobretudo útil quando o certificado for renovado/trocado.
 */
export async function testConnection(req, res) {
  try {
    const diagnostic = await testFiscalConnection(req.query.cnpj);
    res.status(diagnostic.ok ? 200 : 502).json({ success: diagnostic.ok, data: diagnostic });
  } catch (error) {
    console.error('[FiscalController] testConnection error:', error);
    sendApiError(
      res,
      new AppError('INTERNAL_ERROR', error.message, {
        status: 500,
        legacyError: 'INTERNAL_ERROR',
      }),
      req
    );
  }
}

// ============================================================
// EMISSÃO E CONSULTA DE NFSe
// ============================================================

function onlyDigits(value) {
  return String(value || '').replace(/\D/g, '');
}

function normalizeAndValidateTaker(input) {
  if (!input || !['patient', 'responsible', 'company'].includes(input.type)) {
    throw new Error('TOMADOR_TIPO_INVALIDO');
  }

  const cpf = onlyDigits(input.cpf);
  const cnpj = onlyDigits(input.cnpj);
  const address = input.address || {};
  const requiredAddress = ['street', 'number', 'district', 'municipioIBGE', 'zipCode'];

  if (!String(input.name || '').trim()) throw new Error('TOMADOR_NOME_OBRIGATORIO');
  if (input.type === 'company' && cnpj.length !== 14) throw new Error('TOMADOR_CNPJ_INVALIDO');
  if (input.type !== 'company' && cpf.length !== 11) throw new Error('TOMADOR_CPF_INVALIDO');
  if (requiredAddress.some((field) => !String(address[field] || '').trim())) {
    throw new Error('TOMADOR_ENDERECO_INCOMPLETO');
  }
  if (onlyDigits(address.zipCode).length !== 8) throw new Error('TOMADOR_CEP_INVALIDO');
  if (onlyDigits(address.municipioIBGE).length !== 7) throw new Error('TOMADOR_MUNICIPIO_IBGE_INVALIDO');

  return {
    type: input.type,
    name: String(input.name).trim(),
    cpf: input.type === 'company' ? undefined : cpf,
    cnpj: input.type === 'company' ? cnpj : undefined,
    address: {
      street: String(address.street).trim(),
      number: String(address.number).trim(),
      complement: String(address.complement || '').trim(),
      district: String(address.district).trim(),
      municipioIBGE: onlyDigits(address.municipioIBGE),
      zipCode: onlyDigits(address.zipCode)
    }
  };
}

export async function getPaymentFiscalContext(req, res) {
  try {
    const payment = await Payment.findById(req.params.paymentId)
      .populate('patient')
      .populate('appointment', 'specialty')
      .populate('package', 'sessionType specialty')
      .populate('doctor', 'specialty');
    if (!payment?.patient) {
      return sendApiError(
        res,
        new AppError('NOT_FOUND', 'Pagamento ou paciente não encontrado', {
          status: 404,
          legacyError: 'PAYMENT_OR_PATIENT_NOT_FOUND',
        }),
        req
      );
    }
    const patient = payment.patient;
    const paymentSpecialty = payment.sessionType || payment.serviceType || payment.appointment?.specialty
      || payment.package?.sessionType || payment.package?.specialty || payment.doctor?.specialty;
    const suggestedService = findFiscalServiceBySpecialty(paymentSpecialty) || FISCAL_SERVICE_CATALOG[0];
    res.json({
      success: true,
      data: {
        services: FISCAL_SERVICE_CATALOG,
        suggestedServiceKey: suggestedService.key,
        patient: {
          id: patient._id,
          name: patient.fullName,
          cpf: patient.cpf || '',
          cnpj: patient.cnpj || '',
          legalGuardian: patient.legalGuardian || '',
          address: {
            street: patient.address?.street || '',
            number: patient.address?.number || '',
            complement: '',
            district: patient.address?.district || '',
            municipioIBGE: patient.address?.municipioIBGE || '',
            zipCode: patient.address?.zipCode || ''
          }
        }
      }
    });
  } catch (error) {
    sendApiError(
      res,
      new AppError('INTERNAL_ERROR', error.message, {
        status: 500,
        legacyError: 'INTERNAL_ERROR',
      }),
      req
    );
  }
}

export async function emitFiscalInvoice(req, res) {
  try {
    const { fiscalProfileId, origin, patient, professional, serviceDescription, serviceCode, valorServico, valorLiquido, vISSQN, dCompet } = req.body;
    if (!fiscalProfileId || !origin || !origin.type || !origin.id || !patient) {
      return sendApiError(
        res,
        new AppError('BAD_REQUEST', 'fiscalProfileId, origin (type+id) e patient são obrigatórios', {
          status: 400,
          legacyError: 'MISSING_REQUIRED_FIELDS',
        }),
        req
      );
    }

    const draft = {
      fiscalProfileId,
      origin: { type: origin.type, id: origin.id },
      patient,
      professional,
      serviceDescription,
      serviceCode,
      valorServico,
      valorLiquido,
      vISSQN,
      dCompet: dCompet ? new Date(dCompet) : new Date()
    };

    const { fiscalInvoice, outcome } = await issueFiscalInvoiceService.issue(draft, { correlationId: req.headers['x-correlation-id'] });

    res.status(201).json({ success: true, data: { fiscalInvoice, outcome } });
  } catch (error) {
    console.error('[FiscalController] emitFiscalInvoice error:', error);
    if (error.message?.includes('FISCAL_INVOICE_NOT_ELIGIBLE')) {
      return sendApiError(
        res,
        new AppError('UNPROCESSABLE', error.message, {
          status: 422,
          legacyError: 'FISCAL_INVOICE_NOT_ELIGIBLE',
          extra: { reasons: error.reasons },
        }),
        req
      );
    }
    sendApiError(
      res,
      new AppError('INTERNAL_ERROR', error.message, {
        status: 500,
        legacyError: 'INTERNAL_ERROR',
      }),
      req
    );
  }
}

export async function emitFromPayment(req, res) {
  try {
    const { paymentId } = req.body;
    if (!paymentId) {
      return sendApiError(
        res,
        new AppError('BAD_REQUEST', 'paymentId é obrigatório', {
          status: 400,
          legacyError: 'MISSING_REQUIRED_FIELDS',
        }),
        req
      );
    }

    const payment = await Payment.findById(paymentId)
      .populate('patient')
      .populate('doctor')
      .populate('appointment')
      .populate('package');

    if (!payment) {
      return sendApiError(
        res,
        new AppError('NOT_FOUND', 'Pagamento não encontrado', {
          status: 404,
          legacyError: 'PAYMENT_NOT_FOUND',
        }),
        req
      );
    }
    if (!payment.patient) {
      return sendApiError(
        res,
        new AppError('UNPROCESSABLE', 'O pagamento não possui paciente vinculado', {
          status: 422,
          legacyError: 'PAYMENT_WITHOUT_PATIENT',
        }),
        req
      );
    }
    if (payment.status !== 'paid') {
      return sendApiError(
        res,
        new AppError('UNPROCESSABLE', 'Só é possível emitir NFSe para pagamentos com status Pago', {
          status: 422,
          legacyError: 'PAYMENT_NOT_PAID',
        }),
        req
      );
    }

    // A emissão vinda do caixa não precisa conhecer o CNPJ do prestador: ele pertence à
    // configuração fiscal, não ao pagamento/tomador. Quando não vier um CNPJ explícito,
    // usa o perfil ativo da clínica (hoje existe apenas um).
    const fiscalProfile = req.body.cnpj
      ? await fiscalProfileRepository.findActiveByCnpj(onlyDigits(req.body.cnpj))
      : await fiscalProfileRepository.findFirstActive();
    if (!fiscalProfile) {
      return sendApiError(
        res,
        new AppError('NOT_FOUND', 'Perfil fiscal não configurado', {
          status: 404,
          legacyError: 'FISCAL_PROFILE_NOT_FOUND',
        }),
        req
      );
    }

    // MVP fallback: se o perfil não tem certificado vinculado ou o certificado vinculado não existe,
    // vincula o certificado ativo mais recente automaticamente. Para a Clínica Fono Inova há apenas um certificado.
    const activeCertificates = await certificateRepository.findByStatus('active');
    let certificateRefValid = false;
    if (fiscalProfile.certificateRef) {
      const linkedCertificate = await certificateRepository.findById(fiscalProfile.certificateRef);
      certificateRefValid = !!linkedCertificate;
    }
    if (!certificateRefValid) {
      if (activeCertificates.length === 0) {
        return sendApiError(
          res,
          new AppError('UNPROCESSABLE', 'Nenhum certificado digital ativo encontrado. Configure o certificado em Config. Fiscal.', {
            status: 422,
            legacyError: 'CERTIFICATE_NOT_FOUND',
          }),
          req
        );
      }
      const latestCertificate = activeCertificates.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))[0];
      await fiscalProfileRepository.updateFields(fiscalProfile._id, { certificateRef: latestCertificate._id.toString() });
      fiscalProfile.certificateRef = latestCertificate._id.toString();
    }


    let originType = 'manual';
    let originId = paymentId;
    if (payment.appointment) { originType = 'appointment'; originId = payment.appointment._id.toString(); }
    else if (payment.package) { originType = 'package'; originId = payment.package._id.toString(); }

    const fiscalTaker = normalizeAndValidateTaker(req.body.fiscalTaker);
    const selectedService = findFiscalServiceByCode(req.body.serviceCode);
    if (!selectedService) {
      return sendApiError(
        res,
        new AppError('UNPROCESSABLE', 'Selecione uma especialidade configurada no catálogo fiscal da clínica', {
          status: 422,
          legacyError: 'FISCAL_SERVICE_NOT_CONFIGURED',
        }),
        req
      );
    }
    const beneficiarySuffix = fiscalTaker.type === 'patient'
      ? ''
      : ` — atendimento prestado ao paciente ${payment.patient.fullName}`;
    const resolvedServiceDescription = `${req.body.serviceDescription || selectedService.description}${beneficiarySuffix}`;

    // Recuperação segura de emissão pendente. Se ela ainda não tinha identidade (bug antigo),
    // atualiza os dados antes da reconciliação. Uma DPS identificada nunca é reenviada sem que
    // o provedor confirme primeiro o resultado da tentativa anterior.
    const existingInvoices = await fiscalInvoiceRepository.findByOrigin(originType, originId);
    const recoverable = existingInvoices.find((invoice) => invoice.status === FiscalInvoiceStatus.PENDING_SUBMISSION);
    if (recoverable) {
      const invoiceToRetry = recoverable.dpsId
        ? recoverable
        : await fiscalInvoiceRepository.updateFields(recoverable._id, {
          fiscalTaker,
          serviceDescription: resolvedServiceDescription,
          serviceCode: selectedService.serviceCode
        });
      const { fiscalInvoice, outcome, reason } = await retryFiscalSubmissionService.retry(invoiceToRetry._id, {
        correlationId: req.headers['x-correlation-id']
      });
      return res.status(200).json({
        success: true,
        data: {
          fiscalInvoice,
          outcome,
          recovered: outcome === 'authorized',
          reconciliationRequired: outcome === 'reconciliation_required',
          ...(reason ? { reason } : {})
        }
      });
    }

    const draft = {
      fiscalProfileId: fiscalProfile._id.toString(),
      origin: { type: originType, id: originId },
      patient: payment.patient._id.toString(),
      fiscalTaker,
      professional: payment.doctor?._id?.toString(),
      serviceDescription: resolvedServiceDescription,
      serviceCode: selectedService.serviceCode,
      valorServico: req.body.valorServico ?? payment.amount,
      valorLiquido: req.body.valorLiquido ?? payment.amount,
      vISSQN: req.body.vISSQN ?? 0,
      dCompet: req.body.dCompet ? new Date(req.body.dCompet) : (payment.paymentDate || new Date())
    };

    const { fiscalInvoice, outcome } = await issueFiscalInvoiceService.issue(draft, { correlationId: req.headers['x-correlation-id'] });

    res.status(201).json({ success: true, data: { fiscalInvoice, outcome } });
  } catch (error) {
    console.error('[FiscalController] emitFromPayment error:', error);
    if (error.message?.includes('FISCAL_INVOICE_NOT_ELIGIBLE')) {
      return sendApiError(
        res,
        new AppError('UNPROCESSABLE', error.message, {
          status: 422,
          legacyError: 'FISCAL_INVOICE_NOT_ELIGIBLE',
          extra: { reasons: error.reasons },
        }),
        req
      );
    }
    if (error.message?.startsWith('TOMADOR_')) {
      const messages = {
        TOMADOR_TIPO_INVALIDO: 'Selecione quem será o tomador da nota',
        TOMADOR_NOME_OBRIGATORIO: 'Informe o nome ou razão social do tomador',
        TOMADOR_CPF_INVALIDO: 'Informe um CPF com 11 dígitos para o tomador',
        TOMADOR_CNPJ_INVALIDO: 'Informe um CNPJ com 14 dígitos para o tomador',
        TOMADOR_ENDERECO_INCOMPLETO: 'Preencha o endereço completo do tomador',
        TOMADOR_CEP_INVALIDO: 'Informe um CEP com 8 dígitos',
        TOMADOR_MUNICIPIO_IBGE_INVALIDO: 'Informe o código IBGE do município com 7 dígitos'
      };
      return sendApiError(
        res,
        new AppError('UNPROCESSABLE', messages[error.message] || error.message, {
          status: 422,
          legacyError: error.message,
        }),
        req
      );
    }
    sendApiError(
      res,
      new AppError('INTERNAL_ERROR', error.message, {
        status: 500,
        legacyError: 'INTERNAL_ERROR',
      }),
      req
    );
  }
}

export async function listFiscalInvoices(req, res) {
  try {
    const { status, patient, limit = 50, page = 1 } = req.query;
    const filter = {};
    if (status) filter.status = status;
    if (patient) filter.patient = patient;

    const skip = (parseInt(page) - 1) * parseInt(limit);
    const [data, total] = await Promise.all([
      FiscalInvoice.find(filter)
        .populate('patient', 'fullName')
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(parseInt(limit)),
      FiscalInvoice.countDocuments(filter)
    ]);

    res.json({ success: true, data, pagination: { total, page: parseInt(page), limit: parseInt(limit) } });
  } catch (error) {
    console.error('[FiscalController] listFiscalInvoices error:', error);
    sendApiError(
      res,
      new AppError('INTERNAL_ERROR', error.message, {
        status: 500,
        legacyError: 'INTERNAL_ERROR',
      }),
      req
    );
  }
}

export async function getFiscalInvoice(req, res) {
  try {
    const fiscalInvoice = await fiscalInvoiceRepository.findById(req.params.id);
    if (!fiscalInvoice) {
      return sendApiError(
        res,
        new AppError('NOT_FOUND', 'NFSe não encontrada', {
          status: 404,
          legacyError: 'FISCAL_INVOICE_NOT_FOUND',
        }),
        req
      );
    }
    res.json({ success: true, data: fiscalInvoice });
  } catch (error) {
    console.error('[FiscalController] getFiscalInvoice error:', error);
    sendApiError(
      res,
      new AppError('INTERNAL_ERROR', error.message, {
        status: 500,
        legacyError: 'INTERNAL_ERROR',
      }),
      req
    );
  }
}

export async function retryFiscalInvoice(req, res) {
  try {
    const { id } = req.params;
    const { outcome, reason } = await retryFiscalSubmissionService.retry(id, { correlationId: req.headers['x-correlation-id'] });
    const fiscalInvoice = await FiscalInvoice.findById(id).populate('patient', 'fullName');
    res.json({ success: true, data: { fiscalInvoice, outcome, ...(reason ? { reason } : {}) } });
  } catch (error) {
    console.error('[FiscalController] retryFiscalInvoice error:', error);
    sendApiError(
      res,
      new AppError('INTERNAL_ERROR', error.message, {
        status: 500,
        legacyError: 'INTERNAL_ERROR',
      }),
      req
    );
  }
}

export async function cancelFiscalInvoice(req, res) {
  try {
    const { id: fiscalInvoiceId } = req.params;
    const result = await FiscalInvoiceService.requestCancellation(fiscalInvoiceId, { correlationId: req.headers['x-correlation-id'] });
    res.json({ success: true, data: result });
  } catch (error) {
    console.error('[FiscalController] cancelFiscalInvoice error:', error);
    sendApiError(
      res,
      new AppError('INTERNAL_ERROR', error.message, {
        status: 500,
        legacyError: 'INTERNAL_ERROR',
      }),
      req
    );
  }
}

// ============================================================
// DOWNLOAD XML / PDF
// ============================================================

export async function downloadFiscalInvoiceXml(req, res) {
  try {
    const fiscalInvoice = await fiscalInvoiceRepository.findById(req.params.id);
    if (!fiscalInvoice) {
      return sendApiError(res, new AppError('NOT_FOUND', 'FISCAL_INVOICE_NOT_FOUND', { status: 404 }), req);
    }
    if (fiscalInvoice.status !== FiscalInvoiceStatus.AUTHORIZED) {
      return sendApiError(
        res,
        new AppError('CONFLICT', 'A NFS-e ainda não foi autorizada; o XML oficial não está disponível', {
          status: 409,
          legacyError: 'NFSE_NOT_AUTHORIZED',
        }),
        req
      );
    }

    const attachments = await fiscalAttachmentRepository.findByType(fiscalInvoice._id, 'xml_nfse');
    if (attachments.length > 0) {
      // MVP: storageRef é a própria string do XML (pode evoluir para S3/blob depois)
      return res.set('Content-Type', 'application/xml').send(attachments[0].storageRef);
    }

    return sendApiError(
      res,
      new AppError('NOT_FOUND', 'O XML oficial da NFS-e autorizada não foi armazenado', {
        status: 404,
        legacyError: 'NFSE_XML_NOT_AVAILABLE',
      }),
      req
    );
  } catch (error) {
    console.error('[FiscalController] downloadFiscalInvoiceXml error:', error);
    sendApiError(
      res,
      new AppError('INTERNAL_ERROR', error.message, {
        status: 500,
        legacyError: 'INTERNAL_ERROR',
      }),
      req
    );
  }
}

export async function downloadFiscalInvoicePdf(req, res) {
  try {
    const fiscalInvoice = await fiscalInvoiceRepository.findById(req.params.id);
    if (!fiscalInvoice) {
      return sendApiError(res, new AppError('NOT_FOUND', 'FISCAL_INVOICE_NOT_FOUND', { status: 404 }), req);
    }
    if (fiscalInvoice.status !== FiscalInvoiceStatus.AUTHORIZED) {
      return sendApiError(
        res,
        new AppError('CONFLICT', 'A NFS-e ainda não foi autorizada; o DANFSe não está disponível', {
          status: 409,
          legacyError: 'NFSE_NOT_AUTHORIZED',
        }),
        req
      );
    }

    const attachments = await fiscalAttachmentRepository.findByType(fiscalInvoice._id, 'danfse_pdf');
    if (attachments.length > 0) {
      const buffer = Buffer.from(attachments[0].storageRef, 'base64');
      return res.set('Content-Type', 'application/pdf').send(buffer);
    }

    return sendApiError(
      res,
      new AppError('NOT_FOUND', 'O DANFSe oficial ainda não foi obtido do provedor fiscal', {
        status: 404,
        legacyError: 'DANFSE_NOT_AVAILABLE',
      }),
      req
    );
  } catch (error) {
    console.error('[FiscalController] downloadFiscalInvoicePdf error:', error);
    sendApiError(
      res,
      new AppError('INTERNAL_ERROR', error.message, {
        status: 500,
        legacyError: 'INTERNAL_ERROR',
      }),
      req
    );
  }
}
