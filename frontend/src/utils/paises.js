import countries from '../data/countries';

/**
 * Nome do país no idioma da tela.
 *
 * O cadastro guarda o nome em PORTUGUÊS (é o valor que já está no banco e que a
 * importação escreve); aqui muda só o rótulo. O código do país sai do próprio
 * navegador (`Intl.DisplayNames`), e o nome que ele não reconhece fica como está.
 */
const A = 'A'.charCodeAt(0);
let codigoPorNome = null;

const nomesEm = (idioma) => new Intl.DisplayNames([idioma], { type: 'region', fallback: 'none' });

const codigos = () => {
  if (codigoPorNome) return codigoPorNome;
  codigoPorNome = new Map();
  try {
    const pt = nomesEm('pt-BR');
    for (let i = 0; i < 26 * 26; i += 1) {
      const codigo = String.fromCharCode(A + Math.floor(i / 26), A + (i % 26));
      const nome = pt.of(codigo);
      if (nome && !codigoPorNome.has(nome.toLowerCase())) codigoPorNome.set(nome.toLowerCase(), codigo);
    }
  } catch (_) {
    /* navegador sem Intl.DisplayNames: ficam os nomes em português */
  }
  return codigoPorNome;
};

export const nomeDoPais = (nome, idioma) => {
  if (!nome || !idioma || idioma.startsWith('pt')) return nome;
  const codigo = codigos().get(String(nome).toLowerCase());
  if (!codigo) return nome;
  try {
    return nomesEm(idioma).of(codigo) || nome;
  } catch (_) {
    return nome;
  }
};

/** [{ valor, rotulo }] na ordem alfabética do idioma da tela. */
export const paisesNoIdioma = (idioma) => countries
  .map((valor) => ({ valor, rotulo: nomeDoPais(valor, idioma) }))
  .sort((a, b) => a.rotulo.localeCompare(b.rotulo, idioma || 'pt-BR'));
