/**
 * Telas de configuração: formas de pagamento e tipos de compra.
 *
 * As duas alimentam o Caixa, e as duas têm o mesmo risco central: **o que
 * está gravado nas transações antigas não pode ser reescrito nem perdido**.
 *
 * - Formas de pagamento embutidas (dinheiro, pix, cartão) não são editáveis:
 *   elas traduzem com o idioma do app, e deixar o clube renomear "Pix" para
 *   "PIX BB" quebraria a tradução das outras línguas.
 * - Desativar é diferente de excluir. Desativar tira do dropdown do caixa
 *   mas mantém o rótulo do histórico; excluir é definitivo e por isso passa
 *   por confirmação com variante de perigo.
 * - Tipo de compra é POR ETAPA — sem etapa selecionada a tela nem abre, para
 *   não criar um tipo "solto" que aplicaria rake no evento errado.
 */
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import PaymentMethodsManager from './PaymentMethodsManager';
import BuyTypesManager from './BuyTypesManager';
import { usePaymentMethods } from '../contexts/PaymentMethodsContext';
import { useBuyTypes } from '../contexts/BuyTypesContext';
import { useStage } from '../contexts/StageContext';
import { useToast } from '../contexts/ToastContext';

jest.mock('../contexts/PaymentMethodsContext', () => ({ usePaymentMethods: jest.fn() }));
jest.mock('../contexts/BuyTypesContext', () => ({ useBuyTypes: jest.fn() }));
jest.mock('../contexts/StageContext', () => ({ useStage: jest.fn() }));
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

describe('BuyTypesManager', () => {
  const TIPOS = [
    { id: 'b1', name: 'Buy-in', category: 'buy_in', rake_percentage: 20, active: true },
    { id: 'b2', name: 'Freeroll', category: 'buy_in', rake_percentage: 0, active: false },
  ];

  const montar = (extra = {}, etapa = { id: 'e1', name: 'Etapa Rio' }) => {
    useStage.mockReturnValue({ selectedStage: etapa });
    const api = {
      buyTypes: TIPOS,
      loading: false,
      createBuyType: jest.fn().mockResolvedValue(undefined),
      updateBuyType: jest.fn().mockResolvedValue(undefined),
      deleteBuyType: jest.fn().mockResolvedValue(undefined),
      ...extra,
    };
    useBuyTypes.mockReturnValue(api);
    render(<BuyTypesManager />);
    return api;
  };

  it('sem etapa selecionada a tela nem abre', () => {
    // Um tipo criado "solto" aplicaria rake no evento errado.
    montar({}, null);
    expect(screen.getByText(/Selecione uma etapa/)).toBeInTheDocument();
    expect(screen.queryByRole('table')).toBeNull();
  });

  it('mostra a etapa a que os tipos pertencem', () => {
    montar();
    expect(screen.getByText('Etapa Rio')).toBeInTheDocument();
  });

  it('lista os tipos com rake e categoria', () => {
    montar();
    expect(screen.getByText('Freeroll')).toBeInTheDocument();
    expect(screen.getByText('0%')).toBeInTheDocument();
    expect(screen.getByText('20%')).toBeInTheDocument();
  });

  it('mostra o carregamento', () => {
    montar({ loading: true, buyTypes: [] });
    expect(screen.getByText('Carregando...')).toBeInTheDocument();
  });

  it('etapa sem tipos avisa', () => {
    montar({ buyTypes: [] });
    expect(screen.getByText(/Nenhum tipo cadastrado/)).toBeInTheDocument();
  });

  it('adiciona um tipo com rake próprio', async () => {
    const api = montar();
    // Busca pelo RÓTULO (não pelo placeholder): é o rótulo que o operador e o
    // leitor de tela usam, e ele não desaparece quando o campo é preenchido.
    await userEvent.type(screen.getByLabelText('Nome'), 'Buy-in VIP');
    const rake = screen.getByLabelText('Rake (%)');
    await userEvent.clear(rake);
    await userEvent.type(rake, '10');
    await userEvent.click(screen.getByRole('button', { name: /Adicionar/ }));
    await waitFor(() =>
      expect(api.createBuyType).toHaveBeenCalledWith(
        expect.objectContaining({ name: 'Buy-in VIP', rake_percentage: '10' })
      )
    );
  });

  it('os três campos do cadastro têm rótulo associado', () => {
    // O "20" sem rótulo era lido como valor da entrada em reais; o rótulo
    // precisa dizer que é PORCENTAGEM.
    montar();
    expect(screen.getByLabelText('Nome').tagName).toBe('INPUT');
    expect(screen.getByLabelText('Categoria').tagName).toBe('SELECT');
    expect(screen.getByLabelText('Rake (%)')).toBe(screen.getByRole('spinbutton'));
  });

  it('os campos de edição inline são anunciados pelo leitor de tela', async () => {
    // Na tabela o cabeçalho da coluna já rotula visualmente; o aria-label é o
    // que resta para quem ouve a célula fora do contexto do cabeçalho.
    montar();
    await userEvent.click(screen.getAllByRole('button', { name: 'Editar' })[0]);
    expect(screen.getByLabelText('Nome — Buy-in')).toBeInTheDocument();
    expect(screen.getByLabelText('Categoria — Buy-in')).toBeInTheDocument();
    expect(screen.getByLabelText('Rake (%) — Buy-in')).toBeInTheDocument();
  });

  it('o botão fica travado sem nome', () => {
    montar();
    expect(screen.getByRole('button', { name: /Adicionar/ })).toBeDisabled();
  });

  it('falha ao criar avisa e libera o formulário', async () => {
    montar({ createBuyType: jest.fn().mockRejectedValue(new Error('erro')) });
    await userEvent.type(screen.getByLabelText('Nome'), 'X');
    await userEvent.click(screen.getByRole('button', { name: /Adicionar/ }));
    await waitFor(() => expect(toast.error).toHaveBeenCalled());
    await waitFor(() =>
      expect(screen.getByRole('button', { name: /Adicionar/ })).not.toBeDisabled()
    );
  });

  it('editar grava nome, categoria e rake', async () => {
    const api = montar();
    await userEvent.click(screen.getAllByRole('button', { name: 'Editar' })[0]);
    const nome = document.querySelector('.bty-row-editing .bty-in-name');
    await userEvent.clear(nome);
    await userEvent.type(nome, 'Buy-in Turbo');
    await userEvent.click(screen.getByRole('button', { name: 'Salvar' }));
    await waitFor(() =>
      expect(api.updateBuyType).toHaveBeenCalledWith('b1', {
        name: 'Buy-in Turbo',
        category: 'buy_in',
        rake_percentage: 20,
      })
    );
  });

  it('rake não numérico na edição vira zero', async () => {
    // NaN gravado contaminaria todo cálculo de prêmio da etapa.
    const api = montar();
    await userEvent.click(screen.getAllByRole('button', { name: 'Editar' })[0]);
    const rake = screen.getAllByRole('spinbutton')[1];
    await userEvent.clear(rake);
    await userEvent.click(screen.getByRole('button', { name: 'Salvar' }));
    await waitFor(() =>
      expect(api.updateBuyType).toHaveBeenCalledWith(
        'b1',
        expect.objectContaining({ rake_percentage: 0 })
      )
    );
  });

  it('salvar com nome vazio não grava', async () => {
    const api = montar();
    await userEvent.click(screen.getAllByRole('button', { name: 'Editar' })[0]);
    await userEvent.clear(document.querySelector('.bty-row-editing .bty-in-name'));
    await userEvent.click(screen.getByRole('button', { name: 'Salvar' }));
    expect(api.updateBuyType).not.toHaveBeenCalled();
  });

  it('cancelar a edição sai sem gravar', async () => {
    const api = montar();
    await userEvent.click(screen.getAllByRole('button', { name: 'Editar' })[0]);
    await userEvent.click(screen.getByRole('button', { name: 'Cancelar' }));
    expect(api.updateBuyType).not.toHaveBeenCalled();
    expect(screen.queryByRole('button', { name: 'Salvar' })).toBeNull();
  });

  it('falha ao editar avisa e fecha a edição', async () => {
    montar({ updateBuyType: jest.fn().mockRejectedValue(new Error('erro')) });
    await userEvent.click(screen.getAllByRole('button', { name: 'Editar' })[0]);
    await userEvent.click(screen.getByRole('button', { name: 'Salvar' }));
    await waitFor(() => expect(toast.error).toHaveBeenCalled());
  });

  it('desativar tira do caixa', async () => {
    const api = montar();
    await userEvent.click(screen.getAllByRole('checkbox')[0]);
    await waitFor(() =>
      expect(api.updateBuyType).toHaveBeenCalledWith('b1', { active: false })
    );
  });

  it('falha ao desativar avisa', async () => {
    montar({ updateBuyType: jest.fn().mockRejectedValue(new Error('erro')) });
    await userEvent.click(screen.getAllByRole('checkbox')[0]);
    await waitFor(() => expect(toast.error).toHaveBeenCalled());
  });

  it('excluir pede confirmação de perigo', async () => {
    const api = montar();
    await userEvent.click(screen.getAllByTitle('Excluir')[0]);
    expect(confirmar).toHaveBeenCalledWith(
      expect.stringContaining('Buy-in'),
      expect.objectContaining({ variant: 'danger' })
    );
    await waitFor(() => expect(api.deleteBuyType).toHaveBeenCalledWith('b1'));
  });

  it('cancelar a confirmação não exclui', async () => {
    confirmar.mockResolvedValue(false);
    const api = montar();
    await userEvent.click(screen.getAllByTitle('Excluir')[0]);
    await waitFor(() => expect(confirmar).toHaveBeenCalled());
    expect(api.deleteBuyType).not.toHaveBeenCalled();
  });

  it('tipo em uso não pode ser excluído — o erro aparece', async () => {
    montar({ deleteBuyType: jest.fn().mockRejectedValue(new Error('em uso')) });
    await userEvent.click(screen.getAllByTitle('Excluir')[0]);
    await waitFor(() => expect(toast.error).toHaveBeenCalled());
  });
});
