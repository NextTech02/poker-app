/**
 * Cartão de fidelidade no perfil do jogador.
 *
 * O operador abre isso com o jogador olhando por cima do balcão, e responde
 * ali mesmo "quanto eu tenho?" e "dá para trocar por quê?". Daí duas regras:
 *
 * - **Recompensa que o jogador não pode pagar fica travada**, com o motivo
 *   no título. Deixar clicar produziria um erro do servidor na frente dele.
 * - **O saldo gasta é `points_balance`; o nível VIP usa `lifetime_points`.**
 *   São coisas diferentes: resgatar não rebaixa ninguém de nível. Trocar um
 *   pelo outro faria o jogador perder o status ao usar os pontos.
 *
 * As seções vazias não aparecem: um clube que não usa cupom ou metas não
 * precisa ver caixas em branco.
 */
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import PlayerLoyaltyCard from './PlayerLoyaltyCard';

const t = (chave, padrao, vars) => {
  let texto = typeof padrao === 'string' ? padrao : chave;
  if (vars) {
    Object.entries(vars).forEach(([k, v]) => {
      texto = texto.replace(`{{${k}}}`, v);
    });
  }
  return texto;
};

const moeda = (v) => `R$ ${Number(v || 0).toFixed(2)}`;

const DADOS = {
  account: { points_balance: 350 },
  tier: { name: 'Prata', color: '#ccc', min_points: 100 },
  next_tier: { name: 'Ouro', min_points: 1000 },
  lifetime_points: 600,
  cashback_balance: 0,
  ledger: [],
  rewards: [],
  goals: [],
  giftable_credits: [],
};

const montar = (dados = DADOS, props = {}) =>
  render(
    <PlayerLoyaltyCard
      data={dados}
      t={t}
      locale="pt-BR"
      formatCurrency={moeda}
      {...props}
    />
  );

describe('saldo e nível', () => {
  it('sem dados não renderiza', () => {
    // O jogador pode não ter conta de fidelidade ainda.
    const { container } = render(<PlayerLoyaltyCard data={null} t={t} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('mostra o saldo gastável e o nível atual', () => {
    montar();
    expect(screen.getByText('350')).toBeInTheDocument();
    expect(screen.getByText('Prata')).toBeInTheDocument();
  });

  it('o progresso usa os pontos VITALÍCIOS, não o saldo', () => {
    // Resgatar não rebaixa ninguém: se usasse o saldo, o jogador perderia o
    // status ao gastar os pontos.
    montar();
    expect(screen.getByText('600 pts acumulados no total')).toBeInTheDocument();
    // 600 de 1000, com base 100 → 55%
    expect(screen.getByText('56%')).toBeInTheDocument();
  });

  it('mostra quanto falta para o próximo nível', () => {
    montar();
    expect(screen.getByText('Faltam 400 pts para Ouro')).toBeInTheDocument();
  });

  it('no nível máximo mostra a barra cheia', () => {
    montar({ ...DADOS, next_tier: null });
    expect(screen.getByText('Nível máximo alcançado')).toBeInTheDocument();
  });

  it('jogador sem conta ainda mostra zero, não vazio', () => {
    montar({ ...DADOS, account: null, lifetime_points: 0 });
    expect(screen.getByText('0')).toBeInTheDocument();
  });

  it('sem nível não mostra a etiqueta', () => {
    montar({ ...DADOS, tier: null });
    expect(screen.queryByText('Prata')).toBeNull();
  });

  it('aniversário do dia aparece em destaque', () => {
    // É o gancho para o operador oferecer o brinde na hora.
    const hoje = new Date();
    const data = `${hoje.getFullYear() - 30}-${String(hoje.getMonth() + 1).padStart(2, '0')}-${String(hoje.getDate()).padStart(2, '0')}`;
    montar(DADOS, { birthDate: data });
    expect(screen.getByText(/Aniversário hoje/)).toBeInTheDocument();
  });

  it('outro dia do ano não mostra aniversário', () => {
    montar(DADOS, { birthDate: '1990-01-01' });
    expect(screen.queryByText(/Aniversário hoje/)).toBeNull();
  });

  it('sem data de nascimento não quebra', () => {
    montar(DADOS, { birthDate: null });
    expect(screen.queryByText(/Aniversário hoje/)).toBeNull();
  });
});

describe('cashback', () => {
  it('sem saldo a seção não aparece', () => {
    montar();
    expect(screen.queryByText(/Cashback disponível/)).toBeNull();
  });

  it('com saldo oferece a conversão em crédito', () => {
    montar({ ...DADOS, cashback_balance: 42.5 });
    expect(screen.getByText('R$ 42.50')).toBeInTheDocument();
  });

  it('converter chama o pai', async () => {
    const converter = jest.fn();
    montar({ ...DADOS, cashback_balance: 42.5 }, { onConvertCashback: converter });
    await userEvent.click(screen.getByRole('button', { name: 'Converter em crédito' }));
    expect(converter).toHaveBeenCalled();
  });

  it('durante uma operação o botão trava', async () => {
    // Converter duas vezes criaria dois créditos do mesmo cashback.
    montar({ ...DADOS, cashback_balance: 10 }, { busy: true });
    expect(screen.getByRole('button', { name: 'Converter em crédito' })).toBeDisabled();
  });
});

describe('recompensas', () => {
  const COM_RECOMPENSAS = {
    ...DADOS,
    rewards: [
      { id: 'r1', name: 'Buy-in grátis', cost_points: 300 },
      { id: 'r2', name: 'Jantar', cost_points: 5000 },
    ],
  };

  it('lista o catálogo com o custo em pontos', () => {
    montar(COM_RECOMPENSAS);
    expect(screen.getByText('Buy-in grátis')).toBeInTheDocument();
    expect(screen.getByText('300 pontos')).toBeInTheDocument();
  });

  it('resgate dentro do saldo é liberado', () => {
    montar(COM_RECOMPENSAS);
    expect(screen.getAllByRole('button', { name: 'Resgatar' })[0]).not.toBeDisabled();
  });

  it('resgate acima do saldo fica travado com o motivo', () => {
    // Deixar clicar produziria um erro do servidor na frente do jogador.
    montar(COM_RECOMPENSAS);
    const caro = screen.getAllByRole('button', { name: 'Resgatar' })[1];
    expect(caro).toBeDisabled();
    expect(caro).toHaveAttribute('title', 'Pontos insuficientes');
  });

  it('resgatar chama o pai com a recompensa', async () => {
    const resgatar = jest.fn();
    montar(COM_RECOMPENSAS, { onRedeem: resgatar });
    await userEvent.click(screen.getAllByRole('button', { name: 'Resgatar' })[0]);
    expect(resgatar).toHaveBeenCalledWith('r1');
  });

  it('sem catálogo a seção some', () => {
    // Um clube que não configurou recompensas não vê caixa vazia.
    montar();
    expect(screen.queryByText('Recompensas')).toBeNull();
  });
});

describe('metas', () => {
  const meta = (extra) => ({
    id: 'm1',
    name: '5 torneios no mês',
    progress: 2,
    target: 5,
    reward_points: 500,
    completed: false,
    claimed: false,
    ...extra,
  });

  it('mostra o progresso e a recompensa', () => {
    montar({ ...DADOS, goals: [meta()] });
    expect(screen.getByText('5 torneios no mês')).toBeInTheDocument();
    expect(screen.getByText(/2\/5/)).toBeInTheDocument();
    expect(screen.getByText(/\+500 pts/)).toBeInTheDocument();
  });

  it('meta incompleta mostra o percentual, sem botão', () => {
    montar({ ...DADOS, goals: [meta()] });
    expect(screen.getByText('40%')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Resgatar recompensa' })).toBeNull();
  });

  it('meta concluída libera o resgate', () => {
    montar({ ...DADOS, goals: [meta({ progress: 5, completed: true })] });
    expect(screen.getByRole('button', { name: 'Resgatar recompensa' })).toBeInTheDocument();
  });

  it('resgatar meta chama o pai', async () => {
    const resgatar = jest.fn();
    montar(
      { ...DADOS, goals: [meta({ progress: 5, completed: true })] },
      { onClaimGoal: resgatar }
    );
    await userEvent.click(screen.getByRole('button', { name: 'Resgatar recompensa' }));
    expect(resgatar).toHaveBeenCalledWith('m1');
  });

  it('meta já resgatada não oferece o botão de novo', () => {
    // Resgatar duas vezes daria os pontos em dobro.
    montar({
      ...DADOS,
      goals: [meta({ progress: 5, completed: true, claimed: true })],
    });
    expect(screen.getByText(/Resgatada/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Resgatar recompensa' })).toBeNull();
  });

  it('progresso acima do alvo não passa de 100%', () => {
    // Uma barra que vaza da caixa quebraria o layout.
    montar({ ...DADOS, goals: [meta({ progress: 20, target: 5, completed: true })] });
    const barra = document.querySelector('.plc-goal-fill');
    expect(barra).toHaveStyle({ width: '100%' });
  });

  it('meta com alvo zero não divide por zero', () => {
    montar({ ...DADOS, goals: [meta({ target: 0 })] });
    expect(document.querySelector('.plc-goal-fill')).toBeInTheDocument();
  });
});

describe('cupom', () => {
  it('aplicar chama o pai com o código', async () => {
    const aplicar = jest.fn();
    montar(DADOS, { onRedeemCoupon: aplicar });
    await userEvent.type(screen.getByPlaceholderText('Código do cupom'), 'BEMVINDO');
    await userEvent.click(screen.getByRole('button', { name: 'Aplicar' }));
    expect(aplicar).toHaveBeenCalledWith('BEMVINDO');
  });

  it('limpa o campo depois de aplicar', async () => {
    // Reaplicar o mesmo cupom por engano daria erro na frente do jogador.
    montar(DADOS, { onRedeemCoupon: jest.fn() });
    const campo = screen.getByPlaceholderText('Código do cupom');
    await userEvent.type(campo, 'BEMVINDO');
    await userEvent.click(screen.getByRole('button', { name: 'Aplicar' }));
    expect(campo).toHaveValue('');
  });

  it('campo vazio trava o botão', () => {
    montar();
    expect(screen.getByRole('button', { name: 'Aplicar' })).toBeDisabled();
  });

  it('só espaços não conta como código', () => {
    montar();
    expect(screen.getByRole('button', { name: 'Aplicar' })).toBeDisabled();
  });
});

describe('créditos para presentear', () => {
  const COM_PRESENTES = {
    ...DADOS,
    giftable_credits: [
      { id: 'c1', original_amount: 100, notes: 'Brinde de aniversário' },
      { id: 'c2', original_amount: 50, notes: null },
    ],
  };

  it('lista os créditos com valor e origem', () => {
    montar(COM_PRESENTES);
    expect(screen.getByText('R$ 100.00')).toBeInTheDocument();
    expect(screen.getByText('Brinde de aniversário')).toBeInTheDocument();
  });

  it('crédito sem observação usa um rótulo genérico', () => {
    montar(COM_PRESENTES);
    expect(screen.getByText('Crédito')).toBeInTheDocument();
  });

  it('presentear chama o pai com o crédito', async () => {
    const presentear = jest.fn();
    montar(COM_PRESENTES, { onGiftCredit: presentear });
    await userEvent.click(screen.getAllByRole('button', { name: 'Presentear' })[0]);
    expect(presentear).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'c1' })
    );
  });

  it('sem créditos a seção some', () => {
    montar();
    expect(screen.queryByText('Créditos para presentear')).toBeNull();
  });
});

describe('extrato', () => {
  const lancamento = (id, razao, delta) => ({
    id,
    reason: razao,
    delta,
    created_at: '2026-06-08T10:00:00Z',
  });

  it('traduz o motivo de cada movimento', () => {
    montar({
      ...DADOS,
      ledger: [lancamento('l1', 'earn_buy_in', 50), lancamento('l2', 'redeem', -300)],
    });
    expect(screen.getByText('Buy-in')).toBeInTheDocument();
    expect(screen.getByText('Resgate')).toBeInTheDocument();
  });

  it('motivo desconhecido sai como veio, sem quebrar', () => {
    montar({ ...DADOS, ledger: [lancamento('l1', 'motivo_novo', 10)] });
    expect(screen.getByText('motivo_novo')).toBeInTheDocument();
  });

  it('entrada mostra sinal de mais e saída de menos', () => {
    montar({
      ...DADOS,
      ledger: [lancamento('l1', 'earn_buy_in', 50), lancamento('l2', 'redeem', -300)],
    });
    expect(screen.getByText('+50')).toBeInTheDocument();
    expect(screen.getByText('-300')).toBeInTheDocument();
  });

  it('mostra no máximo 6 movimentos', () => {
    // O cartão fica no perfil do jogador; uma lista longa empurraria o resto
    // da tela para fora da vista.
    const muitos = Array.from({ length: 20 }, (_, i) =>
      lancamento(`l${i}`, 'earn_buy_in', 10)
    );
    montar({ ...DADOS, ledger: muitos });
    expect(document.querySelectorAll('.plc-ledger-item')).toHaveLength(6);
  });

  it('sem movimento a seção some', () => {
    montar();
    expect(screen.queryByText('Movimentações recentes')).toBeNull();
  });

  it('data inválida não quebra a lista', () => {
    montar({ ...DADOS, ledger: [{ id: 'l1', reason: 'manual', delta: 1, created_at: null }] });
    expect(screen.getByText('Ajuste')).toBeInTheDocument();
  });
});

describe('formatação de moeda', () => {
  it('sem formatador usa um padrão em vez de quebrar', () => {
    // O cartão é reaproveitado em telas que não passam o contexto de moeda.
    render(
      <PlayerLoyaltyCard data={{ ...DADOS, cashback_balance: 10 }} t={t} locale="pt-BR" />
    );
    expect(screen.getByText('R$ 10.00')).toBeInTheDocument();
  });
});
