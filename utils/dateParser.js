// utils/dateParser.js
import { format, isValid, parse } from "date-fns";
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
  const normalized = (text || "").toLowerCase();

  // pega primeiro padrão dd/MM ou dd-MM
  const match = normalized.match(/\b(\d{1,2})[\/\-](\d{1,2})\b/);
  if (!match) return null;

  const day = match[1].padStart(2, "0");
  const month = match[2].padStart(2, "0");

  const today = new Date();
  const year = today.getFullYear();

  let date = parse(`${day}/${month}/${year}`, "dd/MM/yyyy", new Date());
  if (!isValid(date)) return null;

  // se já passou hoje, sobe pro ano seguinte
  const todayMidnight = new Date(
    today.getFullYear(),
    today.getMonth(),
    today.getDate()
  );

  if (date < todayMidnight) {
    const nextYear = year + 1;
    date = parse(`${day}/${month}/${nextYear}`, "dd/MM/yyyy", new Date());
    if (!isValid(date)) return null;
  }

  return format(date, "yyyy-MM-dd"); // **string ISO curtinha**
}