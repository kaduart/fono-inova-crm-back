// utils/dateParser.js
import { parse, isValid, format } from "date-fns";
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

/**
 * Extrai a primeira data “plausível” de um texto em pt-BR.
 * Retorna um Date ou null.
 */
export function extractPreferredDateFromText(text = "") {
  if (!text) return null;

  // 1) Formatos numéricos: 22/12, 22-12, 22/12/2025, 22-12-25...
  const numericMatch = text.match(
    /(\d{1,2}[\/-]\d{1,2}(?:[\/-]\d{2,4})?)/
  );

  // 2) Formatos escritos: "22 de dezembro", "22 de dezembro de 2025" etc.
  const longMatch = text.match(
    /(\d{1,2}\s+de\s+[a-zç]+(?:\s+de\s+\d{4})?)/i
  );

  const raw = numericMatch?.[1] || longMatch?.[1];
  if (!raw) return null;

  const d = parsePtBrDate(raw);
  return d && isValid(d) ? d : null;
}

/**
 * Formata um Date em "YYYY-MM-DD" pro backend (agenda)
 */
export function formatAsIsoDate(date) {
  if (!date || !isValid(date)) return null;
  return format(date, "yyyy-MM-dd");
}
