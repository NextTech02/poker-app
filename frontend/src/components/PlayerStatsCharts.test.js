/**
 * Gráficos do perfil do jogador (SVG inline, sem biblioteca).
 *
 * O que eles respondem é uma pergunta que o jogador faz no balcão: "estou no
 * lucro?". Daí as decisões:
 *
 * - **Resultado = prêmio − gasto.** Mostrar só o prêmio faria todo mundo
 *   parecer ganhador.
 * - **A evolução é ACUMULADA e ordenada por data.** O histórico chega do
 *   servidor sem garantia de ordem; desenhar fora de ordem produziria uma
 *   linha em zigue-zague que não significa nada.
 * - **Menos de dois pontos não vira gráfico.** Uma linha com um ponto só é
 *   ruído visual; o número já está na tabela ao lado.
 *
 * A cor tem semântica: verde é lucro, vermelho é prejuízo — e a barra do zero
 * fica destacada, senão não dá para ver de que lado do zero está a barra.
 */
import { render, screen } from '@testing-library/react';
import PlayerStatsCharts from './PlayerStatsCharts';

const moeda = (v) => `R$ ${Number(v).toFixed(0)}`;
const ROTULOS = { evolution: 'Evolução', perTournament: 'Por torneio' };

const participacao = (nome, data, gasto, premio) => ({
  tournament_name: nome,
  registered_at: data,
  total_spent: gasto,
  prize_won: premio,
});

const montar = (historico) =>
  render(
    <PlayerStatsCharts
      history={historico}
      formatCurrency={moeda}
      locale="pt-BR"
      labels={ROTULOS}
    />
  );

describe('quando o gráfico aparece', () => {
  it('sem histórico não renderiza', () => {
    const { container } = montar([]);
    expect(container).toBeEmptyDOMElement();
  });

  it('histórico ausente não quebra', () => {
    const { container } = montar(null);
    expect(container).toBeEmptyDOMElement();
  });

  it('uma participação só não vira gráfico', () => {
    // Uma linha com um ponto é ruído visual; o número já está na tabela.
    const { container } = montar([participacao('A', '2026-06-01', 300, 0)]);
    expect(container).toBeEmptyDOMElement();
  });

  it('a partir de duas participações desenha os dois gráficos', () => {
    montar([
      participacao('A', '2026-06-01', 300, 0),
      participacao('B', '2026-06-02', 300, 1000),
    ]);
    expect(screen.getByRole('img', { name: 'Evolução' })).toBeInTheDocument();
    expect(screen.getByRole('img', { name: 'Por torneio' })).toBeInTheDocument();
  });

  it('participação sem data é descartada', () => {
    // Sem data não há onde colocá-la na linha do tempo.
    const { container } = montar([
      participacao('A', '2026-06-01', 300, 0),
      participacao('B', null, 300, 500),
    ]);
    expect(container).toBeEmptyDOMElement();
  });
});

describe('cálculo do resultado', () => {
  it('resultado é prêmio menos gasto', () => {
    // Mostrar só o prêmio faria todo mundo parecer ganhador.
    montar([
      participacao('A', '2026-06-01', 300, 0),
      participacao('B', '2026-06-02', 300, 1000),
    ]);
    const dicas = Array.from(document.querySelectorAll('title')).map((t) => t.textContent);
    expect(dicas).toContain('A — R$ -300');
    expect(dicas).toContain('B — R$ 700');
  });

  it('a evolução acumula os resultados', () => {
    // −300 no primeiro, +700 no segundo → acumulado de 400.
    montar([
      participacao('A', '2026-06-01', 300, 0),
      participacao('B', '2026-06-02', 300, 1000),
    ]);
    const dicas = Array.from(document.querySelectorAll('title')).map((t) => t.textContent);
    expect(dicas).toContain('B — R$ 400');
  });

  it('ordena por data mesmo se o histórico vier fora de ordem', () => {
    // Desenhar fora de ordem produziria uma linha em zigue-zague sem
    // significado.
    montar([
      participacao('Depois', '2026-06-10', 100, 500),
      participacao('Antes', '2026-06-01', 100, 0),
    ]);
    const dicas = Array.from(document.querySelectorAll('title')).map((t) => t.textContent);
    // acumulado do primeiro (mais antigo) é o próprio resultado dele
    expect(dicas).toContain('Antes — R$ -100');
    expect(dicas).toContain('Depois — R$ 300');
  });

  it('valores ausentes contam como zero, não NaN', () => {
    // "R$ NaN" na dica quebraria a leitura do gráfico inteiro.
    montar([
      { tournament_name: 'A', registered_at: '2026-06-01' },
      participacao('B', '2026-06-02', 300, 0),
    ]);
    const dicas = Array.from(document.querySelectorAll('title')).map((t) => t.textContent);
    expect(dicas.join(' ')).not.toContain('NaN');
  });

  it('torneio sem nome mostra travessão', () => {
    montar([
      { registered_at: '2026-06-01', total_spent: 100, prize_won: 0 },
      participacao('B', '2026-06-02', 100, 0),
    ]);
    const dicas = Array.from(document.querySelectorAll('title')).map((t) => t.textContent);
    expect(dicas.some((d) => d.startsWith('—'))).toBe(true);
  });
});

describe('leitura visual', () => {
  const DOIS = [
    participacao('Perda', '2026-06-01', 300, 0),
    participacao('Ganho', '2026-06-02', 300, 1000),
  ];

  it('lucro e prejuízo usam cores diferentes', () => {
    // A polaridade precisa ser visível sem ler o número.
    montar(DOIS);
    expect(document.querySelector('.psc-bar-neg')).toBeInTheDocument();
    expect(document.querySelector('.psc-bar-pos')).toBeInTheDocument();
  });

  it('a linha do zero é destacada', () => {
    // Sem ela não dá para ver de que lado do zero está a barra.
    montar(DOIS);
    expect(document.querySelectorAll('.psc-grid-zero').length).toBeGreaterThan(0);
  });

  it('o último ponto da evolução é destacado', () => {
    // É a resposta à pergunta "e hoje, como estou?".
    montar(DOIS);
    expect(document.querySelector('.psc-dot-last')).toBeInTheDocument();
  });

  it('cada participação vira um ponto e uma barra', () => {
    montar([...DOIS, participacao('C', '2026-06-03', 100, 100)]);
    expect(document.querySelectorAll('.psc-dot')).toHaveLength(3);
    expect(document.querySelectorAll('.psc-bar')).toHaveLength(3);
  });

  it('barra de valor zero ainda é visível', () => {
    // Altura zero sumiria da tela e pareceria participação faltando.
    montar([
      participacao('Empate', '2026-06-01', 100, 100),
      participacao('B', '2026-06-02', 100, 0),
    ]);
    const alturas = Array.from(document.querySelectorAll('.psc-bar')).map((b) =>
      Number(b.getAttribute('height'))
    );
    expect(Math.min(...alturas)).toBeGreaterThan(0);
  });

  it('mostra as datas das pontas', () => {
    montar(DOIS);
    const eixos = Array.from(document.querySelectorAll('.psc-axis')).map((e) => e.textContent);
    expect(eixos.some((e) => /\d{2}/.test(e))).toBe(true);
  });

  it('todos com o mesmo resultado não colapsam a escala', () => {
    // Máximo igual ao mínimo dividiria por zero e sumiria com o gráfico.
    montar([
      participacao('A', '2026-06-01', 100, 100),
      participacao('B', '2026-06-02', 100, 100),
    ]);
    expect(document.querySelectorAll('.psc-dot')).toHaveLength(2);
  });

  it('usa o formatador de moeda do clube nos eixos', () => {
    montar(DOIS);
    const eixos = Array.from(document.querySelectorAll('.psc-axis')).map((e) => e.textContent);
    expect(eixos.some((e) => e.startsWith('R$'))).toBe(true);
  });
});
