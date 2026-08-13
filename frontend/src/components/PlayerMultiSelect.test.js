/**
 * Seleção de VÁRIOS jogadores — usada na emissão de ticket em lote.
 *
 * Cada jogador marcado aqui vira uma entrada JÁ PAGA no torneio-destino. Duas
 * decisões seguram isso:
 *
 * - **Os escolhidos ficam sempre à vista, em fichas removíveis.** O operador
 *   confere nome por nome antes de confirmar; uma contagem sozinha não deixa
 *   ver que entrou o jogador errado.
 * - **Clicar de novo desmarca.** Sem isso, corrigir um clique errado exigiria
 *   fechar o modal e começar de novo.
 */
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import PlayerMultiSelect from './PlayerMultiSelect';
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
  render(<PlayerMultiSelect onChange={aoMudar} {...props} />);
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

  it('falha de rede não trava o modal', async () => {
    api.get.mockRejectedValue(new Error('sem rede'));
    const { campo } = await montar();
    await userEvent.click(campo);
    expect(screen.getByText('Nenhum jogador encontrado')).toBeInTheDocument();
  });
});

describe('seleção', () => {
  it('marcar acrescenta o jogador à lista', async () => {
    const { aoMudar, campo } = await montar({ values: [] });
    await userEvent.click(campo);
    await userEvent.click(screen.getByRole('option', { name: /Bruno/ }));
    expect(aoMudar).toHaveBeenCalledWith(['p2']);
  });

  it('marcar mantém os já escolhidos', async () => {
    const { aoMudar, campo } = await montar({ values: ['p1'] });
    await userEvent.click(campo);
    await userEvent.click(screen.getByRole('option', { name: /Carlos/ }));
    expect(aoMudar).toHaveBeenCalledWith(['p1', 'p3']);
  });

  it('clicar de novo desmarca', async () => {
    const { aoMudar, campo } = await montar({ values: ['p1', 'p2'] });
    await userEvent.click(campo);
    await userEvent.click(screen.getByRole('option', { name: /Ana/ }));
    expect(aoMudar).toHaveBeenCalledWith(['p2']);
  });

  it('a lista continua aberta para marcar o próximo', async () => {
    // Fechar a cada clique tornaria inviável escolher 20 classificados.
    const { campo } = await montar({ values: [] });
    await userEvent.click(campo);
    await userEvent.click(screen.getByRole('option', { name: /Ana/ }));
    expect(screen.getByRole('listbox')).toBeInTheDocument();
  });

  it('o já escolhido aparece marcado na lista', async () => {
    const { campo } = await montar({ values: ['p3'] });
    await userEvent.click(campo);
    expect(screen.getByRole('option', { selected: true })).toHaveTextContent('Carlos Dias');
  });

  it('clicar fora fecha a lista', async () => {
    render(
      <div>
        <PlayerMultiSelect values={[]} onChange={jest.fn()} />
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

describe('fichas dos escolhidos', () => {
  it('mostra nome e apelido de cada escolhido', async () => {
    await montar({ values: ['p1', 'p2'] });
    const fichas = document.querySelectorAll('.pms-chip');
    expect(fichas).toHaveLength(2);
    expect(fichas[0]).toHaveTextContent('Ana Souza (aninha)');
    expect(fichas[1]).toHaveTextContent('Bruno Lima');
  });

  it('remover a ficha tira o jogador do lote', async () => {
    const { aoMudar } = await montar({ values: ['p1', 'p2'] });
    await userEvent.click(screen.getAllByRole('button', { name: 'Remover jogador' })[0]);
    expect(aoMudar).toHaveBeenCalledWith(['p2']);
  });

  it('sem ninguém escolhido não há fichas', async () => {
    await montar({ values: [] });
    expect(document.querySelector('.pms-chips')).toBeNull();
  });

  it('id sem jogador correspondente ainda aparece', async () => {
    // Some da tela seria pior: o operador acharia que já removeu.
    await montar({ values: ['fantasma'] });
    expect(document.querySelector('.pms-chip')).toHaveTextContent('fantasma');
  });
});

describe('busca', () => {
  it('filtra por nome', async () => {
    const { campo } = await montar({ values: [] });
    await userEvent.click(campo);
    await userEvent.type(campo, 'bru');
    expect(screen.getAllByRole('option')).toHaveLength(1);
  });

  it('filtra por apelido', async () => {
    // O salão chama o jogador pelo apelido.
    const { campo } = await montar({ values: [] });
    await userEvent.click(campo);
    await userEvent.type(campo, 'cacá');
    expect(screen.getByRole('option')).toHaveTextContent('Carlos Dias');
  });

  it('jogador sem apelido não quebra o filtro', async () => {
    const { campo } = await montar({ values: [] });
    await userEvent.click(campo);
    await userEvent.type(campo, 'lima');
    expect(screen.getByRole('option')).toHaveTextContent('Bruno Lima');
  });
});

describe('envio em andamento', () => {
  it('desabilitado não deixa mexer no lote', async () => {
    const aoMudar = jest.fn();
    render(<PlayerMultiSelect values={['p1']} onChange={aoMudar} disabled />);
    await waitFor(() => expect(document.querySelector('.pms-chip')).toBeTruthy());
    await userEvent.click(screen.getByRole('button', { name: 'Remover jogador' }));
    expect(aoMudar).not.toHaveBeenCalled();
  });
});
