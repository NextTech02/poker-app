/**
 * Telas de configuração: formas de pagamento.
 *
 * Ela alimenta o Caixa, e o risco central é **o que está gravado nas
 * transações antigas não pode ser reescrito nem perdido**.
 *
 * - Formas de pagamento embutidas (dinheiro, pix, cartão) não são editáveis:
 *   elas traduzem com o idioma do app, e deixar o clube renomear "Pix" para
 *   "PIX BB" quebraria a tradução das outras línguas.
 * - Desativar é diferente de excluir. Desativar tira do dropdown do caixa
 *   mas mantém o rótulo do histórico; excluir é definitivo e por isso passa
 *   por confirmação com variante de perigo.
 *
 * Os meios de entrada saíram daqui: deixaram de ser configuração da ETAPA e
 * passaram a pertencer ao DIA do torneio, com nome, valor, rake e fichas
 * próprios — a tela deles vive no cadastro do dia.
 */
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import PaymentMethodsManager from './PaymentMethodsManager';
import { usePaymentMethods } from '../contexts/PaymentMethodsContext';
import { useToast } from '../contexts/ToastContext';

jest.mock('../contexts/PaymentMethodsContext', () => ({ usePaymentMethods: jest.fn() }));
jest.mock('../contexts/ToastContext', () => ({ useToast: jest.fn() }));
jest.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (chave, padrao) => padrao || chave }),
}));

let toast;
let confirmar;

beforeEach(() => {
  toast = { success: jest.fn(), error: jest.fn(), warning: jest.fn() };
  confirmar = jest.fn().mockResolvedValue(true);
  useToast.mockReturnValue({ toast, confirm: confirmar });
});

describe('PaymentMethodsManager', () => {
  const METODOS = [
    { id: 'm1', code: 'cash', label: 'Dinheiro', active: true },
    { id: 'm2', code: 'yape', label: 'Yape', active: true },
    { id: 'm3', code: 'nequi', label: 'Nequi', active: false },
  ];

  const montar = (extra = {}) => {
    const api = {
      methods: METODOS,
      loading: false,
      createMethod: jest.fn().mockResolvedValue(undefined),
      updateMethod: jest.fn().mockResolvedValue(undefined),
      deleteMethod: jest.fn().mockResolvedValue(undefined),
      ...extra,
    };
    usePaymentMethods.mockReturnValue(api);
    render(<PaymentMethodsManager />);
    return api;
  };

  it('lista os métodos cadastrados', () => {
    montar();
    expect(screen.getByText('Yape')).toBeInTheDocument();
    expect(screen.getByText('Nequi')).toBeInTheDocument();
  });

  it('mostra o carregamento', () => {
    montar({ loading: true, methods: [] });
    expect(screen.getByText('Carregando...')).toBeInTheDocument();
  });

  it('sem método nenhum avisa', () => {
    montar({ methods: [] });
    expect(screen.getByText('Nenhum método cadastrado.')).toBeInTheDocument();
  });

  it('método embutido não é editável', () => {
    // O rótulo vem do i18n; renomear "Pix" quebraria a tradução nas outras
    // línguas do app.
    montar();
    expect(screen.getByText('padrão')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Dinheiro' })).toBeNull();
  });

  it('método do clube é editável', () => {
    montar();
    expect(screen.getByRole('button', { name: 'Yape' })).toBeInTheDocument();
  });

  it('adiciona um método novo', async () => {
    const api = montar();
    await userEvent.type(screen.getByRole('textbox'), 'Nubank');
    await userEvent.click(screen.getByRole('button', { name: /Adicionar/ }));
    await waitFor(() => expect(api.createMethod).toHaveBeenCalledWith('Nubank'));
    expect(toast.success).toHaveBeenCalled();
  });

  it('o campo de novo método tem rótulo associado', () => {
    // Sem associação (htmlFor/id) o rótulo é só enfeite: o leitor de tela não
    // anuncia o campo e o clique no texto não foca.
    montar();
    expect(screen.getByLabelText('Nome')).toBe(screen.getByRole('textbox'));
  });

  it('o botão de adicionar fica travado sem nome', () => {
    // Um método sem rótulo não teria como ser reconhecido no dropdown.
    montar();
    expect(screen.getByRole('button', { name: /Adicionar/ })).toBeDisabled();
  });

  it('falha ao adicionar avisa e libera o formulário', async () => {
    const api = montar({
      createMethod: jest.fn().mockRejectedValue(new Error('duplicado')),
    });
    await userEvent.type(screen.getByRole('textbox'), 'X');
    await userEvent.click(screen.getByRole('button', { name: /Adicionar/ }));
    await waitFor(() => expect(toast.error).toHaveBeenCalled());
    expect(api.createMethod).toHaveBeenCalled();
  });

  it('renomear grava o novo rótulo', async () => {
    const api = montar();
    await userEvent.click(screen.getByRole('button', { name: 'Yape' }));
    const campo = screen.getByDisplayValue('Yape');
    await userEvent.clear(campo);
    await userEvent.type(campo, 'Yape Perú{Enter}');
    await waitFor(() =>
      expect(api.updateMethod).toHaveBeenCalledWith('m2', { label: 'Yape Perú' })
    );
  });

  it('renomear para o mesmo valor não grava nada', async () => {
    // Evita uma escrita e um toast à toa quando o operador só clica fora.
    const api = montar();
    await userEvent.click(screen.getByRole('button', { name: 'Yape' }));
    await userEvent.keyboard('{Enter}');
    expect(api.updateMethod).not.toHaveBeenCalled();
  });

  it('renomear para vazio não grava', async () => {
    const api = montar();
    await userEvent.click(screen.getByRole('button', { name: 'Yape' }));
    await userEvent.clear(screen.getByDisplayValue('Yape'));
    await userEvent.keyboard('{Enter}');
    expect(api.updateMethod).not.toHaveBeenCalled();
  });

  it('Esc cancela a edição', async () => {
    const api = montar();
    await userEvent.click(screen.getByRole('button', { name: 'Yape' }));
    await userEvent.type(screen.getByDisplayValue('Yape'), 'ZZZ');
    await userEvent.keyboard('{Escape}');
    expect(api.updateMethod).not.toHaveBeenCalled();
  });

  it('desativar tira do caixa sem apagar o histórico', async () => {
    const api = montar();
    const chaves = screen.getAllByRole('checkbox');
    await userEvent.click(chaves[1]);
    await waitFor(() =>
      expect(api.updateMethod).toHaveBeenCalledWith('m2', { active: false })
    );
  });

  it('reativar volta a ligar', async () => {
    const api = montar();
    await userEvent.click(screen.getAllByRole('checkbox')[2]);
    await waitFor(() =>
      expect(api.updateMethod).toHaveBeenCalledWith('m3', { active: true })
    );
  });

  it('excluir pede confirmação de perigo', async () => {
    // Exclusão é definitiva; o mesmo peso visual de um "salvar" seria armadilha.
    const api = montar();
    await userEvent.click(screen.getAllByTitle('Excluir')[0]);
    expect(confirmar).toHaveBeenCalledWith(
      expect.stringContaining('Dinheiro'),
      expect.objectContaining({ variant: 'danger' })
    );
    await waitFor(() => expect(api.deleteMethod).toHaveBeenCalledWith('m1'));
  });

  it('cancelar a confirmação não exclui', async () => {
    confirmar.mockResolvedValue(false);
    const api = montar();
    await userEvent.click(screen.getAllByTitle('Excluir')[0]);
    await waitFor(() => expect(confirmar).toHaveBeenCalled());
    expect(api.deleteMethod).not.toHaveBeenCalled();
  });

  it('método em uso não pode ser excluído — o erro aparece', async () => {
    const api = montar({
      deleteMethod: jest.fn().mockRejectedValue(new Error('em uso')),
    });
    await userEvent.click(screen.getAllByTitle('Excluir')[0]);
    await waitFor(() => expect(toast.error).toHaveBeenCalled());
    expect(api.deleteMethod).toHaveBeenCalled();
  });
});
