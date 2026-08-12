/**
 * Caixa Geral — a sangria.
 *
 * Sangria é tirar dinheiro do caixa da ETAPA e mandar para o caixa GERAL,
 * descontando o rake da casa no caminho. É a operação que separa o dinheiro
 * dos jogadores do lucro do clube, e por isso o cálculo é o centro dos testes:
 *
 * - **O rake é PROPORCIONAL ao que está saindo**, não um percentual fixo:
 *   `rake pendente × valor ÷ saldo`. Sangrar metade do caixa leva metade do
 *   rake pendente; sangrar tudo leva tudo. Um percentual fixo cobraria rake a
 *   mais numa sangria parcial.
 * - **O rake nunca passa do valor sangrado.** Sem esse teto, uma etapa com
 *   rake pendente maior que o saldo produziria um líquido negativo — dinheiro
 *   saindo do caixa geral numa operação que deveria só abastecê-lo.
 * - **Não se sangra mais do que existe.** A checagem vem antes de qualquer
 *   escrita.
 *
 * A operação passa pela camada offline: sem rede, entra na fila com chave de
 * idempotência e a réplica local é atualizada.
 */
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import CaixaGeral from './CaixaGeral';
import api from '../config/api';
import { offlineWrite } from '../offline/apiOffline';
import { useToast } from '../contexts/ToastContext';
import { useCurrency } from '../contexts/CurrencyContext';

jest.mock('../config/api', () => ({ __esModule: true, default: { get: jest.fn() } }));
jest.mock('../offline/apiOffline', () => ({ offlineWrite: jest.fn() }));
jest.mock('../offline/domainRules', () => ({ applySangria: jest.fn() }));
jest.mock('../offline/db', () => ({ uuid: () => 'mut-1', putEntity: jest.fn() }));
jest.mock('../components/Sidebar', () => () => <nav data-testid="sidebar" />);
jest.mock('../contexts/ToastContext', () => ({ useToast: jest.fn() }));
jest.mock('../contexts/CurrencyContext', () => ({ useCurrency: jest.fn() }));
jest.mock('react-i18next', () => {
  const t = (chave, segundo, terceiro) => {
    const vars = segundo && typeof segundo === 'object' ? segundo : terceiro;
    if (vars) return `${chave}:${Object.values(vars).join(',')}`;
    return typeof segundo === 'string' ? segundo : chave;
  };
  const traducao = { t, i18n: { language: 'pt-BR' } };
  return { useTranslation: () => traducao };
});

const ETAPAS = [
  { id: 'e1', name: 'Etapa 1', status: 'active' },
  { id: 'e2', name: 'Etapa 2', status: 'upcoming' },
  { id: 'e3', name: 'Encerrada', status: 'completed' },
  { id: 'e4', name: 'Cancelada', status: 'cancelled' },
];

const HISTORICO = [
  { id: 'sg1', created_at: '2026-06-08T22:00:00Z', amount: 5000, rake_percentage: 20,
    rake_amount: 1000, net_amount: 4000, notes: 'Fechamento parcial' },
];

let toast;

const responder = ({
  etapas = ETAPAS,
  caixaEtapa = { current_balance: '10000' },
  caixaGeral = { current_balance: '80000' },
  rake = { total_rake: '25000' },
  rakePendente = { pending_rake: '2000' },
  historico = HISTORICO,
} = {}) => {
  api.get.mockImplementation((url) => {
    if (url === '/stages') {
      return etapas instanceof Error ? Promise.reject(etapas) : Promise.resolve({ data: etapas });
    }
    if (url.startsWith('/cash/stage/') && url.endsWith('/pending-rake')) {
      return rakePendente instanceof Error
        ? Promise.reject(rakePendente)
        : Promise.resolve({ data: rakePendente });
    }
    if (url.startsWith('/cash/stage/')) {
      return caixaEtapa instanceof Error
        ? Promise.reject(caixaEtapa)
        : Promise.resolve({ data: caixaEtapa });
    }
    if (url === '/cash/general') {
      return caixaGeral instanceof Error ? Promise.reject(caixaGeral) : Promise.resolve({ data: caixaGeral });
    }
    if (url === '/cash/rake') return Promise.resolve({ data: rake });
    if (url.startsWith('/cash/sangria/history')) return Promise.resolve({ data: historico });
    return Promise.resolve({ data: [] });
  });
};

const erroHttp = (status, detail) => {
  const e = new Error('http');
  e.response = { status, data: detail ? { detail } : {} };
  return e;
};

const montar = async (opcoes) => {
  responder(opcoes);
  render(<CaixaGeral />);
  await waitFor(() => expect(api.get).toHaveBeenCalledWith('/cash/general'));
};

const abrirSangria = async () => {
  await waitFor(() =>
    expect(screen.getByRole('button', { name: 'generalCash.performSangria' })).toBeInTheDocument()
  );
  await userEvent.click(screen.getByRole('button', { name: 'generalCash.performSangria' }));
};

const digitarValor = async (valor) => {
  await userEvent.type(screen.getByLabelText('generalCash.sangriaAmountLabel'), valor);
};

const enviar = async () =>
  userEvent.click(screen.getByRole('button', { name: 'generalCash.confirmSangria' }));

const calculo = () => document.querySelector('.sangria-calculation');

beforeEach(() => {
  toast = { success: jest.fn(), error: jest.fn(), warning: jest.fn() };
  useToast.mockReturnValue({ toast });
  useCurrency.mockReturnValue({ formatCurrency: (v) => `R$ ${Number(v || 0).toFixed(2)}` });
  offlineWrite.mockResolvedValue({ data: { message: 'Sangria registrada' } });
  jest.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => console.error.mockRestore());

describe('escolha da etapa', () => {
  it('etapas encerradas e canceladas não entram na lista', async () => {
    // Sangrar uma etapa encerrada reabriria um caixa já conferido.
    await montar();
    // A opção mostra "nome - local", então a busca é por trecho.
    await screen.findByRole('option', { name: /Etapa 1/ });
    const seletor = screen.getByLabelText('generalCash.selectStageLabel');
    expect(within(seletor).queryByText('Encerrada')).toBeNull();
    expect(within(seletor).queryByText('Cancelada')).toBeNull();
  });

  it('a primeira etapa aberta já vem selecionada', async () => {
    // Poupa um clique na operação mais repetida do fim da noite.
    await montar();
    await waitFor(() =>
      expect(screen.getByLabelText('generalCash.selectStageLabel')).toHaveValue('e1')
    );
  });

  it('sem etapa aberta nenhuma, o cartão do caixa explica', async () => {
    await montar({ etapas: [ETAPAS[2]] });
    expect(await screen.findByText('generalCash.selectStageEmpty')).toBeInTheDocument();
  });

  it('trocar de etapa recarrega o caixa daquela etapa', async () => {
    await montar();
    await waitFor(() => expect(api.get).toHaveBeenCalledWith('/cash/stage/e1'));
    await userEvent.selectOptions(screen.getByLabelText('generalCash.selectStageLabel'), 'e2');
    await waitFor(() => expect(api.get).toHaveBeenCalledWith('/cash/stage/e2'));
  });

  it('sessão expirada manda para o login', async () => {
    // Sem isso a tela ficaria vazia sem explicar por quê.
    delete window.location;
    window.location = { href: '' };
    await montar({ etapas: erroHttp(401) });
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('generalCash.sessionExpired'));
    expect(window.location.href).toBe('/login');
  });
});

describe('os três saldos', () => {
  it('mostra caixa da etapa, caixa geral e rake acumulado', async () => {
    await montar();
    expect(await screen.findByText('R$ 10000.00')).toBeInTheDocument();
    expect(screen.getByText('R$ 80000.00')).toBeInTheDocument();
    expect(screen.getByText('R$ 25000.00')).toBeInTheDocument();
  });

  it('caixa da etapa que falha não derruba os outros', async () => {
    await montar({ caixaEtapa: new Error('500') });
    expect(await screen.findByText('R$ 80000.00')).toBeInTheDocument();
  });
});

describe('cálculo do rake da sangria', () => {
  it('o rake é PROPORCIONAL ao que está saindo', async () => {
    // Saldo 10000, rake pendente 2000. Sangrando 5000 (metade), sai metade do
    // rake pendente: 1000. Um percentual fixo cobraria a mais.
    await montar();
    await abrirSangria();
    await digitarValor('5000');
    expect(calculo()).toHaveTextContent('- R$ 1000.00');
    expect(calculo()).toHaveTextContent('R$ 4000.00');
  });

  it('sangrar o caixa inteiro leva todo o rake pendente', async () => {
    await montar();
    await abrirSangria();
    await digitarValor('10000');
    expect(calculo()).toHaveTextContent('- R$ 2000.00');
    expect(calculo()).toHaveTextContent('R$ 8000.00');
  });

  it('o percentual efetivo acompanha a proporção', async () => {
    await montar();
    await abrirSangria();
    await digitarValor('5000');
    expect(calculo()).toHaveTextContent('generalCash.rakeWithPercent:20.00');
  });

  it('rake NUNCA passa do valor sangrado', async () => {
    // Sem o teto, o líquido ficaria negativo — dinheiro saindo do caixa geral
    // numa operação que deveria só abastecê-lo.
    await montar({ caixaEtapa: { current_balance: '1000' }, rakePendente: { pending_rake: '5000' } });
    await abrirSangria();
    await digitarValor('1000');
    expect(calculo()).toHaveTextContent('- R$ 1000.00');
    expect(calculo()).toHaveTextContent('R$ 0.00');
  });

  it('sem rake pendente, tudo vai líquido para o caixa geral', async () => {
    await montar({ rakePendente: { pending_rake: '0' } });
    await abrirSangria();
    await digitarValor('5000');
    expect(calculo()).toHaveTextContent('- R$ 0.00');
  });

  it('falha ao buscar o rake pendente assume zero, não NaN', async () => {
    await montar({ rakePendente: new Error('500') });
    await abrirSangria();
    await digitarValor('5000');
    expect(calculo()).toHaveTextContent('- R$ 0.00');
  });

  it('sem valor digitado o cálculo nem aparece', async () => {
    await montar();
    await abrirSangria();
    expect(calculo()).toBeNull();
  });
});

describe('validações antes de gravar', () => {
  it('valor zero é recusado', async () => {
    await montar();
    await abrirSangria();
    await digitarValor('0');
    await enviar();
    expect(toast.warning).toHaveBeenCalledWith('generalCash.amountGreaterThanZero');
    expect(offlineWrite).not.toHaveBeenCalled();
  });

  it('valor acima do saldo é recusado, dizendo qual é o saldo', async () => {
    // O operador precisa saber quanto pode tirar, não só que errou.
    await montar();
    await abrirSangria();
    await digitarValor('99999');
    await enviar();
    expect(toast.warning).toHaveBeenCalledWith('generalCash.insufficientBalance:R$ 10000.00');
    expect(offlineWrite).not.toHaveBeenCalled();
  });

  it('sangrar exatamente o saldo é permitido', async () => {
    // É o caso normal do fechamento da noite.
    await montar();
    await abrirSangria();
    await digitarValor('10000');
    await enviar();
    await waitFor(() => expect(offlineWrite).toHaveBeenCalled());
  });
});

describe('gravação da sangria', () => {
  it('envia etapa, valor e a observação', async () => {
    await montar();
    await abrirSangria();
    await digitarValor('5000');
    await userEvent.type(screen.getByLabelText('generalCash.notesOptionalLabel'), 'Fechamento');
    await enviar();
    await waitFor(() => expect(offlineWrite).toHaveBeenCalled());
    expect(offlineWrite.mock.calls[0][0].body).toMatchObject({
      stage_id: 'e1', stage_name: 'Etapa 1', amount: 5000, notes: 'Fechamento',
    });
  });

  it('observação em branco vai nula, não string vazia', async () => {
    await montar();
    await abrirSangria();
    await digitarValor('5000');
    await enviar();
    await waitFor(() => expect(offlineWrite).toHaveBeenCalled());
    expect(offlineWrite.mock.calls[0][0].body.notes).toBeNull();
  });

  it('a operação leva chave de idempotência', async () => {
    // O replay da fila não pode sangrar duas vezes o mesmo caixa.
    await montar();
    await abrirSangria();
    await digitarValor('5000');
    await enviar();
    await waitFor(() => expect(offlineWrite).toHaveBeenCalled());
    expect(offlineWrite.mock.calls[0][0].clientMutationId).toBe('mut-1');
    expect(offlineWrite.mock.calls[0][0].body.client_mutation_id).toBe('mut-1');
  });

  it('gravar recarrega os três saldos e o histórico', async () => {
    await montar();
    await abrirSangria();
    await digitarValor('5000');
    const antes = api.get.mock.calls.length;
    await enviar();
    await waitFor(() => expect(api.get.mock.calls.length).toBeGreaterThan(antes));
  });

  it('o formulário fecha depois de gravar', async () => {
    await montar();
    await abrirSangria();
    await digitarValor('5000');
    await enviar();
    await waitFor(() =>
      expect(screen.queryByLabelText('generalCash.sangriaAmountLabel')).toBeNull()
    );
  });

  it('sem rede, a sangria entra na fila e a tela avisa', async () => {
    offlineWrite.mockResolvedValue({ data: { message: 'Salvo offline — será enviado ao sincronizar' } });
    await montar();
    await abrirSangria();
    await digitarValor('5000');
    await enviar();
    await waitFor(() =>
      expect(toast.success).toHaveBeenCalledWith('Salvo offline — será enviado ao sincronizar')
    );
  });

  it('erro do servidor mostra o motivo', async () => {
    offlineWrite.mockRejectedValue(erroHttp(400, 'Caixa já fechado'));
    await montar();
    await abrirSangria();
    await digitarValor('5000');
    await enviar();
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('Caixa já fechado'));
  });

  it('erro sem motivo legível cai numa frase padrão', async () => {
    offlineWrite.mockRejectedValue(new Error('boom'));
    await montar();
    await abrirSangria();
    await digitarValor('5000');
    await enviar();
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('generalCash.sangriaError'));
  });

  it('fechar o formulário não sangra nada', async () => {
    await montar();
    await abrirSangria();
    await userEvent.click(screen.getByRole('button', { name: 'common.cancel' }));
    expect(screen.queryByLabelText('generalCash.sangriaAmountLabel')).toBeNull();
    expect(offlineWrite).not.toHaveBeenCalled();
  });
});

describe('histórico de sangrias', () => {
  it('mostra bruto, rake e líquido de cada sangria', async () => {
    // É a prestação de contas: quanto saiu do caixa e quanto virou lucro.
    await montar();
    // waitFor so repete enquanto uma asserção falha; devolver o elemento cru
    // nao espera nada.
    await waitFor(() => expect(document.querySelector('.sangria-table')).not.toBeNull());
    const tabela = document.querySelector('.sangria-table');
    expect(tabela).toHaveTextContent('R$ 5000.00');
    expect(tabela).toHaveTextContent('R$ 1000.00');
    expect(tabela).toHaveTextContent('R$ 4000.00');
  });

  it('a observação aparece junto', async () => {
    await montar();
    expect(await screen.findByText('Fechamento parcial')).toBeInTheDocument();
  });

  it('sem sangria nenhuma explica o que fazer', async () => {
    await montar({ historico: [] });
    expect(await screen.findByText('generalCash.noSangria')).toBeInTheDocument();
    expect(screen.getByText('generalCash.noSangriaHint')).toBeInTheDocument();
  });
});
