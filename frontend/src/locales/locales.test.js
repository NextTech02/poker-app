/**
 * PARIDADE dos três idiomas.
 *
 * Os arquivos são mantidos alinhados linha a linha, mas nada travava isso:
 * uma chave adicionada só no pt-BR caía no fallback em silêncio e o clube em
 * Lima via a frase em português. Este teste falha na hora, apontando a chave.
 */
import ptBR from './pt-BR.json';
import enUS from './en-US.json';
import esES from './es-ES.json';

const chaves = (obj, prefixo = '') => Object.entries(obj).flatMap(([k, v]) => (
  v && typeof v === 'object' && !Array.isArray(v) ? chaves(v, `${prefixo}${k}.`) : [`${prefixo}${k}`]
));

const faltando = (base, outro) => {
  const tem = new Set(chaves(outro));
  return chaves(base).filter((k) => !tem.has(k));
};

it('en-US tem todas as chaves do pt-BR (e nenhuma a mais)', () => {
  expect(faltando(ptBR, enUS)).toEqual([]);
  expect(faltando(enUS, ptBR)).toEqual([]);
});

it('es-ES tem todas as chaves do pt-BR (e nenhuma a mais)', () => {
  expect(faltando(ptBR, esES)).toEqual([]);
  expect(faltando(esES, ptBR)).toEqual([]);
});

it('as chaves interpoladas usam os mesmos nomes nos três idiomas', () => {
  // `{{count}}` no pt e `{{quantidade}}` no es é o bug que não aparece em
  // teste nenhum: a frase traduzida sai com o marcador cru.
  const marcadores = (s) => (String(s).match(/\{\{\w+\}\}/g) || []).sort().join(',');
  const achatar = (obj, prefixo = '') => Object.entries(obj).reduce((acc, [k, v]) => {
    if (v && typeof v === 'object') return { ...acc, ...achatar(v, `${prefixo}${k}.`) };
    return { ...acc, [`${prefixo}${k}`]: v };
  }, {});
  const pt = achatar(ptBR); const en = achatar(enUS); const es = achatar(esES);
  const divergentes = Object.keys(pt).filter((k) => (
    marcadores(pt[k]) !== marcadores(en[k]) || marcadores(pt[k]) !== marcadores(es[k])
  ));
  expect(divergentes).toEqual([]);
});
