/**
 * 🕶️ Anonimiza dados pessoais de pacientes/leads NA CÓPIA do espelho (LGPD).
 * Mantém valores, datas, status e ids — só troca quem é a pessoa.
 * Determinístico: o mesmo telefone/nome vira sempre o mesmo falso (joins e buscas continuam batendo).
 * Equipe (users, admins, doctors) NÃO é tocada, para o login no espelho continuar funcionando.
 */
import crypto from 'crypto';

const SALT = process.env.ESPELHO_ANON_SALT || 'fono-espelho';
const STAFF = new Set(['users', 'admins', 'doctors', 'secretaries']);
// coleções em que o campo "name" de topo é uma pessoa (em outras, "name" é pacote, especialidade...)
const PERSON_NAME = new Set(['patients', 'patients_view', 'leads', 'contacts', 'commercialcontacts', 'deletedpatientarchives', 'convenio_waitlists', 'conveniowaitlists']);
const CHAT = new Set(['messages', 'chat_projections']);

const NOMES = ['Ana', 'Bruno', 'Carla', 'Davi', 'Elisa', 'Felipe', 'Gabriela', 'Heitor', 'Isabela', 'João', 'Laura', 'Miguel', 'Nina', 'Otávio', 'Paula', 'Rafael', 'Sofia', 'Theo', 'Valentina', 'Lucas'];
const SOBRENOMES = ['Silva', 'Souza', 'Oliveira', 'Lima', 'Costa', 'Rocha', 'Alves', 'Pereira', 'Gomes', 'Ribeiro', 'Martins', 'Barbosa', 'Teixeira', 'Moura', 'Cardoso'];

const h = (v) => crypto.createHash('sha256').update(SALT + String(v).trim().toLowerCase()).digest();
const digits = (v, n) => { const b = h(v); let s = ''; for (let i = 0; s.length < n; i++) s += b[i % b.length] % 10; return s; };
const fakeName = (v) => { const b = h(v); return `${NOMES[b[0] % NOMES.length]} ${SOBRENOMES[b[1] % SOBRENOMES.length]} ${SOBRENOMES[b[2] % SOBRENOMES.length]}`; };
const fakePhone = (v) => { const d = String(v).replace(/\D/g, ''); if (d.length < 8) return v; return d.length >= 12 ? `55629${digits(d, d.length - 5)}` : `629${digits(d, d.length - 3)}`; };

const isPhoneKey = (k) => /(phone|telefone|celular|whatsapp)(?!.*(click|enabled|sent|status|id$))/i.test(k);
const isNameKey = (k) => /^(fullname|patientname|responsiblename|leadname|contactname|originalpatientname|normalizedname|nomecompleto|nome|guardianname|mothername|fathername)$/i.test(k);
const isAddressKey = (k) => /^(address|endereco)$/i.test(k);

function anonValue(key, v) {
  if (typeof v !== 'string' || !v) return v;
  if (/cpf/i.test(key)) return digits(v, 11);
  if (/^rg$/i.test(key)) return digits(v, 9);
  if (/email/i.test(key) && v.includes('@')) return `p${digits(v, 8)}@espelho.local`;
  if (isPhoneKey(key)) return fakePhone(v);
  if (isNameKey(key)) return fakeName(v);
  return v;
}
const blank = (v) => (typeof v === 'string' ? 'anonimizado' : Array.isArray(v) ? v.map(blank)
  : v && typeof v === 'object' && v.constructor === Object ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, blank(x)])) : v);

function walk(node, coll, depth, parentKey) {
  if (Array.isArray(node)) return node.map((x) => walk(x, coll, depth + 1, parentKey));
  if (!node || typeof node !== 'object' || node.constructor !== Object) return node;
  const out = {};
  for (const [k, v] of Object.entries(node)) {
    if (isAddressKey(k)) out[k] = blank(v);
    else if (CHAT.has(coll) && /^(content|text|body|caption|lastMessage)$/i.test(k) && typeof v === 'string') out[k] = '[mensagem anonimizada]';
    else if (k === 'name' && typeof v === 'string' && ((depth === 0 && PERSON_NAME.has(coll)) || /responsible|guardian|patient|lead|contact|parent/i.test(parentKey || ''))) out[k] = fakeName(v);
    else if (typeof v === 'string') out[k] = anonValue(k, v);
    else out[k] = walk(v, coll, depth + 1, k);
  }
  return out;
}

export function anonimizar(coll, doc) {
  if (STAFF.has(coll)) return doc;
  return walk(doc, coll, 0, '');
}
