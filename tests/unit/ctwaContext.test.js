/**
 * 18/11/2026: o ctwaContext do WhatsApp Web chega sem chave "ctwaClid"; o clid vem dentro de
 * ctwaSignals / conversionData / externalAdReply. Antes o clid nunca era salvo.
 */
import { describe, it, expect } from 'vitest';
import { extractCtwa, describeCtwaShape } from '../../utils/ctwaContext.js';

const CLID = 'ARAkLkA8rmlFeiCktEJQ-QTwRmyU9y4';
const bytesObj = (str) => Object.fromEntries([...Buffer.from(str, 'utf8')].map((b, i) => [String(i), b]));

describe('extractCtwa', () => {
  it('sem anúncio devolve null', () => {
    expect(extractCtwa(null)).toBeNull();
    expect(extractCtwa({ conversionSource: 'x' })).toBeNull();
  });

  it('chave direta ctwaClid', () => {
    const r = extractCtwa({ sourceId: '120', sourceUrl: 'https://fb.me/x', ctwaClid: CLID });
    expect(r).toMatchObject({ sourceId: '120', ctwaClid: CLID, clidFrom: 'ctwaContext.ctwaClid' });
  });

  it('ctwaSignals em JSON', () => {
    const r = extractCtwa({ sourceId: '120', ctwaSignals: JSON.stringify({ ctwa_clid: CLID, foo: 1 }) });
    expect(r.ctwaClid).toBe(CLID);
    expect(r.clidFrom).toBe('ctwaSignals');
  });

  it('conversionData em bytes serializados pelo puppeteer ({0:..,1:..})', () => {
    const r = extractCtwa({ sourceId: '120', conversionData: bytesObj(`{"ctwa_clid":"${CLID}"}`) });
    expect(r.ctwaClid).toBe(CLID);
    expect(r.clidFrom).toBe('conversionData');
  });

  it('conversionData em base64 com "ctwa_clid=..."', () => {
    const b64 = Buffer.from(`src=ad&ctwa_clid=${CLID}&x=1`).toString('base64');
    expect(extractCtwa({ sourceUrl: 'https://instagram.com/p/x', conversionData: b64 }).ctwaClid).toBe(CLID);
  });

  it('externalAdReply.ctwaClid da mensagem', () => {
    const r = extractCtwa({ sourceId: '120' }, { contextInfo: { externalAdReply: { ctwaClid: CLID } } });
    expect(r.ctwaClid).toBe(CLID);
    expect(r.clidFrom).toBe('externalAdReply.ctwaClid');
  });

  it('anúncio sem clid continua com sourceId/sourceUrl (vira Meta Ads)', () => {
    const r = extractCtwa({ sourceId: '120251066022110554', sourceUrl: 'https://www.instagram.com/p/abc/', title: 'GEAP', ctwaSignals: 'abc' });
    expect(r).toMatchObject({ sourceId: '120251066022110554', ctwaClid: null, title: 'GEAP' });
  });

  it('não confunde texto qualquer com clid', () => {
    expect(extractCtwa({ sourceId: '1', ctwaSignals: 'clid curto' }).ctwaClid).toBeNull();
  });
});

describe('describeCtwaShape', () => {
  it('mostra tipos e tamanhos, nunca valores', () => {
    const shape = describeCtwaShape({ sourceId: '120', ctwaSignals: JSON.stringify({ ctwa_clid: CLID }), conversionData: bytesObj('abc') });
    const txt = JSON.stringify(shape);
    expect(txt).not.toContain(CLID);
    expect(txt).not.toContain('120');
    expect(shape.conversionData).toBe('bytes(3)');
    expect(shape.ctwaSignals).toEqual({ json: { ctwa_clid: `string(${CLID.length})` } });
  });
});
