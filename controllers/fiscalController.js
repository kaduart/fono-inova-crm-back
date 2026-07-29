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
import { fiscalSubmissionRepository } from '../infrastructure/persistence/FiscalSubmissionRepository.js';
import { fiscalSnapshotRepository } from '../infrastructure/persistence/FiscalSnapshotRepository.js';
import * as FiscalInvoiceService from '../domain/fiscal/services/FiscalInvoiceService.js';
import { FiscalProviderName } from '../constants/fiscalProviders.js';
import { FiscalOriginType } from '../constants/fiscalEnums.js';
import Payment from '../models/Payment.js';
import FiscalInvoice from '../models/FiscalInvoice.js';
import { buildDpsXml } from '../fiscal-provider/DpsBuilder.js';
import { MockAdapter } from '../adapters/fiscal/MockAdapter.js';
import { encryptBuffer, encryptString } from '../utils/certificateCrypto.js';
import { inspectPkcs12 } from '../fiscal-provider/CertificateManager.js';
import { testFiscalConnection } from '../services/fiscal/TestFiscalConnectionService.js';

// ============================================================
// CONFIGURAÇÃO FISCAL (Perfil + Certificado)
// ============================================================

export async function getFiscalProfile(req, res) {
  try {
    const profile = await fiscalProfileRepository.findActiveByCnpj(req.query.cnpj);
    if (!profile) {
      return res.status(404).json({ success: false, error: 'FISCAL_PROFILE_NOT_FOUND', message: 'Perfil fiscal não encontrado' });
    }
    res.json({ success: true, data: profile });
  } catch (error) {
    console.error('[FiscalController] getFiscalProfile error:', error);
    res.status(500).json({ success: false, error: 'INTERNAL_ERROR', message: error.message });
  }
}

export async function upsertFiscalProfile(req, res) {
  try {
    const { cnpj, razaoSocial, municipioIBGE, cnae, codigoServicoLC116, inscricaoMunicipal, regimeTributario, ambiente, certificateRef, endereco } = req.body;
    if (!cnpj || !razaoSocial || !municipioIBGE) {
      return res.status(400).json({ success: false, error: 'MISSING_REQUIRED_FIELDS', message: 'cnpj, razaoSocial e municipioIBGE são obrigatórios' });
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
    res.status(500).json({ success: false, error: 'INTERNAL_ERROR', message: error.message });
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
      return res.status(400).json({
        success: false,
        error: 'MISSING_REQUIRED_FIELDS',
        message: 'arquivo do certificado (.pfx/.p12), senha e tipo são obrigatórios'
      });
    }

    // Abre o certificado de verdade agora — se a senha estiver errada ou o arquivo corrompido/
    // não for PKCS#12, o erro aparece aqui, não na primeira tentativa de emissão. Também extrai
    // metadados de auditoria (fileHash/thumbprint/serialNumber/subject) — 2026-07-29.
    let inspection;
    try {
      inspection = inspectPkcs12(req.file.buffer, password);
    } catch (error) {
      return res.status(400).json({ success: false, error: 'CERTIFICADO_INVALIDO', message: error.message });
    }

    // Detecta upload duplicado do mesmo arquivo antes de gastar criptografia/gravação — comparação
    // é em texto puro (fileHash), não precisa decifrar nenhum certificado já salvo.
    const duplicate = await certificateRepository.findByFileHash(inspection.fileHash);
    if (duplicate) {
      return res.status(409).json({
        success: false,
        error: 'CERTIFICADO_DUPLICADO',
        message: `Este mesmo arquivo já foi cadastrado em ${duplicate.createdAt?.toISOString().slice(0, 10)} (${duplicate.originalFilename}).`,
        existingCertificateId: duplicate._id
      });
    }

    // Certificado já vencido nunca é útil pra assinar nada — bloqueia aqui, não deixa entrar no
    // banco pra descobrir só na hora de emitir.
    if (new Date(inspection.notAfter) < new Date()) {
      return res.status(400).json({
        success: false,
        error: 'CERTIFICADO_EXPIRADO',
        message: `Este certificado venceu em ${new Date(inspection.notAfter).toISOString().slice(0, 10)} — não pode ser cadastrado.`
      });
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
    res.status(500).json({ success: false, error: 'INTERNAL_ERROR', message: error.message });
  }
}

export async function listCertificates(req, res) {
  try {
    const certificates = await certificateRepository.findByStatus(req.query.status || 'active');
    res.json({ success: true, data: certificates });
  } catch (error) {
    console.error('[FiscalController] listCertificates error:', error);
    res.status(500).json({ success: false, error: 'INTERNAL_ERROR', message: error.message });
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
    res.status(500).json({ success: false, error: 'INTERNAL_ERROR', message: error.message });
  }
}

// ============================================================
// EMISSÃO E CONSULTA DE NFSe
// ============================================================

export async function emitFiscalInvoice(req, res) {
  try {
    const { fiscalProfileId, origin, patient, professional, serviceDescription, serviceCode, valorServico, valorLiquido, vISSQN, dCompet } = req.body;
    if (!fiscalProfileId || !origin || !origin.type || !origin.id || !patient) {
      return res.status(400).json({ success: false, error: 'MISSING_REQUIRED_FIELDS', message: 'fiscalProfileId, origin (type+id) e patient são obrigatórios' });
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
      return res.status(422).json({ success: false, error: 'FISCAL_INVOICE_NOT_ELIGIBLE', message: error.message, reasons: error.reasons });
    }
    res.status(500).json({ success: false, error: 'INTERNAL_ERROR', message: error.message });
  }
}

export async function emitFromPayment(req, res) {
  try {
    const { paymentId } = req.body;
    if (!paymentId) {
      return res.status(400).json({ success: false, error: 'MISSING_REQUIRED_FIELDS', message: 'paymentId é obrigatório' });
    }

    const payment = await Payment.findById(paymentId)
      .populate('patient')
      .populate('doctor')
      .populate('appointment')
      .populate('package');

    if (!payment) {
      return res.status(404).json({ success: false, error: 'PAYMENT_NOT_FOUND', message: 'Pagamento não encontrado' });
    }
    if (payment.status !== 'paid') {
      return res.status(422).json({ success: false, error: 'PAYMENT_NOT_PAID', message: 'Só é possível emitir NFSe para pagamentos com status Pago' });
    }

    const fiscalProfile = await fiscalProfileRepository.findActiveByCnpj(req.body.cnpj || '12345678000199');
    if (!fiscalProfile) {
      return res.status(404).json({ success: false, error: 'FISCAL_PROFILE_NOT_FOUND', message: 'Perfil fiscal não configurado' });
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
        return res.status(422).json({ success: false, error: 'CERTIFICATE_NOT_FOUND', message: 'Nenhum certificado digital ativo encontrado. Configure o certificado em Config. Fiscal.' });
      }
      const latestCertificate = activeCertificates.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))[0];
      await fiscalProfileRepository.updateFields(fiscalProfile._id, { certificateRef: latestCertificate._id.toString() });
      fiscalProfile.certificateRef = latestCertificate._id.toString();
    }


    let originType = 'manual';
    let originId = paymentId;
    if (payment.appointment) { originType = 'appointment'; originId = payment.appointment._id.toString(); }
    else if (payment.package) { originType = 'package'; originId = payment.package._id.toString(); }

    const draft = {
      fiscalProfileId: fiscalProfile._id.toString(),
      origin: { type: originType, id: originId },
      patient: payment.patient._id.toString(),
      professional: payment.doctor?._id?.toString(),
      serviceDescription: req.body.serviceDescription || 'Prestação de serviços de Fonoaudiologia',
      serviceCode: req.body.serviceCode || fiscalProfile.codigoServicoLC116 || '040803',
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
      return res.status(422).json({ success: false, error: 'FISCAL_INVOICE_NOT_ELIGIBLE', message: error.message, reasons: error.reasons });
    }
    res.status(500).json({ success: false, error: 'INTERNAL_ERROR', message: error.message });
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
    res.status(500).json({ success: false, error: 'INTERNAL_ERROR', message: error.message });
  }
}

export async function getFiscalInvoice(req, res) {
  try {
    const fiscalInvoice = await fiscalInvoiceRepository.findById(req.params.id);
    if (!fiscalInvoice) {
      return res.status(404).json({ success: false, error: 'FISCAL_INVOICE_NOT_FOUND', message: 'NFSe não encontrada' });
    }
    res.json({ success: true, data: fiscalInvoice });
  } catch (error) {
    console.error('[FiscalController] getFiscalInvoice error:', error);
    res.status(500).json({ success: false, error: 'INTERNAL_ERROR', message: error.message });
  }
}

export async function retryFiscalInvoice(req, res) {
  try {
    const { id } = req.params;
    const { outcome } = await retryFiscalSubmissionService.retry(id, { correlationId: req.headers['x-correlation-id'] });
    const fiscalInvoice = await FiscalInvoice.findById(id).populate('patient', 'fullName');
    res.json({ success: true, data: { fiscalInvoice, outcome } });
  } catch (error) {
    console.error('[FiscalController] retryFiscalInvoice error:', error);
    res.status(500).json({ success: false, error: 'INTERNAL_ERROR', message: error.message });
  }
}

export async function cancelFiscalInvoice(req, res) {
  try {
    const { id: fiscalInvoiceId } = req.params;
    const result = await FiscalInvoiceService.requestCancellation(fiscalInvoiceId, { correlationId: req.headers['x-correlation-id'] });
    res.json({ success: true, data: result });
  } catch (error) {
    console.error('[FiscalController] cancelFiscalInvoice error:', error);
    res.status(500).json({ success: false, error: 'INTERNAL_ERROR', message: error.message });
  }
}

// ============================================================
// DOWNLOAD XML / PDF
// ============================================================

export async function downloadFiscalInvoiceXml(req, res) {
  try {
    const fiscalInvoice = await fiscalInvoiceRepository.findById(req.params.id);
    if (!fiscalInvoice) {
      return res.status(404).json({ success: false, error: 'FISCAL_INVOICE_NOT_FOUND' });
    }

    const attachments = await fiscalAttachmentRepository.findByType(fiscalInvoice._id, 'xml_nfse');
    if (attachments.length > 0) {
      // MVP: storageRef é a própria string do XML (pode evoluir para S3/blob depois)
      return res.set('Content-Type', 'application/xml').send(attachments[0].storageRef);
    }

    // Fallback: gera XML on-the-fly a partir do último snapshot (útil para notas autorizadas
    // antes de existir o attachment persistido, ou em desenvolvimento com MockAdapter).
    const submissions = await fiscalSubmissionRepository.findByFiscalInvoice(fiscalInvoice._id);
    if (!submissions.length) {
      return res.status(404).json({ success: false, error: 'FISCAL_SUBMISSION_NOT_FOUND' });
    }
    const lastSubmission = submissions[submissions.length - 1];
    const snapshot = await fiscalSnapshotRepository.findByFiscalSubmission(lastSubmission._id);
    if (!snapshot) {
      return res.status(404).json({ success: false, error: 'FISCAL_SNAPSHOT_NOT_FOUND' });
    }

    const fiscalProfile = await fiscalProfileRepository.findById(fiscalInvoice.fiscalProfileId);
    const xml = buildDpsXml(snapshot.json, fiscalInvoice, fiscalProfile);
    res.set('Content-Type', 'application/xml').send(xml);
  } catch (error) {
    console.error('[FiscalController] downloadFiscalInvoiceXml error:', error);
    res.status(500).json({ success: false, error: 'INTERNAL_ERROR', message: error.message });
  }
}

export async function downloadFiscalInvoicePdf(req, res) {
  try {
    const fiscalInvoice = await fiscalInvoiceRepository.findById(req.params.id);
    if (!fiscalInvoice) {
      return res.status(404).json({ success: false, error: 'FISCAL_INVOICE_NOT_FOUND' });
    }

    const attachments = await fiscalAttachmentRepository.findByType(fiscalInvoice._id, 'danfse_pdf');
    if (attachments.length > 0) {
      const buffer = Buffer.from(attachments[0].storageRef, 'base64');
      return res.set('Content-Type', 'application/pdf').send(buffer);
    }

    // Fallback: MockAdapter para DANFSe em desenvolvimento.
    const providerName = FiscalProviderName.MOCK;
    const adapter = new MockAdapter({ forceOutcome: 'success' });
    const { pdfBase64 } = await adapter.getDanfse(fiscalInvoice.chaveAcesso || 'MOCK');
    const buffer = Buffer.from(pdfBase64, 'base64');
    res.set('Content-Type', 'application/pdf').send(buffer);
  } catch (error) {
    console.error('[FiscalController] downloadFiscalInvoicePdf error:', error);
    res.status(500).json({ success: false, error: 'INTERNAL_ERROR', message: error.message });
  }
}
