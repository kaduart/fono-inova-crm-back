#!/usr/bin/env node
/**
 * audit-frontend-api-usage.js
 *
 * Varre front/src em busca de chamadas /api/
 * e gera relatório V1 vs V2 vs "safe to disable".
 *
 * Uso: node back/scripts/audit-frontend-api-usage.js
 */

import { readFileSync, readdirSync, statSync, writeFileSync } from 'fs';
import { join, extname } from 'path';

// ─── config ───────────────────────────────────────────────────────────────────

const FRONT_SRC = join(process.cwd(), 'front/src');
const EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.jsx']);

// Rotas V1 registradas no server.js (atualizar se server.js mudar)
const V1_ROUTES = [
    '/api/doctors',
    '/api/patients',
    '/api/packages',
    '/api/payments',
    '/api/expenses',
    '/api/cashflow',
    '/api/financial/dashboard',
    '/api/insurance-guides',
    '/api/pre-agendamento',
    '/api/evolutions',
    '/api/leads',
    '/api/sales',
    '/api/provisionamento',
    '/api/dashboard',
    '/api/amanda',
    '/api/convenio-packages',
    '/api/analytics',
    '/api/reports',
    '/api/protocols',
    '/api/specialties',
    '/api/users',
    '/api/admin',
    '/api/appointments',
    '/api/financial',
];

// Rotas V2 registradas
const V2_ROUTES = [
    '/api/v2/appointments',
    '/api/v2/patients',
    '/api/v2/doctors',
    '/api/v2/packages',
    '/api/v2/payments',
    '/api/v2/balance',
    '/api/v2/expenses',
    '/api/v2/cashflow',
    '/api/v2/totals',
    '/api/v2/daily-closing',
    '/api/v2/daily-summary',
    '/api/v2/financial/dashboard',
    '/api/v2/financial/audit',
    '/api/v2/projections',
    '/api/v2/goals',
    '/api/v2/intelligence',
    '/api/v2/pre-appointments',
    '/api/v2/insurance-guides',
    '/api/v2/analytics/operational',
    '/api/v2/admin/dashboard',
    '/api/v2/convenio',
    '/api/v2/calendar',
];

// Mapeamento V1 → V2 (pares conhecidos)
const V1_TO_V2 = {
    '/api/patients':            '/api/v2/patients',
    '/api/doctors':             '/api/v2/doctors',
    '/api/packages':            '/api/v2/packages',
    '/api/payments':            '/api/v2/payments',
    '/api/expenses':            '/api/v2/expenses',
    '/api/cashflow':            '/api/v2/cashflow',
    '/api/financial/dashboard': '/api/v2/financial/dashboard',
    '/api/insurance-guides':    '/api/v2/insurance-guides',
    '/api/pre-agendamento':     '/api/v2/pre-appointments',
    '/api/appointments':        '/api/v2/appointments',
};

// Seguro desligar: GET-only, sem impacto financeiro
const LOW_RISK = new Set([
    '/api/doctors',
    '/api/specialties',
    '/api/reports',
    '/api/financial/dashboard',
    '/api/insurance-guides',
]);

// ─── scanner ──────────────────────────────────────────────────────────────────

function walk(dir, files = []) {
    for (const entry of readdirSync(dir)) {
        const full = join(dir, entry);
        const stat = statSync(full);
        if (stat.isDirectory() && !entry.startsWith('.') && entry !== 'node_modules') {
            walk(full, files);
        } else if (stat.isFile() && EXTENSIONS.has(extname(entry))) {
            files.push(full);
        }
    }
    return files;
}

// Extrai todos os literais de string que contêm /api/
const API_RE = /['"`]([^'"`\s]*\/api\/[^'"`\s]*?)['"`]/g;

function extractApiCalls(content) {
    const hits = [];
    let m;
    while ((m = API_RE.exec(content)) !== null) {
        hits.push(m[1]);
    }
    return hits;
}

function normalizeRoute(raw) {
    // Remove query string e path params dinâmicos: /api/patients/123 → /api/patients
    return raw
        .replace(/\?.*$/, '')
        .replace(/\/\$\{[^}]+\}/g, '/:param')
        .replace(/\/:[^/]+/g, '/:param')
        .replace(/\/[a-f0-9]{24}/gi, '/:id')
        .replace(/\/\d+/g, '/:id');
}

function matchRoute(normalized, routes) {
    return routes.find(r => normalized.startsWith(r)) || null;
}

// ─── main ─────────────────────────────────────────────────────────────────────

const files = walk(FRONT_SRC);

// route → { files: Set, methods: Set (inferred), raw: Set }
const v1Hits  = new Map();
const v2Hits  = new Map();
const unknown = new Map();

for (const file of files) {
    let content;
    try { content = readFileSync(file, 'utf8'); } catch { continue; }

    const relative = file.replace(FRONT_SRC + '/', '');
    const calls = extractApiCalls(content);

    for (const raw of calls) {
        const normalized = normalizeRoute(raw);

        const isV2 = matchRoute(normalized, V2_ROUTES);
        const isV1 = matchRoute(normalized, V1_ROUTES);

        const target = isV2 ? v2Hits : isV1 ? v1Hits : unknown;
        const key = isV2 || isV1 || normalized;

        if (!target.has(key)) target.set(key, { files: new Set(), raw: new Set() });
        target.get(key).files.add(relative);
        target.get(key).raw.add(raw);
    }
}

// ─── report ───────────────────────────────────────────────────────────────────

const lines = [];
const ts = new Date().toISOString().slice(0, 16).replace('T', ' ');

lines.push(`# Audit: Frontend API Usage — ${ts}`);
lines.push('');
lines.push('> Gerado por `back/scripts/audit-frontend-api-usage.js`');
lines.push('');

// ── V1 ainda em uso ──
lines.push('## 🔴 Rotas V1 ainda chamadas pelo frontend');
lines.push('');
lines.push('| Rota V1 | Arquivos | V2 disponível? | Safe to disable? |');
lines.push('|---------|----------|----------------|-----------------|');

const v1Sorted = [...v1Hits.entries()].sort((a, b) => a[0].localeCompare(b[0]));

for (const [route, data] of v1Sorted) {
    const hasV2 = V1_TO_V2[route] ? `✅ \`${V1_TO_V2[route]}\`` : '❌ sem V2';
    const safe = LOW_RISK.has(route) && V1_TO_V2[route] ? '🟢 baixo risco' : '🔴 validar antes';
    const fileList = [...data.files].slice(0, 3).join(', ') + (data.files.size > 3 ? ` +${data.files.size - 3}` : '');
    lines.push(`| \`${route}\` | ${data.files.size} arquivo(s): ${fileList} | ${hasV2} | ${safe} |`);
}

lines.push('');

// ── V2 em uso ──
lines.push('## ✅ Rotas V2 já usadas pelo frontend');
lines.push('');
lines.push('| Rota V2 | Arquivos |');
lines.push('|---------|----------|');

const v2Sorted = [...v2Hits.entries()].sort((a, b) => a[0].localeCompare(b[0]));
for (const [route, data] of v2Sorted) {
    lines.push(`| \`${route}\` | ${data.files.size} |`);
}

lines.push('');

// ── Não identificadas ──
if (unknown.size > 0) {
    lines.push('## ⚪ Chamadas não mapeadas (verificar manualmente)');
    lines.push('');
    lines.push('| Padrão | Arquivos |');
    lines.push('|--------|----------|');
    for (const [route, data] of unknown.entries()) {
        if (route.includes('/api/')) {
            lines.push(`| \`${route}\` | ${data.files.size} |`);
        }
    }
    lines.push('');
}

// ── Resumo ──
lines.push('## 📊 Resumo');
lines.push('');
lines.push(`| | Total |`);
lines.push(`|---|---|`);
lines.push(`| Rotas V1 ainda chamadas | ${v1Hits.size} |`);
lines.push(`| Rotas V2 em uso | ${v2Hits.size} |`);
lines.push(`| Rotas V1 com V2 disponível | ${[...v1Hits.keys()].filter(r => V1_TO_V2[r]).length} |`);
lines.push(`| Safe to disable agora | ${[...v1Hits.keys()].filter(r => LOW_RISK.has(r) && V1_TO_V2[r]).length} |`);
lines.push('');

// ── Checklist de desligamento ──
lines.push('## 🚦 Checklist de desligamento por endpoint');
lines.push('');
for (const [route] of v1Sorted) {
    if (!V1_TO_V2[route]) continue;
    lines.push(`### \`${route}\` → \`${V1_TO_V2[route]}\``);
    lines.push('');
    lines.push('- [ ] Frontend não chama mais esta rota V1');
    lines.push('- [ ] Sem tráfego em produção nos últimos 7 dias');
    lines.push('- [ ] V2 cobre 100% dos endpoints (GET + POST + PATCH + DELETE)');
    lines.push('- [ ] Nenhum worker/cron chama esta rota diretamente');
    lines.push(`- [ ] Comentar no server.js: \`// app.use("${route}", ...)\``);
    lines.push('- [ ] Deploy + monitorar erros por 24h');
    lines.push('');
}

const report = lines.join('\n');
const outPath = join(process.cwd(), 'back/scripts/FRONTEND_API_AUDIT.md');
writeFileSync(outPath, report, 'utf8');

console.log(report);
console.log(`\n✅ Relatório salvo em: ${outPath}`);
