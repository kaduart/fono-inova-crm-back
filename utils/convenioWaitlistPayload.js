// utils/convenioWaitlistPayload.js
// Validação/normalização do cadastro público de lista de espera (sem acesso a banco, fácil de testar).
import { CONVENIOS_WAITLIST } from '../constants/convenioWaitlist.js';
import { validateE164 } from './phone.js';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const clean = (value, max) => {
    if (value === undefined || value === null) return null;
    const text = String(value).trim().replace(/\s+/g, ' ');
    return text ? text.slice(0, max) : null;
};

export function parseWaitlistPayload(body) {
    const data = body && typeof body === 'object' ? body : {};

    const convenio = String(data.convenio || '').trim().toLowerCase();
    if (!CONVENIOS_WAITLIST.includes(convenio)) {
        return { ok: false, message: 'Convênio inválido' };
    }

    const name = clean(data.nome, 120);
    if (!name || name.length < 3) {
        return { ok: false, message: 'Nome inválido' };
    }

    const phoneCheck = validateE164(data.telefone);
    if (!phoneCheck.valid) {
        return { ok: false, message: 'Telefone inválido' };
    }

    const email = clean(data.email, 160);
    if (email && !EMAIL_RE.test(email)) {
        return { ok: false, message: 'E-mail inválido' };
    }

    const ageRaw = data.idadeCrianca === '' || data.idadeCrianca == null ? null : Number(data.idadeCrianca);
    const idadeCrianca = Number.isFinite(ageRaw) && ageRaw >= 0 && ageRaw <= 18 ? Math.floor(ageRaw) : null;

    const origem = data.origem && typeof data.origem === 'object' ? data.origem : {};
    const contexto = data.contexto && typeof data.contexto === 'object' ? data.contexto : {};
    const device = data.device && typeof data.device === 'object' ? data.device : {};
    const ga4 = data.ga4 && typeof data.ga4 === 'object' ? data.ga4 : {};

    return {
        ok: true,
        value: {
            name,
            phone: phoneCheck.normalized,
            email: email ? email.toLowerCase() : null,
            convenio,
            especialidade: clean(data.especialidade, 80),
            idadeCrianca,
            periodo: clean(data.periodo, 40),
            source: {
                pagePath: clean(contexto.pagePath, 200),
                utmSource: clean(origem.source, 80),
                utmMedium: clean(origem.medium, 80),
                utmCampaign: clean(origem.campaign, 120),
                referrer: clean(origem.referrer, 300),
                deviceType: clean(device.type, 20),
                ga4ClientId: clean(ga4.clientId, 80),
            },
        },
    };
}

export default parseWaitlistPayload;
