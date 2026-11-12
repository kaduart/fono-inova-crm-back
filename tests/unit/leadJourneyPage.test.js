// Rastreio do site: a página gravada é a do site, nunca a URL da API (12/11/2026).
import { describe, it, expect, vi } from 'vitest';
vi.mock('../../models/Leads.js', () => ({ default: {} }));
const { sitePageFrom } = await import('../../services/leadJourneyService.js');

describe('sitePageFrom', () => {
  it('usa a página do corpo', () => {
    expect(sitePageFrom({ body: { page: '/lp/atraso-na-fala-infantil?utm_source=ig' }, headers: {} })).toBe('/lp/atraso-na-fala-infantil');
  });
  it('sem página no corpo, usa o Referer', () => {
    expect(sitePageFrom({ body: {}, headers: { referer: 'https://www.clinicafonoinova.com.br/fonoaudiologia-anapolis?x=1' } })).toBe('/fonoaudiologia-anapolis');
  });
  it('nunca devolve a URL da API', () => {
    expect(sitePageFrom({ body: {}, headers: {}, originalUrl: '/api/journey/track' })).toBeNull();
  });
});
