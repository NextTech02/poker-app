/**
 * Editor dos meios de entrada do TORNEIO.
 *
 * O que o cliente pediu e os testes guardam: "Adicionar entrada" cria uma
 * linha em branco com rake 20% (editável); "Remover" tira a linha, mas nunca a
 * última da categoria Entrada — sem ela não há como inscrever ninguém.
 */
import { useState } from 'react';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import EntryTypesEditor from './EntryTypesEditor';
import { meiosPadrao, novaLinha } from '../utils/entryTypes';

jest.mock('react-i18next', () => {
  // Interpola {{var}} como o i18next de verdade: o nome acessível do botão de
  // remover CARREGA o nome do meio de entrada.
  const t = (chave, segundo, terceiro) => {
    const padrao = typeof segundo === 'string' ? segundo : chave;
    const vars = typeof segundo === 'string' ? terceiro : segundo;
    if (!vars) return padrao;
    return padrao.replace(/\{\{(\w+)\}\}/g, (bruto, nome) =>
      vars[nome] === undefined ? bruto : String(vars[nome])
    );
  };
  const traducao = { t, i18n: { language: 'pt-BR' } };
  return { useTranslation: () => traducao };
});

const t = (chave, padrao) => padrao || chave;

// Controlado de verdade: quem usa guarda as linhas e devolve a lista nova.
const Harness = ({ inicial, aoMudar = () => {}, ...props }) => {
  const [linhas, setLinhas] = useState(inicial);
  return (
    <EntryTypesEditor
      linhas={linhas}
      onChange={(novas) => { aoMudar(novas); setLinhas(novas); }}
      currency="BRL"
      {...props}
    />
  );
};

const linhas = () => Array.from(document.querySelectorAll('.entry-method-row'));
const linha = (indice) => {
  const raiz = linhas()[indice];
  const numeros = raiz.querySelectorAll('input[type="number"]');
  return {
    nome: raiz.querySelector('input[type="text"]'),
    valor: numeros[0],
    rake: numeros[1],
    fichas: numeros[2],
    categoria: raiz.querySelector('select'),
    remover: raiz.querySelector('button'),
  };
};
const adicionar = () => userEvent.click(screen.getByRole('button', { name: 'Adicionar entrada' }));

describe('linhas', () => {
  it('mostra as linhas recebidas, na ordem', () => {
    render(<Harness inicial={meiosPadrao(t)} />);
    expect(linhas()).toHaveLength(3);
    expect([0, 1, 2].map((i) => linha(i).categoria.value)).toEqual(['buy_in', 'rebuy', 'addon']);
    expect(linha(0).nome).toHaveValue('Buy-in');
  });

  it('o rake padrão de cada linha nova é 20%, e dá para editar', async () => {
    render(<Harness inicial={meiosPadrao(t)} />);
    expect(linha(0).rake).toHaveValue(20);
    await userEvent.clear(linha(0).rake);
    await userEvent.type(linha(0).rake, '15');
    expect(linha(0).rake).toHaveValue(15);
  });

  it('digitar num campo devolve a lista atualizada', async () => {
    const aoMudar = jest.fn();
    render(<Harness inicial={meiosPadrao(t)} aoMudar={aoMudar} />);
    await userEvent.type(linha(0).nome, ' VIP');
    const ultima = aoMudar.mock.calls.at(-1)[0];
    expect(ultima[0].name).toBe('Buy-in VIP');
    expect(ultima).toHaveLength(3);
  });
});

describe('adicionar entrada', () => {
  it('acrescenta uma linha em branco, com rake 20, sem opção pré-pronta', async () => {
    // "Buy-in duplo" é algo que o clube CADASTRA, não um item de menu.
    render(<Harness inicial={meiosPadrao(t)} />);
    await adicionar();
    expect(linhas()).toHaveLength(4);
    expect(linha(3).nome).toHaveValue('');
    expect(linha(3).valor).toHaveValue(null);
    expect(linha(3).rake).toHaveValue(20);
    expect(linha(3).categoria).toHaveValue('buy_in');
  });
});

describe('remover', () => {
  it('tira a linha da lista', async () => {
    render(<Harness inicial={meiosPadrao(t)} />);
    await userEvent.click(linha(2).remover);
    expect(linhas()).toHaveLength(2);
  });

  it('não deixa ficar sem NENHUM meio de Entrada', async () => {
    // Sem meio da categoria "Entrada" não há como inscrever jogador — o
    // operador descobriria isso no Caixa, com o clube cheio.
    const aoMudar = jest.fn();
    render(<Harness inicial={meiosPadrao(t)} aoMudar={aoMudar} />);
    await userEvent.click(linha(0).remover);
    expect(linhas()).toHaveLength(3);
    expect(aoMudar).not.toHaveBeenCalled();
    expect(screen.getByRole('alert')).toHaveTextContent(/ao menos um meio de entrada/i);
  });

  it('com dois meios de Entrada, dá para remover um', async () => {
    render(<Harness inicial={meiosPadrao(t)} />);
    await adicionar(); // nasce como "Entrada"
    await userEvent.click(linha(0).remover);
    expect(linhas().filter((_, i) => linha(i).categoria.value === 'buy_in')).toHaveLength(1);
  });

  it('a recusa some assim que o operador mexe em alguma coisa', async () => {
    render(<Harness inicial={meiosPadrao(t)} />);
    await userEvent.click(linha(0).remover);
    expect(screen.getByRole('alert')).toBeInTheDocument();
    await userEvent.type(linha(0).nome, 'x');
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('com onErro, a recusa sobe para quem usa em vez de ficar aqui', async () => {
    const onErro = jest.fn();
    render(<Harness inicial={meiosPadrao(t)} erro="" onErro={onErro} />);
    await userEvent.click(linha(0).remover);
    expect(onErro).toHaveBeenCalledWith(expect.stringMatching(/ao menos um meio de entrada/i));
    // Quem guarda a mensagem é o pai: sem ele devolver em `erro`, nada aparece.
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('o botão de remover diz QUAL meio remove', () => {
    // Seis botões chamados só "Remover" não dizem nada a quem usa leitor de tela.
    render(<Harness inicial={meiosPadrao(t)} />);
    expect(screen.getByRole('button', { name: 'Remover meio de entrada Buy-in' })).toBeInTheDocument();
  });

  it('linha sem nome é anunciada como "sem nome"', () => {
    render(<Harness inicial={[novaLinha({ name: '' })]} />);
    expect(screen.getByRole('button', { name: 'Remover meio de entrada sem nome' })).toBeInTheDocument();
  });
});

describe('aviso e acessibilidade', () => {
  it('o erro de quem valida ao salvar aparece no mesmo aviso', () => {
    render(<Harness inicial={meiosPadrao(t)} erro="Dê um nome a cada meio de entrada." />);
    expect(screen.getByRole('alert')).toHaveTextContent('Dê um nome a cada meio de entrada.');
  });

  it('a dica da categoria aparece uma vez e vale para todas as linhas', () => {
    // Repetir a explicação em cada linha viraria ruído; o aria-describedby liga
    // todos os selects ao mesmo texto. O prefixo evita id duplicado quando há
    // dois editores na mesma página.
    render(<Harness inicial={meiosPadrao(t)} idPrefix="tr-entry" />);
    expect(document.querySelectorAll('#tr-entry_category_hint')).toHaveLength(1);
    [0, 1, 2].forEach((i) =>
      expect(linha(i).categoria).toHaveAttribute('aria-describedby', 'tr-entry_category_hint')
    );
  });

  it('desabilitado, nada se edita nem se remove', () => {
    render(<Harness inicial={meiosPadrao(t)} disabled />);
    expect(linha(0).nome).toBeDisabled();
    expect(linha(0).remover).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Adicionar entrada' })).toBeDisabled();
  });
});

describe('categoria Taxa', () => {
  it('a Taxa é uma das categorias, com fichas e rake editáveis como as outras', async () => {
    const aoMudar = jest.fn();
    render(<Harness inicial={meiosPadrao(t)} aoMudar={aoMudar} />);
    const opcoes = Array.from(linha(2).categoria.querySelectorAll('option')).map((o) => o.value);
    expect(opcoes).toEqual(['buy_in', 'rebuy', 'addon', 'fee']);
    await userEvent.selectOptions(linha(2).categoria, 'fee');
    expect(linha(2).categoria).toHaveValue('fee');
    expect(linha(2).rake).toBeEnabled();
    expect(linha(2).fichas).toBeEnabled();
    expect(aoMudar).toHaveBeenLastCalledWith(expect.arrayContaining([expect.objectContaining({ category: 'fee' })]));
  });
});
