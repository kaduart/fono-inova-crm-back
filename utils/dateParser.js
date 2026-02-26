// utils/dateParser.js
import { addDays, format, isValid, parse } from "date-fns";
import { ptBR } from "date-fns/locale"; // você já usa date-fns no projeto

// Padrões de data em pt-BR que queremos aceitar
const DATE_PATTERNS = [
  "dd/MM/yyyy",
  "d/M/yyyy",
  "dd-MM-yyyy",
  "d-M-yyyy",
  "dd/MM/yy",
  "d/M/yy",
  "dd 'de' MMMM 'de' yyyy",
  "d 'de' MMMM 'de' yyyy",
  "dd MMMM yyyy",
  "d MMMM yyyy",
];

const MONTH_MAP = {
  'jan': '01', 'janeiro': '01',
  'fev': '02', 'fevereiro': '02',
  'mar': '03', 'marco': '03', 'março': '03',
  'abr': '04', 'abril': '04',
  'mai': '05', 'maio': '05',
  'jun': '06', 'junho': '06',
  'jul': '07', 'julho': '07',
  'ago': '08', 'agosto': '08',
  'set': '09', 'setembro': '09',
  'out': '10', 'outubro': '10',
  'nov': '11', 'novembro': '11',
  'dez': '12', 'dezembro': '12',
};

/**
 * Tenta converter um texto em um Date válido (pt-BR)
 * Ex: "22/12/2025", "22/12", "22-12-2025", "10 de outubro de 2020"
 */
export function parsePtBrDate(text = "") {
  const normalized = text.trim().replace(/\s+/g, " ");

  // Tenta cada pattern explicitamente
  for (const pattern of DATE_PATTERNS) {
    const d = parse(normalized, pattern, new Date(), { locale: ptBR });
    if (isValid(d)) return d;
  }

  // Tentativa genérica como fallback
  const jsDate = new Date(normalized);
  if (isValid(jsDate)) return jsDate;

  return null;
}

export function extractPreferredDateFromText(text = "") {
  const normalized = (text || "").toLowerCase().normalize('NFC');
  const today = new Date();
  const todayMidnight = new Date(today.getFullYear(), today.getMonth(), today.getDate());

  // "amanhã" / "amanha"
  if (/\bamanh[aã]\b/.test(normalized)) {
    return format(addDays(todayMidnight, 1), "yyyy-MM-dd");
  }

  // "depois de amanhã"
  if (/\bdepois\s+de\s+amanh[aã]\b/.test(normalized)) {
    return format(addDays(todayMidnight, 2), "yyyy-MM-dd");
  }

  // Padrão numérico dd/MM ou dd-MM (ex: "10/03", "a partir de 15-04")
  const numericMatch = normalized.match(/\b(\d{1,2})[\/\-](\d{1,2})\b/);
  if (numericMatch) {
    const day = numericMatch[1].padStart(2, "0");
    const month = numericMatch[2].padStart(2, "0");
    const year = today.getFullYear();
    let date = parse(`${day}/${month}/${year}`, "dd/MM/yyyy", new Date());
    if (!isValid(date)) return null;
    if (date < todayMidnight) {
      date = parse(`${day}/${month}/${year + 1}`, "dd/MM/yyyy", new Date());
      if (!isValid(date)) return null;
    }
    return format(date, "yyyy-MM-dd");
  }

  // Padrão por nome de mês: "10 de março", "dia 15 de abril", "15 março"
  const monthNames = Object.keys(MONTH_MAP).join('|');
  const monthNameRegex = new RegExp(`(?:dia\\s+)?(\\d{1,2})\\s+(?:de\\s+)?(${monthNames})(?:\\s+(?:de\\s+)?(\\d{4}))?`, 'i');
  const monthMatch = normalized.match(monthNameRegex);
  if (monthMatch) {
    const day = monthMatch[1].padStart(2, "0");
    const monthNum = MONTH_MAP[monthMatch[2].toLowerCase().normalize('NFC')];
    if (!monthNum) return null;
    const year = monthMatch[3] ? parseInt(monthMatch[3]) : today.getFullYear();
    let date = parse(`${day}/${monthNum}/${year}`, "dd/MM/yyyy", new Date());
    if (!isValid(date)) return null;
    if (date < todayMidnight) {
      date = parse(`${day}/${monthNum}/${year + 1}`, "dd/MM/yyyy", new Date());
      if (!isValid(date)) return null;
    }
    return format(date, "yyyy-MM-dd");
  }

  return null;
}