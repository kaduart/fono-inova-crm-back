// tests/fiscal/_guardAgainstProductionDb.js
// Trava de segurança criada em 2026-09-11 depois de um incidente real: os testes de integração
// fiscal não tinham isolamento nenhum de banco — `import 'dotenv/config'` carregava o .env padrão,
// e MONGO_URI ali apontava para mongodb+srv://.../fono_inova_prod (produção real, confirmado pelo
// usuário). Um `deleteMany({})` sem filtro nessas coleções rodou contra esse banco mais de uma vez
// (ver docs/nfse-fiscal-module/anapolis_audit_2026-09-11.md para o relato completo e a limpeza
// feita).
//
// Endurecido no mesmo dia: os testes fiscais de integração agora usam MongoMemoryReplSet (mesmo
// padrão já usado em tests/e2e/*.e2e.test.js) e nunca leem MONGO_URI/process.env para decidir onde
// conectar — não há mais string externa nenhuma para "vazar" produção. Esta trava permanece como
// defesa em profundidade: valida a URI que efetivamente será usada antes de qualquer connect().
//
// Design: ALLOWLIST, não blocklist. Antes, o critério era "rejeitar se a string contiver 'prod'"
// — um blocklist não detecta nomes de banco de produção que não sigam essa convenção. Agora só é
// permitido conectar se TODO host resolvido na string for loopback (127.0.0.1/localhost/::1),
// exatamente o que mongodb-memory-server sempre usa. Qualquer outro host — incluindo um Atlas
// srv://, um host de rede interna, ou qualquer coisa não reconhecida — é recusado
// incondicionalmente. Não existe variável de ambiente nem parâmetro para liberar isso.

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);

/** Extrai o host de uma entrada host[:porta], preservando notação IPv6 entre colchetes. */
function hostOf(entry) {
  const trimmed = entry.trim();
  if (trimmed.startsWith('[')) return `${trimmed.slice(0, trimmed.indexOf(']') + 1)}`;
  return trimmed.split(':')[0];
}

/** Extrai os hosts de uma connection string mongodb://host1,host2/... ou mongodb+srv://host/... */
function extractHosts(connectionString) {
  const withoutScheme = connectionString.replace(/^mongodb(\+srv)?:\/\//, '');
  const withoutUserinfo = withoutScheme.includes('@') ? withoutScheme.split('@').slice(1).join('@') : withoutScheme;
  const hostPart = withoutUserinfo.split(/[/?]/)[0];
  return hostPart.split(',').map(hostOf).filter(Boolean);
}

/**
 * @param {string} connectionString - a URI que está prestes a ser usada em mongoose.connect()
 * @throws sempre que a URI não puder ser confirmada como um banco local efêmero (loopback)
 */
export function assertLoopbackOnlyDatabase(connectionString) {
  if (!connectionString) throw new Error('FISCAL_INTEGRATION_TEST_SEM_CONNECTION_STRING');

  let hosts;
  try {
    hosts = extractHosts(connectionString);
  } catch {
    hosts = [];
  }

  const allLoopback = hosts.length > 0 && hosts.every((host) => LOOPBACK_HOSTS.has(host));
  if (!allLoopback) {
    throw new Error(
      'FISCAL_INTEGRATION_TEST_BLOQUEADO: a connection string resolvida não é reconhecida como um ' +
      'banco local efêmero (só 127.0.0.1/localhost/::1 são permitidos). Isto inclui, mas não se ' +
      'limita a, qualquer banco de produção. Não existe variável de ambiente que libere esta trava — ' +
      'testes de integração fiscal devem usar MongoMemoryReplSet (mongodb-memory-server), o mesmo ' +
      'padrão já usado em tests/e2e/*.e2e.test.js.'
    );
  }
}
