/**
 * Busca de jogador (typeahead) do caixa.
 *
 * É o campo mais usado do sistema: numa noite cheia, o operador digita nele
 * centenas de vezes. Três decisões carregam isso:
 *
 * - **Substitui um `<select>` sem mudar a interface.** O `onChange` devolve
 *   um evento sintético `{ target: { name, value } }` para os formulários
 *   existentes continuarem funcionando sem reescrita.
 * - **Teclado completo.** O operador não tira a mão do teclado entre um
 *   jogador e o próximo; obrigar o mouse dobraria o tempo de cada registro.
 * - **Ao focar, o campo esvazia.** Mostrar o nome já escolhido obrigaria a
 *   apagar antes de buscar o próximo.
 */
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import PlayerSelect from './PlayerSelect';
import api from '../config/api';

jest.mock('../config/api', () => ({ __esModule: true, default: { get: jest.fn() } }));
jest.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (chave, padrao) => padrao || chave }),
}));

const JOGADORES = [
  { id: 'p1', name: 'Ana Souza', nickname: 'aninha' },
  { id: 'p2', name: 'Bruno Lima', nickname: null },
  { id: 'p3', name: 'Carlos Dias', nickname: 'cacá' },
];

const montar = async (props = {}) => {
  const aoMudar = jest.fn();
  render(<PlayerSelect onChange={aoMudar} {...props} />);
  await waitFor(() => expect(screen.getByRole('textbox')).not.toBeDisabled());
  return { aoMudar, campo: screen.getByRole('textbox') };
};

beforeEach(() => {
  api.get.mockResolvedValue({ data: JOGADORES });
  jest.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => console.error.mockRestore());

describe('carga', () => {
  it('busca a lista de jogadores', async () => {
    await montar();
    expect(api.get).toHaveBeenCalledWith('/players');
  });

  it('fica desabilitado enquanto carrega', () => {
    api.get.mockReturnValue(new Promise(() => {}));
    render(<PlayerSelect onChange={jest.fn()} />);
    expect(screen.getByRole('textbox')).toBeDisabled();
  });

  it('falha ao carregar deixa o campo utilizável e vazio', async () => {
    // Sem rede, o campo não pode travar a tela do caixa.
    api.get.mockRejectedValue(new Error('sem rede'));
    const { campo } = await montar();
    await userEvent.click(campo);
    expect(screen.getByText('Nenhum jogador encontrado')).toBeInTheDocument();
  });

  it('resposta vazia não quebra', async () => {
    api.get.mockResolvedValue({ data: null });
    const { campo } = await montar();
    await userEvent.click(campo);
    expect(screen.getByText('Nenhum jogador encontrado')).toBeInTheDocument();
  });
});

describe('exibição do escolhido', () => {
  it('mostra nome e apelido do jogador selecionado', async () => {
    await montar({ value: 'p1' });
    expect(screen.getByRole('textbox')).toHaveValue('Ana Souza (aninha)');
  });

  it('jogador sem apelido mostra só o nome', async () => {
    await montar({ value: 'p2' });
    expect(screen.getByRole('textbox')).toHaveValue('Bruno Lima');
  });

  it('sem escolha o campo fica vazio', async () => {
    await montar();
    expect(screen.getByRole('textbox')).toHaveValue('');
  });

  it('focar esvazia o campo para a próxima busca', async () => {
    // Manter o nome anterior obrigaria a apagar antes de digitar o próximo.
    const { campo } = await montar({ value: 'p1' });
    await userEvent.click(campo);
    expect(campo).toHaveValue('');
  });
});

describe('busca', () => {
  it('abre a lista completa ao focar', async () => {
    const { campo } = await montar();
    await userEvent.click(campo);
    expect(screen.getAllByRole('option')).toHaveLength(3);
  });

  it('filtra por nome', async () => {
    const { campo } = await montar();
    await userEvent.click(campo);
    await userEvent.type(campo, 'bru');
    expect(screen.getAllByRole('option')).toHaveLength(1);
    expect(screen.getByRole('option')).toHaveTextContent('Bruno Lima');
  });

  it('filtra por apelido', async () => {
    // O salão chama o jogador pelo apelido; buscar só por nome perderia isso.
    const { campo } = await montar();
    await userEvent.click(campo);
    await userEvent.type(campo, 'aninha');
    expect(screen.getByRole('option')).toHaveTextContent('Ana Souza');
  });

  it('ignora maiúsculas e minúsculas', async () => {
    const { campo } = await montar();
    await userEvent.click(campo);
    await userEvent.type(campo, 'ANA');
    expect(screen.getByRole('option')).toHaveTextContent('Ana Souza');
  });

  it('jogador sem apelido não quebra o filtro', async () => {
    // `nickname` nulo comparado com `.includes` estouraria.
    const { campo } = await montar();
    await userEvent.click(campo);
    await userEvent.type(campo, 'lima');
    expect(screen.getByRole('option')).toHaveTextContent('Bruno Lima');
  });

  it('sem resultado avisa em vez de mostrar lista vazia', async () => {
    const { campo } = await montar();
    await userEvent.click(campo);
    await userEvent.type(campo, 'zzzz');
    expect(screen.getByText('Nenhum jogador encontrado')).toBeInTheDocument();
  });
});

describe('seleção', () => {
  it('clicar devolve o evento no formato de um select', async () => {
    // É o que mantém os formulários antigos funcionando sem reescrita.
    const { aoMudar, campo } = await montar({ name: 'player_id' });
    await userEvent.click(campo);
    await userEvent.click(screen.getByRole('option', { name: /Bruno/ }));
    expect(aoMudar).toHaveBeenCalledWith({
      target: { name: 'player_id', value: 'p2' },
    });
  });

  it('escolher fecha a lista', async () => {
    const { campo } = await montar();
    await userEvent.click(campo);
    await userEvent.click(screen.getByRole('option', { name: /Ana/ }));
    expect(screen.queryByRole('listbox')).toBeNull();
  });

  it('marca o jogador já escolhido na lista', async () => {
    const { campo } = await montar({ value: 'p3' });
    await userEvent.click(campo);
    expect(screen.getByRole('option', { selected: true })).toHaveTextContent('Carlos Dias');
  });

  it('clicar fora fecha a lista', async () => {
    render(
      <div>
        <PlayerSelect onChange={jest.fn()} />
        <span data-testid="fora">fora</span>
      </div>
    );
    await waitFor(() => expect(screen.getByRole('textbox')).not.toBeDisabled());
    await userEvent.click(screen.getByRole('textbox'));
    expect(screen.getByRole('listbox')).toBeInTheDocument();
    await userEvent.click(screen.getByTestId('fora'));
    expect(screen.queryByRole('listbox')).toBeNull();
  });
});

describe('teclado', () => {
  it('seta para baixo abre a lista', async () => {
    const { campo } = await montar();
    campo.focus();
    await userEvent.keyboard('{Escape}');
    await userEvent.keyboard('{ArrowDown}');
    expect(screen.getByRole('listbox')).toBeInTheDocument();
  });

  it('navega e escolhe sem tirar a mão do teclado', async () => {
    // É o que sustenta o ritmo do caixa numa noite cheia.
    const { aoMudar, campo } = await montar();
    await userEvent.click(campo);
    await userEvent.keyboard('{ArrowDown}{Enter}');
    expect(aoMudar).toHaveBeenCalledWith({
      target: { name: 'player_id', value: 'p2' },
    });
  });

  it('seta para cima volta na lista', async () => {
    const { aoMudar, campo } = await montar();
    await userEvent.click(campo);
    await userEvent.keyboard('{ArrowDown}{ArrowDown}{ArrowUp}{Enter}');
    expect(aoMudar).toHaveBeenCalledWith(
      expect.objectContaining({ target: expect.objectContaining({ value: 'p2' }) })
    );
  });

  it('não passa do último item', async () => {
    const { aoMudar, campo } = await montar();
    await userEvent.click(campo);
    await userEvent.keyboard('{ArrowDown}{ArrowDown}{ArrowDown}{ArrowDown}{Enter}');
    expect(aoMudar).toHaveBeenCalledWith(
      expect.objectContaining({ target: expect.objectContaining({ value: 'p3' }) })
    );
  });

  it('não sobe além do primeiro item', async () => {
    const { aoMudar, campo } = await montar();
    await userEvent.click(campo);
    await userEvent.keyboard('{ArrowUp}{ArrowUp}{Enter}');
    expect(aoMudar).toHaveBeenCalledWith(
      expect.objectContaining({ target: expect.objectContaining({ value: 'p1' }) })
    );
  });

  it('Esc fecha sem escolher', async () => {
    const { aoMudar, campo } = await montar();
    await userEvent.click(campo);
    await userEvent.keyboard('{Escape}');
    expect(screen.queryByRole('listbox')).toBeNull();
    expect(aoMudar).not.toHaveBeenCalled();
  });

  it('Enter com a lista vazia não escolhe ninguém', async () => {
    // Sem a guarda, o índice cairia num item inexistente e estouraria.
    const { aoMudar, campo } = await montar();
    await userEvent.click(campo);
    await userEvent.type(campo, 'zzzz');
    await userEvent.keyboard('{Enter}');
    expect(aoMudar).not.toHaveBeenCalled();
  });

  it('digitar reinicia a seleção no primeiro resultado', async () => {
    // Sem reiniciar, o índice apontaria para a posição da busca anterior e o
    // Enter escolheria o jogador errado.
    const { aoMudar, campo } = await montar();
    await userEvent.click(campo);
    await userEvent.keyboard('{ArrowDown}{ArrowDown}');
    await userEvent.type(campo, 'ana');
    await userEvent.keyboard('{Enter}');
    expect(aoMudar).toHaveBeenCalledWith(
      expect.objectContaining({ target: expect.objectContaining({ value: 'p1' }) })
    );
  });
});

describe('acessibilidade', () => {
  it('informa se está aberto', async () => {
    const { campo } = await montar();
    expect(campo).toHaveAttribute('aria-expanded', 'false');
    await userEvent.click(campo);
    expect(campo).toHaveAttribute('aria-expanded', 'true');
  });

  it('propaga a obrigatoriedade', async () => {
    await montar({ required: true });
    expect(screen.getByRole('textbox')).toHaveAttribute('aria-required', 'true');
  });
});
