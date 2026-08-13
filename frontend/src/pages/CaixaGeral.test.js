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
 * A etapa vem do app (StageContext), não de um seletor só desta tela: com dois
 * seletores concorrentes a tela mostrava uma etapa e o header X-Stage-ID
 * mandava outra.
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
import { useStage } from '../contexts/StageContext';
import { usePaymentMethods } from '../contexts/PaymentMethodsContext';

jest.mock('../config/api', () => ({ __esModule: true, default: { get: jest.fn() } }));
jest.mock('../offline/apiOffline', () => ({ offlineWrite: jest.fn() }));
jest.mock('../offline/domainRules', () => ({ applySangria: jest.fn() }));
jest.mock('../offline/db', () => ({ uuid: () => 'mut-1', putEntity: jest.fn() }));
jest.mock('../components/Sidebar', () => () => <nav data-testid="sidebar" />);
jest.mock('../contexts/ToastContext', () => ({ useToast: jest.fn() }));
jest.mock('../contexts/CurrencyContext', () => ({ useCurrency: jest.fn() }));
jest.mock('../contexts/StageContext', () => ({ useStage: jest.fn() }));
jest.mock('../contexts/PaymentMethodsContext', () => ({ usePaymentMethods: jest.fn() }));
const mockNavigate = jest.fn();
jest.mock('react-router-dom', () => ({
  ...jest.requireActual('react-router-dom'),
  useNavigate: () => mockNavigate,
}));
jest.mock('react-i18next', () => {
  const t = (chave, segundo, terceiro) => {
    const vars = segundo && typeof segundo === 'object' ? segundo : terceiro;
    if (vars) return `${chave}:${Object.values(vars).join(',')}`;
    return typeof segundo === 'string' ? segundo : chave;
  };
  const traducao = { t, i18n: { language: 'pt-BR' } };
  return { useTranslation: () => traducao };
});

const ETAPA = { id: 'e1', name: 'Etapa 1', location: 'Rio' };
const OUTRA_ETAPA = { id: 'e2', name: 'Etapa 2', location: 'Medellín' };

const HISTORICO = [
  { id: 'sg1', created_at: '2026-06-08T22:00:00Z', amount: 5000, rake_percentage: 20,
    rake_amount: 1000, net_amount: 4000, notes: 'Fechamento parcial' },
];

const RESUMO = {
  stage_id: 'e1', current_balance: '10000', total_sangrias: '5000', sangria_count: 1,
  rake_generated: '3000', rake_extracted: '1000', pending_rake: '2000',
  net_to_general: '4000',
};

const QUEBRA = {
  stage_id: 'e1', total: '450',
  methods: [
    { code: 'pix', total: '300', count: 1 },
    { code: 'cash', total: '150', count: 2 },
  ],
};

// Métodos cadastrados no clube (vêm do Supabase, via PaymentMethodsContext).
const METODOS_CADASTRADOS = [
  { code: 'pix', label: 'PIX', active: true },
  { code: 'cash', label: 'Dinheiro', active: true },
  { code: 'yape', label: 'Yape Perú', active: true },
];

let toast;

const responder = ({
  caixaEtapa = { current_balance: '10000' },
  caixaGeral = { current_balance: '80000' },
  rake = { total_rake: '25000' },
  rakePendente = { pending_rake: '2000' },
  resumo = RESUMO,
  quebra = QUEBRA,
  historico = HISTORICO,
} = {}) => {
  api.get.mockImplementation((url) => {
    if (url.startsWith('/cash/stage/') && url.endsWith('/pending-rake')) {
      return rakePendente instanceof Error
        ? Promise.reject(rakePendente)
        : Promise.resolve({ data: rakePendente });
    }
    if (url.startsWith('/cash/stage/') && url.endsWith('/summary')) {
      return resumo instanceof Error ? Promise.reject(resumo) : Promise.resolve({ data: resumo });
    }
    if (url.startsWith('/cash/stage/') && url.endsWith('/payment-methods')) {
      return quebra instanceof Error ? Promise.reject(quebra) : Promise.resolve({ data: quebra });
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

const montar = async ({ etapa = ETAPA, metodos = METODOS_CADASTRADOS, ...opcoes } = {}) => {
  useStage.mockReturnValue({ selectedStage: etapa });
  usePaymentMethods.mockReturnValue({ methods: metodos });
  responder(opcoes);
  const utils = render(<CaixaGeral />);
  await waitFor(() => expect(api.get).toHaveBeenCalledWith('/cash/general'));
  return utils;
};

const abrirSangria = async () => {
  await screen.findByRole('button', { name: 'generalCash.performSangria' });
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

describe('a etapa vem do app, não de um seletor próprio', () => {
  it('sem etapa selecionada a tela explica e não busca caixa de etapa nenhuma', async () => {
    // Antes a tela escolhia sozinha a primeira etapa aberta, ignorando a etapa
    // do app: o operador sangrava um caixa que não era o que ele estava vendo.
    await montar({ etapa: null });
    expect(await screen.findByText('Nenhuma etapa selecionada')).toBeInTheDocument();
    expect(screen.getByText('Ir para Etapas')).toBeInTheDocument();
    const urls = api.get.mock.calls.map((c) => c[0]);
    expect(urls.some((u) => u.startsWith('/cash/stage/'))).toBe(false);
  });

  it('o atalho para Etapas navega pelo Router, sem recarregar a SPA', async () => {
    /* Era `window.location.href`: o app inteiro reinicia, o estado carregado
       se perde e o tablet do caixa pisca uma tela branca no meio do evento. */
    await montar({ etapa: null });
    await userEvent.click(await screen.findByText('Ir para Etapas'));
    expect(mockNavigate).toHaveBeenCalledWith('/etapas');
    expect(window.location.href).not.toContain('/etapas');
  });

  it('sem etapa selecionada o cartão do caixa do dia explica', async () => {
    await montar({ etapa: null });
    expect(await screen.findByText('generalCash.selectStageEmpty')).toBeInTheDocument();
  });

  it('a etapa do app é a que manda: caixa, resumo, quebra e histórico saem dela', async () => {
    await montar();
    await waitFor(() => expect(api.get).toHaveBeenCalledWith('/cash/stage/e1'));
    expect(api.get).toHaveBeenCalledWith('/cash/stage/e1/summary');
    expect(api.get).toHaveBeenCalledWith('/cash/stage/e1/payment-methods');
    expect(api.get).toHaveBeenCalledWith('/cash/stage/e1/pending-rake');
    expect(api.get).toHaveBeenCalledWith('/cash/sangria/history?stage_id=e1&limit=10');
  });

  it('trocar a etapa no app recarrega tudo com o novo id', async () => {
    const { rerender } = await montar();
    await waitFor(() => expect(api.get).toHaveBeenCalledWith('/cash/stage/e1'));
    useStage.mockReturnValue({ selectedStage: OUTRA_ETAPA });
    rerender(<CaixaGeral />);
    await waitFor(() => expect(api.get).toHaveBeenCalledWith('/cash/stage/e2'));
    expect(api.get).toHaveBeenCalledWith('/cash/stage/e2/summary');
  });

  it('sessão expirada manda para o login', async () => {
    // Sem isso a tela ficaria vazia sem explicar por quê.
    delete window.location;
    window.location = { href: '' };
    await montar({ caixaGeral: erroHttp(401) });
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('generalCash.sessionExpired'));
    expect(window.location.href).toBe('/login');
  });
});

describe('o que é da etapa e o que é do clube', () => {
  const cartaoGeral = () => document.querySelector('.general-cash-card');
  const cartaoRake = () => document.querySelector('.rake-card');

  it('o caixa do dia mostra o saldo da etapa', async () => {
    await montar();
    expect(await screen.findByText('R$ 10000.00')).toBeInTheDocument();
  });

  it('o cartão do caixa geral destaca o que ESTA etapa mandou', async () => {
    // O saldo do caixa geral não é decomponível por etapa (despesas, outras
    // receitas e pagamentos entram nele sem stage_id). O que a etapa prova é
    // quanto ela enviou.
    await montar();
    await waitFor(() => expect(cartaoGeral()).toHaveTextContent('R$ 4000.00'));
    expect(within(cartaoGeral()).getByText('Enviado ao caixa geral (esta etapa)')).toBeInTheDocument();
  });

  it('o total do clube aparece como linha secundária, com rótulo próprio', async () => {
    await montar();
    await waitFor(() => expect(cartaoGeral()).toHaveTextContent('R$ 80000.00'));
    expect(within(cartaoGeral()).getByText('Caixa geral do clube (total)')).toBeInTheDocument();
  });

  it('o rake da etapa é o extraído nela, com o gerado e o do clube ao lado', async () => {
    await montar();
    await waitFor(() => expect(cartaoRake()).toHaveTextContent('R$ 1000.00'));
    expect(cartaoRake()).toHaveTextContent('R$ 3000.00');   // gerado nas entradas
    expect(cartaoRake()).toHaveTextContent('R$ 25000.00');  // acumulado do clube
  });

  it('sem etapa, o número da etapa é traço — zero seria mentira', async () => {
    // "R$ 0,00" diria que esta etapa não mandou nada ao caixa geral; não há
    // etapa nenhuma. O total do clube continua visível.
    await montar({ etapa: null });
    await waitFor(() => expect(cartaoGeral()).toHaveTextContent('R$ 80000.00'));
    expect(within(cartaoGeral()).getAllByText('--').length).toBeGreaterThan(0);
    expect(cartaoGeral()).not.toHaveTextContent('R$ 0.00');
  });

  it('resumo da etapa que falha não derruba os outros cartões', async () => {
    await montar({ resumo: new Error('500') });
    expect(await screen.findByText('R$ 80000.00')).toBeInTheDocument();
    expect(screen.getByText('R$ 10000.00')).toBeInTheDocument();
  });

  it('caixa da etapa que falha não derruba os outros', async () => {
    await montar({ caixaEtapa: new Error('500') });
    expect(await screen.findByText('R$ 80000.00')).toBeInTheDocument();
  });
});

describe('entradas por forma de pagamento', () => {
  const quadro = () => document.querySelector('.payment-breakdown');

  it('lista cada método com o valor e fecha com o total', async () => {
    // O trigger do caixa soma toda entrada, independente do método: sem essa
    // quebra o operador confere a gaveta contra um valor que inclui PIX.
    await montar();
    await waitFor(() => expect(quadro()).not.toBeNull());
    expect(quadro()).toHaveTextContent('R$ 300.00');
    expect(quadro()).toHaveTextContent('R$ 150.00');
    expect(within(quadro()).getByText('Total das entradas')).toBeInTheDocument();
    expect(quadro()).toHaveTextContent('R$ 450.00');
  });

  it('método embutido usa o rótulo traduzido', async () => {
    await montar();
    await waitFor(() => expect(quadro()).not.toBeNull());
    expect(quadro()).toHaveTextContent('financial.paymentPix');
  });

  it('método personalizado usa o rótulo cadastrado pelo clube', async () => {
    await montar({ quebra: { total: '90', methods: [{ code: 'yape', total: '90', count: 1 }] } });
    await waitFor(() => expect(quadro()).not.toBeNull());
    expect(quadro()).toHaveTextContent('Yape Perú');
  });

  it('método apagado do cadastro cai no próprio código, não some da lista', async () => {
    // Um valor sem nome no fechamento é pior do que um código cru.
    await montar({ quebra: { total: '90', methods: [{ code: 'nequi', total: '90', count: 1 }] } });
    await waitFor(() => expect(quadro()).not.toBeNull());
    expect(quadro()).toHaveTextContent('nequi');
  });

  it('entrada antiga sem método fica identificada, não vira dinheiro', async () => {
    await montar({ quebra: { total: '90', methods: [{ code: null, total: '90', count: 1 }] } });
    await waitFor(() => expect(quadro()).not.toBeNull());
    expect(quadro()).toHaveTextContent('Não informado');
  });

  it('a leitura avisa que é entrada bruta, não saldo', async () => {
    // Depois da primeira sangria os dois números divergem; sem o aviso isso é
    // reportado como bug.
    await montar();
    expect(await screen.findByText(/ENTRADAS da etapa/)).toBeInTheDocument();
  });

  it('etapa sem entrada nenhuma explica em vez de mostrar quadro vazio', async () => {
    await montar({ quebra: { total: '0', methods: [] } });
    expect(await screen.findByText('Nenhuma entrada registrada nesta etapa')).toBeInTheDocument();
  });

  it('a quebra também aparece dentro do modal de sangria', async () => {
    await montar();
    await abrirSangria();
    const noModal = document.querySelector('.sangria-payment-breakdown');
    expect(noModal).not.toBeNull();
    expect(noModal).toHaveTextContent('R$ 450.00');
  });

  it('falha na quebra não impede abrir o modal nem gravar a sangria', async () => {
    await montar({ quebra: new Error('500') });
    await abrirSangria();
    expect(document.querySelector('.sangria-payment-breakdown')).toBeNull();
    await digitarValor('5000');
    await enviar();
    await waitFor(() => expect(offlineWrite).toHaveBeenCalled());
  });

  it('depois de gravar a sangria a quebra é recarregada', async () => {
    await montar();
    await abrirSangria();
    await digitarValor('5000');
    const antes = api.get.mock.calls.filter((c) => c[0] === '/cash/stage/e1/payment-methods').length;
    await enviar();
    await waitFor(() =>
      expect(api.get.mock.calls.filter((c) => c[0] === '/cash/stage/e1/payment-methods').length)
        .toBeGreaterThan(antes)
    );
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
  it('envia a etapa do app, o valor e a observação', async () => {
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

  it('gravar recarrega os saldos e o histórico', async () => {
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
