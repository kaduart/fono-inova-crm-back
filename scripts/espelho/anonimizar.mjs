/**
 * 🕶️ Anonimiza dados pessoais de pacientes/leads NA CÓPIA do espelho (LGPD).
 * Mantém valores, datas, status e ids — só troca quem é a pessoa.
 * Determinístico: o mesmo telefone/nome vira sempre o mesmo falso (joins e buscas continuam batendo).
 * Equipe (users, admins, doctors): por padrão não é tocada (login do espelho local continua igual).
 * Com { equipe: true } (cópia na nuvem): nome da equipe também vira falso; e-mail/senha são
 * trocados por contas de teste no espelhoSync. Com { credenciais: true }: zera tokens/segredos.
 */
import crypto from 'crypto';

// sal secreto: sem ele não dá para reverter CPF/telefone por força bruta (fixo só no espelho local)
const SALT = () => process.env.ESPELHO_ANON_SALT || process.env.ESPELHO_SYNC_TEST_PASSWORD || 'fono-espelho';
const STAFF = new Set(['users', 'admins', 'doctors', 'secretaries']);
// coleções em que o campo "name" de topo é uma pessoa (em outras, "name" é pacote, especialidade...)
const PERSON_NAME = new Set(['patients', 'patients_view', 'leads', 'contacts', 'commercialcontacts', 'deletedpatientarchives', 'convenio_waitlists', 'conveniowaitlists']);
const CHAT = new Set(['messages', 'chat_projections', 'chatcontexts', 'followups', 'detector_feedbacks', 'learninginsights', 'conversationfeedbacks', 'failedmessages', 'auditlogs']);

const NOMES = ['Ana', 'Bruno', 'Carla', 'Davi', 'Elisa', 'Felipe', 'Gabriela', 'Heitor', 'Isabela', 'João', 'Laura', 'Miguel', 'Nina', 'Otávio', 'Paula', 'Rafael', 'Sofia', 'Theo', 'Valentina', 'Lucas'];
const SOBRENOMES = ['Silva', 'Souza', 'Oliveira', 'Lima', 'Costa', 'Rocha', 'Alves', 'Pereira', 'Gomes', 'Ribeiro', 'Martins', 'Barbosa', 'Teixeira', 'Moura', 'Cardoso'];

const h = (v) => crypto.createHash('sha256').update(SALT() + String(v).trim().toLowerCase()).digest();
const digits = (v, n) => { const b = h(v); let s = ''; for (let i = 0; s.length < n; i++) s += b[i % b.length] % 10; return s; };
const fakeName = (v) => { const b = h(v); return `${NOMES[b[0] % NOMES.length]} ${SOBRENOMES[b[1] % SOBRENOMES.length]} ${SOBRENOMES[b[2] % SOBRENOMES.length]}`; };
const fakePhone = (v) => { const d = String(v).replace(/\D/g, ''); if (d.length < 8) return v; return d.length >= 12 ? `55629${digits(d, d.length - 5)}` : `629${digits(d, d.length - 3)}`; };

// texto livre de conversa em qualquer coleção
const isFreeTextKey = (k) => /^(conversationsummary|lastsummary|summarytext|lastmessagepreview|lastmessage|messagepreview|transcript|notes?_?whatsapp|rawtext|usermessage|originalmessage)$/i.test(k);
// reforço: e-mail, telefone e CPF soltos dentro de qualquer texto
const scrub = (t) => t
  .replace(/[\w.+-]+@[\w-]+\.[\w.]+/g, 'email@espelho.local')
  .replace(/\d{3}\.?\d{3}\.?\d{3}-?\d{2}\b/g, '000.000.000-00')
  .replace(/(\+?55\s?)?\(?\d{2}\)?\s?9?\d{4}[-\s]?\d{4}/g, '(62) 90000-0000');
const isPhoneKey = (k) => /(phone|telefone|celular|whatsapp)(?!.*(click|enabled|sent|status|id$))/i.test(k);
const isNameKey = (k) => /^(fullname|patientname|responsiblename|leadname|contactname|originalpatientname|normalizedname|nomecompleto|nome|guardianname|mothername|fathername)$/i.test(k);
const isCredKey = (k) => /(token|secret|apikey|api_key|privatekey|private_key|ciphertext|refresh|pfx|certificado(base64|senha)?$|certificatedata|senha|clientsecret|webhookurl)/i.test(k) && !/(count|type|expires|at$|status)/i.test(k);
const isStaffNameKey = (k) => /^(doctorname|professionalname|createdbyname|updatedbyname|therapistname|secretaryname|username)$/i.test(k);
const isAddressKey = (k) => /^(address|endereco)$/i.test(k);

const PHONE_LIKE = /^(\+?55)?\(?\d{2}\)?\s?9?\d{4}-?\d{4}(@[a-z.]+)?$/i;
function anonValue(key, v) {
  if (typeof v !== 'string' || !v) return v;
  if (/^wa(message)?id$|^wamid$|^msgid$|^messageid$/i.test(key) && v.length > 8) return `wamid.espelho${digits(v, 16)}`;
  if (PHONE_LIKE.test(v.trim())) { const [num, suf] = v.trim().split('@'); return fakePhone(num) + (suf ? `@${suf}` : ''); }
  if (/cpf/i.test(key)) return digits(v, 11);
  if (/^rg$/i.test(key)) return digits(v, 9);
  if (/email/i.test(key) && v.includes('@')) return `p${digits(v, 8)}@espelho.local`;
  if (isPhoneKey(key)) return fakePhone(v);
  if (isNameKey(key)) return fakeName(v);
  return v;
}
const blank = (v) => (typeof v === 'string' ? 'anonimizado' : Array.isArray(v) ? v.map(blank)
  : v && typeof v === 'object' && v.constructor === Object ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, blank(x)])) : v);

function walk(node, coll, depth, parentKey, opt = {}) {
  if (Array.isArray(node)) return node.map((x) => walk(x, coll, depth + 1, parentKey, opt));
  if (!node || typeof node !== 'object' || node.constructor !== Object) return node;
  const out = {};
  for (const [k, v] of Object.entries(node)) {
    if (opt.credenciais && isCredKey(k) && v != null && typeof v !== 'boolean' && typeof v !== 'number') out[k] = null;
    else if (opt.equipe && isStaffNameKey(k) && typeof v === 'string') out[k] = fakeName(v);
    else if (opt.equipe && k === 'name' && depth === 0 && STAFF.has(coll) && typeof v === 'string') out[k] = fakeName(v);
    else if (isAddressKey(k)) out[k] = blank(v);
    else if (isFreeTextKey(k) && typeof v === 'string') out[k] = '[mensagem anonimizada]';
    else if (k === 'message' && /interactions|history|messages|log/i.test(parentKey || '') && typeof v === 'string') out[k] = '[mensagem anonimizada]';
    else if (CHAT.has(coll) && /^(content|text|body|caption|lastmessage|message|messages|transcript|summary|originalmessage|usermessage|response|reply|history)$/i.test(k) && (typeof v === 'string' || Array.isArray(v))) out[k] = typeof v === 'string' ? '[mensagem anonimizada]' : [];
    else if (k === 'name' && typeof v === 'string' && ((depth === 0 && PERSON_NAME.has(coll)) || /responsible|guardian|patient|lead|contact|parent/i.test(parentKey || ''))) out[k] = fakeName(v);
    else if (typeof v === 'string') { const a = anonValue(k, v); out[k] = a === v && v.length > 9 && /\s/.test(v) && !STAFF.has(coll) ? scrub(v) : a; }
    else out[k] = walk(v, coll, depth + 1, k, opt);
  }
  return out;
}

export function anonimizar(coll, doc, opt = {}) {
  if (STAFF.has(coll) && !opt.equipe) return doc;
  return walk(doc, coll, 0, '', opt);
}
export const COLECOES_EQUIPE = STAFF;
