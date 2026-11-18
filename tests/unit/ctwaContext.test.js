/**
 * 18/11/2026: o ctwaContext do WhatsApp Web chega sem chave "ctwaClid"; o clid vem dentro de
 * ctwaSignals / conversionData / externalAdReply. Antes o clid nunca era salvo.
 */
import { describe, it, expect } from 'vitest';
import { extractCtwa, describeCtwaShape, clidLogInfo } from '../../utils/ctwaContext.js';

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
    expect(shape.conversionData).toEqual({ bytes: 3, textos: [] });
    expect(shape.ctwaSignals).toEqual({ json: { ctwa_clid: `string(${CLID.length})` } });
  });
});

describe('describeCtwaShape com bytes lidos na página (base64)', () => {
  it('mostra tamanho e trechos legíveis sem o conteúdo', () => {
    const CLID2 = 'ARAkLkA8rmlFeiCktEJQ-QTwRmyU9y4';
    const proto = Buffer.concat([Buffer.from([0x0a, CLID2.length]), Buffer.from(CLID2), Buffer.from([0x12, 3, 1, 2, 3])]);
    const shape = describeCtwaShape({ conversionData: proto.toString('base64'), ctwaSignals: 'abc' });
    expect(JSON.stringify(shape)).not.toContain(CLID2);
    expect(shape.conversionData).toEqual({ base64: { bytes: proto.length, textos: [`id(${CLID2.length})`] } });
  });
});

// 18/11 (log em prod após o #81): conversionData = 451 bytes que são, inteiros, um código sem rótulo.
describe('conversionData como código único', () => {
  const TOKEN = 'AR' + 'aB3_-x9'.repeat(70).slice(0, 449);

  it('base64 vindo da página → clid = o código decodificado', () => {
    const r = extractCtwa({ sourceId: '120', conversionData: Buffer.from(TOKEN).toString('base64'), ctwaSignals: 'abcdefg' });
    expect(r.ctwaClid).toBe(TOKEN);
    expect(r.clidFrom).toBe('conversionData(código)');
    expect(clidLogInfo(r.ctwaClid)).toBe('451, AR=sim');
  });

  it('bytes serializados → mesmo resultado', () => {
    expect(extractCtwa({ sourceId: '120', conversionData: bytesObj(TOKEN) }).ctwaClid).toBe(TOKEN);
  });

  it('rótulo explícito continua tendo prioridade', () => {
    const r = extractCtwa({ sourceId: '120', ctwaClid: CLID, conversionData: Buffer.from(TOKEN).toString('base64') });
    expect(r.ctwaClid).toBe(CLID);
  });

  it('binário não textual ou curto não vira clid', () => {
    expect(extractCtwa({ sourceId: '120', conversionData: Buffer.from([0, 1, 2, 200, 15, 99, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17]).toString('base64') }).ctwaClid).toBeNull();
    expect(extractCtwa({ sourceId: '120', conversionData: Buffer.from('curto').toString('base64') }).ctwaClid).toBeNull();
    expect(clidLogInfo(null)).toBeNull();
  });
});
