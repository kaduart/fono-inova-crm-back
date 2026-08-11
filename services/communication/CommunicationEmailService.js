// services/communication/CommunicationEmailService.js
//
// LEGADO: a lógica de envio de e-mail foi movida para
// `services/communication/delivery/EmailDeliveryProvider.js` e o orquestrador
// `services/communication/CommunicationService.js`.
//
// Este arquivo mantém apenas helpers de consulta/logs para compatibilidade com
// as rotas existentes. Novo código deve usar CommunicationService + providers.

import CommunicationEmailLog from '../../models/CommunicationEmailLog.js';
import CommunicationPackage from '../../models/CommunicationPackage.js';
import InsuranceCommunication from '../../models/InsuranceCommunication.js';
import Convenio from '../../models/Convenio.js';

// Status que só existe na leitura da aba "Envios": comunicação pronta que nunca teve
// tentativa de envio. Não é gravado em CommunicationEmailLog — não há log para gravar.
const NOT_SENT_STATUS = 'not_sent';

export async function getEmailLogs(communicationId) {
  return CommunicationEmailLog.find({ communicationId })
    .sort({ sentAt: -1 })
    .lean();
}

/**
 * Lista CADA tentativa de envio (1 log = 1 linha), não só a última por comunicação.
 * É o que alimenta a aba "Envios" — histórico/auditoria completo, não um resumo.
 */
export async function listCommunicationEmailLogs({
  purpose,
  insuranceProvider,
  patientId,
  status,
  search,
  month,
  page = 1,
  limit = 100
} = {}) {
  const commQuery = {};
  if (purpose) commQuery.purpose = purpose;
  if (insuranceProvider) commQuery.insuranceProvider = insuranceProvider.toLowerCase();
  if (patientId) commQuery.patientId = patientId;

  let communications = await InsuranceCommunication.find(commQuery)
    .populate('patientId', 'fullName')
    .populate('guideId', 'number')
    .lean();

  // Busca por nome do paciente mora aqui (e não no front) porque o nome vem do
  // populate da comunicação, não do log. Filtrar no cliente só alcançaria a página
  // atual — um envio antigo em outra página simplesmente "sumia" da busca.
  const term = (search || '').trim().toLowerCase();
  if (term) {
    communications = communications.filter(c =>
      (c.patientId?.fullName || '').toLowerCase().includes(term)
    );
  }

  if (communications.length === 0) {
    return { data: [], pagination: { total: 0, page, limit, pages: 0 } };
  }

  const commIds = communications.map(c => c._id);
  const commById = new Map(communications.map(c => [c._id.toString(), c]));

  const convenioCodes = [...new Set(communications.map(c => c.insuranceProvider))];
  const convenios = await Convenio.find({ code: { $in: convenioCodes } }).select('code name').lean();
  const convenioMap = new Map(convenios.map(c => [c.code, c.name]));

  const logs = await CommunicationEmailLog.find({ communicationId: { $in: commIds } })
    .sort({ sentAt: -1 })
    .lean();

  // Comunicações prontas que NUNCA geraram tentativa de envio. Sem elas a aba mostra
  // só quem já tentou sair: quem nunca foi enviado não tem log, e some da tela — foi
  // assim que 7 faturamentos prontos com anexos (Ícaro, Benjamim, Joaquim, Isabela)
  // ficaram invisíveis, sem nenhum lugar no CRM onde disparar o envio (achado
  // 2026-08-11). `draft` fica de fora de propósito: ainda não tem pacote montado,
  // não é "não enviado", é "não preparado".
  const commIdsWithLog = new Set(logs.map(l => l.communicationId.toString()));
  const neverSentComms = communications.filter(
    c => !commIdsWithLog.has(c._id.toString()) && c.status !== 'draft'
  );

  const packagesByComm = new Map();
  if (neverSentComms.length > 0) {
    const pkgs = await CommunicationPackage.find({
      communicationId: { $in: neverSentComms.map(c => c._id) }
    }).select('communicationId attachments').lean();
    pkgs.forEach(p => packagesByComm.set(p.communicationId.toString(), p));
  }

  // Entradas virtuais: mesmo formato de um log, com status 'not_sent'. `_id` recebe
  // prefixo porque não é um CommunicationEmailLog real — só o front usa como chave.
  const neverSentEntries = neverSentComms.map(c => {
    const pkg = packagesByComm.get(c._id.toString());
    return {
      _id: `never-sent-${c._id}`,
      communicationId: c._id,
      status: NOT_SENT_STATUS,
      to: '',
      subject: '',
      attempt: 0,
      type: null,
      channel: c.deliveryMethod || 'email',
      attachments: pkg?.attachments?.map(a => ({
        documentId: a.documentId,
        url: a.url,
        name: a.filename,
        mimeType: a.mimeType,
        size: a.size
      })) || [],
      // Sem envio não existe sentAt. Usamos a data em que a comunicação ficou pronta
      // para ordenar e filtrar por período junto com os logs reais; o front rotula
      // essa data como "pronta desde", não como "enviada em".
      sentAt: c.updatedAt || c.createdAt,
      neverSent: true
    };
  });

  const enrich = (entry) => {
    const comm = commById.get(entry.communicationId.toString());
    return {
      ...entry,
      patientId: comm?.patientId?._id || comm?.patientId,
      patientName: comm?.patientId?.fullName || '',
      insuranceProvider: comm?.insuranceProvider,
      insuranceName: convenioMap.get(comm?.insuranceProvider) || comm?.insuranceProvider,
      guideNumber: comm?.guideId?.number || null,
      purpose: comm?.purpose,
      communicationStatus: comm?.status,
      deliveryMethod: comm?.deliveryMethod || 'email'
    };
  };

  let combined = [...logs, ...neverSentEntries].map(enrich);

  // 'unsent' junta as duas formas de não ter chegado ao convênio: a tentativa que
  // falhou e a que nunca aconteceu. É o filtro que responde "o que ainda preciso
  // enviar?", que era a pergunta real por trás da aba.
  if (status === 'unsent') {
    combined = combined.filter(e => e.status === 'error' || e.status === NOT_SENT_STATUS);
  } else if (status) {
    combined = combined.filter(e => e.status === status);
  }

  if (month && /^\d{4}-\d{2}$/.test(month)) {
    const [y, m] = month.split('-').map(Number);
    const from = new Date(y, m - 1, 1);
    const to = new Date(y, m, 1);
    combined = combined.filter(e => e.sentAt && e.sentAt >= from && e.sentAt < to);
  }

  // Ordenação e paginação em memória: o conjunto já está materializado (as
  // comunicações são carregadas inteiras acima para resolver paciente/convênio), e
  // as entradas virtuais não existem no banco, então não há como paginar no Mongo
  // sem perder justamente quem nunca foi enviado.
  combined.sort((a, b) => new Date(b.sentAt).getTime() - new Date(a.sentAt).getTime());

  const total = combined.length;
  const skip = (page - 1) * limit;
  const data = limit > 0 ? combined.slice(skip, skip + limit) : combined;

  return { data, pagination: { total, page, limit, pages: Math.ceil(total / limit) } };
}

export async function getLatestEmailLog(communicationId) {
  return CommunicationEmailLog.findOne({ communicationId })
    .sort({ sentAt: -1 })
    .lean();
}
