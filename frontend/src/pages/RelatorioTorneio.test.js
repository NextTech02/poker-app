/**
 * Relatório do torneio — a página que o clube imprime e arquiva.
 *
 * É um documento, não uma tela de operação: nada aqui é editável, e o valor
 * está em mostrar a cadeia inteira do dinheiro numa página só —
 * receita → rake → garantido → pool disponível → reservada → pool PAGÁVEL —
 * porque é exatamente essa sequência que alguém precisa conferir quando
 * questiona a premiação anunciada.
 *
 * As seções de dias e de faixas de prêmio só aparecem quando existem: um
 * quadro vazio num documento impresso parece dado faltando.
 */
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import RelatorioTorneio from './RelatorioTorneio';
import api from '../config/api';
import { useCurrency } from '../contexts/CurrencyContext';

jest.mock('../config/api', () => ({ __esModule: true, default: { get: jest.fn() } }));
jest.mock('../components/Sidebar', () => () => <nav data-testid="sidebar" />);
jest.mock('../contexts/CurrencyContext', () => ({ useCurrency: jest.fn() }));
jest.mock('react-router-dom', () => ({
  ...jest.requireActual('react-router-dom'),
  useParams: () => ({ tournamentId: 't1' }),
  useNavigate: () => jest.fn(),
}));
jest.mock('react-i18next', () => {
  const t = (chave, vars) =>
    vars && typeof vars === 'object' ? `${chave}:${Object.values(vars).join(',')}` : chave;
  const traducao = { t, i18n: { language: 'pt-BR' } };
  return { useTranslation: () => traducao };
});

const RELATORIO = {
  name: 'Main Event', status: 'completed', sponsor_name: 'Cerveja X',
  has_qualifying: true, is_satellite: false,
  total_players: 180, total_entries: 260, total_buy_ins: 180,
  total_rebuys: 60, total_addons: 20,
  total_revenue: 260000, rake_amount: 52000, rake_percentage: 20,
  guaranteed_prize: 100000, available_prize_pool: 208000,
  reserved_amount: 6240, reserved_prize_percentage: 3, reserved_purpose: 'staff',
  payable_pool: 201760,
  total_allocated: 200000, total_distributed: 150000, pending_release: 2,
  vagas_count: 1, vagas_generated: 1,
  days: [
    { id: 'd1', day_name: 'Dia 1A', day_type: 'qualifying', status: 'completed',
      buy_in: 1000, players: 100, buy_ins: 100, rebuys: 40, addons: 10, income: 150000,
      by_buy_type: [
        { name: 'Buy-in', category: 'buy_in', count: 88, amount: 88000 },
        { name: 'Doble', category: 'buy_in', count: 12, amount: 24000 },
        { name: 'Rebuy', category: 'rebuy', count: 40, amount: 40000 },
      ] },
  ],
  by_buy_type: [
    { name: 'Buy-in', category: 'buy_in', count: 168, amount: 168000 },
    { name: 'Doble', category: 'buy_in', count: 12, amount: 24000 },
    { name: 'Rebuy', category: 'rebuy', count: 60, amount: 60000 },
    { name: 'Tasa', category: 'addon', count: 20, amount: 8000 },
  ],
  prizes: [
    { id: 'a1', position: 1, prize_type: 'cash', prize_amount: 80000,
      player_name: 'Ana', released: true, paid: true, visible: true },
  ],
};

const responder = ({ relatorio = RELATORIO } = {}) => {
  api.get.mockImplementation(() =>
    relatorio instanceof Error ? Promise.reject(relatorio) : Promise.resolve({ data: relatorio })
  );
};

const montar = async (opcoes) => {
  responder(opcoes);
  render(<MemoryRouter><RelatorioTorneio /></MemoryRouter>);
  await waitFor(() => expect(screen.queryByText('common.loading')).toBeNull());
};

const conteudo = () => document.querySelector('.rt-page');

beforeEach(() => {
  useCurrency.mockReturnValue({ formatCurrency: (v) => `R$ ${Number(v || 0).toFixed(2)}` });
  jest.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => console.error.mockRestore());

describe('carga', () => {
  it('mostra o carregamento antes dos dados', () => {
    api.get.mockReturnValue(new Promise(() => {}));
    render(<MemoryRouter><RelatorioTorneio /></MemoryRouter>);
    expect(screen.getByText('common.loading')).toBeInTheDocument();
  });

  it('falha ao carregar vira um aviso, não uma página em branco', async () => {
    await montar({ relatorio: new Error('500') });
    expect(screen.getByText('tournamentReport.loadError')).toBeInTheDocument();
  });

  it('mostra patrocinador e status no cabeçalho', async () => {
    await montar();
    expect(document.querySelector('.rt-subtitle')).toHaveTextContent('Cerveja X');
    expect(document.querySelector('.rt-subtitle')).toHaveTextContent('completed');
  });

  it('torneio sem patrocinador não deixa rótulo solto', async () => {
    await montar({ relatorio: { ...RELATORIO, sponsor_name: null } });
    expect(document.querySelector('.rt-subtitle')).not.toHaveTextContent('tournamentReport.sponsor');
  });

  it('status ausente vira travessão', async () => {
    await montar({ relatorio: { ...RELATORIO, status: null } });
    expect(document.querySelector('.rt-subtitle')).toHaveTextContent('—');
  });

  it('torneio com classificatórios e satélite são sinalizados', async () => {
    await montar({ relatorio: { ...RELATORIO, is_satellite: true } });
    expect(document.querySelector('.rt-subtitle')).toHaveTextContent('tournamentReport.qualifying');
    expect(document.querySelector('.rt-subtitle')).toHaveTextContent('tournamentReport.satellite');
  });
});

describe('participação', () => {
  it('separa jogadores DISTINTOS de entradas', async () => {
    // 180 pessoas geraram 260 entradas: quem recomprou conta mais de uma vez.
    // Trocar os dois números inflaria o tamanho do torneio.
    await montar();
    expect(conteudo()).toHaveTextContent('180');
    expect(conteudo()).toHaveTextContent('260');
  });

  it('detalha buy-ins, rebuys e add-ons', async () => {
    await montar();
    expect(conteudo()).toHaveTextContent('60');
    expect(conteudo()).toHaveTextContent('20');
  });
});

describe('cadeia do dinheiro', () => {
  it('mostra receita, rake e o percentual efetivo', async () => {
    await montar();
    expect(conteudo()).toHaveTextContent('R$ 260000.00');
    expect(conteudo()).toHaveTextContent('R$ 52000.00');
    expect(conteudo()).toHaveTextContent('20%');
  });

  it('mostra o pool disponível e o pool PAGÁVEL separados', async () => {
    // A diferença entre os dois é a premiação reservada; misturá-los faria o
    // clube prometer o que não pode pagar.
    await montar();
    expect(conteudo()).toHaveTextContent('R$ 208000.00');
    expect(conteudo()).toHaveTextContent('R$ 201760.00');
  });

  it('a reservada aparece com percentual e finalidade', async () => {
    await montar();
    expect(conteudo()).toHaveTextContent('R$ 6240.00');
    expect(conteudo()).toHaveTextContent('staff');
  });

  it('reservada sem finalidade não mostra "null"', async () => {
    await montar({ relatorio: { ...RELATORIO, reserved_purpose: null } });
    expect(conteudo()).toHaveTextContent('tournamentReport.noPurpose');
  });

  it('mostra alocado, distribuído e o que falta liberar', async () => {
    await montar();
    expect(conteudo()).toHaveTextContent('R$ 200000.00');
    expect(conteudo()).toHaveTextContent('R$ 150000.00');
  });
});

describe('seções condicionais', () => {
  it('lista os dias quando existem', async () => {
    await montar();
    expect(screen.getByText('Dia 1A')).toBeInTheDocument();
  });

  it('sem dias, a seção nem aparece', async () => {
    // Um quadro vazio num documento impresso parece dado faltando.
    await montar({ relatorio: { ...RELATORIO, days: [] } });
    expect(conteudo()).not.toHaveTextContent('tournamentReport.days');
  });

  it('lista as faixas de prêmio quando existem', async () => {
    await montar();
    expect(screen.getByText('Ana')).toBeInTheDocument();
  });

  it('sem faixas, a seção nem aparece', async () => {
    await montar({ relatorio: { ...RELATORIO, prizes: [] } });
    expect(conteudo()).not.toHaveTextContent('tournamentReport.prizeTiers');
  });

  it('chaves ausentes não quebram o documento', async () => {
    // Um relatório de torneio antigo pode não trazer dias nem prêmios.
    await montar({ relatorio: { ...RELATORIO, days: undefined, prizes: undefined } });
    expect(conteudo()).toHaveTextContent('R$ 260000.00');
  });
});

describe('impressão', () => {
  it('o botão dispara a impressão do navegador', async () => {
    // É como o relatório vira PDF: sem servidor de geração no meio.
    const imprimir = jest.fn();
    window.print = imprimir;
    await montar();
    await userEvent.click(screen.getByRole('button', { name: 'tournamentReport.printPdf' }));
    expect(imprimir).toHaveBeenCalled();
  });
});


/**
 * Por MEIO de entrada: o diretor cadastra "Doble", "Tasa"…; o relatório só
 * mostrava as três categorias fixas.
 */
describe('por meio de entrada', () => {
  it('lista cada meio cadastrado com categoria, quantidade e valor', async () => {
    await montar();
    const tabela = document.querySelector('.rt-table--buytypes');
    expect(tabela).toHaveTextContent('Doble');
    expect(tabela).toHaveTextContent('Tasa');
    const linhas = Array.from(tabela.querySelectorAll('tbody tr'));
    expect(linhas).toHaveLength(4);
    expect(linhas[1]).toHaveTextContent('Doble');
    expect(linhas[1]).toHaveTextContent('tournamentReport.buyIns');   // categoria
    expect(linhas[1]).toHaveTextContent('12');
    expect(linhas[1]).toHaveTextContent('R$ 24000.00');
  });

  it('cada dia mostra o seu detalhamento compacto', async () => {
    await montar();
    expect(document.querySelector('.rt-breakdown')).toHaveTextContent('Buy-in 88 · Doble 12 · Rebuy 40');
  });

  it('backend antigo (sem a lista) não quebra: a seção some e o dia mostra travessão', async () => {
    const semMeios = { ...RELATORIO, by_buy_type: undefined, days: [{ ...RELATORIO.days[0], by_buy_type: undefined }] };
    await montar({ relatorio: semMeios });
    expect(document.querySelector('.rt-table--buytypes')).toBeNull();
    expect(document.querySelector('.rt-breakdown')).toHaveTextContent('—');
  });
});

describe('premiação por eliminação (KO)', () => {
  it('torneio KO mostra pool KO, pago e pendente', async () => {
    await montar({ relatorio: { ...RELATORIO, ko_format: 'pko', ko_percentage: 40, ko_pool: 40000, ko_paid: 25000, ko_pending: 5000 } });
    expect(screen.getByText('tournamentReport.koSection')).toBeInTheDocument();
    expect(conteudo()).toHaveTextContent('R$ 40000.00');
    expect(conteudo()).toHaveTextContent('R$ 25000.00');
    expect(conteudo()).toHaveTextContent('R$ 5000.00');
  });

  it('sem KO a seção não aparece', async () => {
    await montar();
    expect(screen.queryByText('tournamentReport.koSection')).toBeNull();
  });
});

it('torneio Mystery usa os rótulos do Mystery', async () => {
  await montar({ relatorio: { ...RELATORIO, ko_format: 'mystery', ko_percentage: 40, ko_pool: 2640, ko_paid: 1000, ko_pending: 0 } });
  expect(screen.getByText('tournamentReport.mysteryPool')).toBeInTheDocument();
  expect(screen.getByText('tournamentReport.mysteryPaid')).toBeInTheDocument();
  expect(screen.queryByText('tournamentReport.koPool')).toBeNull();
});
