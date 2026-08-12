/**
 * Componentes de base: Button, Card, EmptyState, Breadcrumb, SkeletonLoader.
 *
 * São peças pequenas, mas erradas em todas as telas ao mesmo tempo. O que
 * merece teste aqui é o contrato que as telas assumem sem conferir:
 *
 * - `type="button"` por padrão no Button. Um botão sem type dentro de um
 *   formulário é `submit`: clicar em "Cancelar" enviaria o formulário.
 * - O último item do Breadcrumb NÃO é link — é a página atual. Clicar nele
 *   recarregaria a mesma tela, e leitores de tela anunciariam um link para
 *   lugar nenhum.
 * - EmptyState só mostra o botão quando há rótulo E ação; um botão sem
 *   handler é um beco sem saída.
 */
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import Button from './Button';
import Card from './Card';
import EmptyState from './EmptyState';
import Breadcrumb from './Breadcrumb';
import {
  SkeletonBlock,
  SkeletonStatCard,
  SkeletonTableRow,
  SkeletonTournamentCard,
  SkeletonPlayersTable,
  SkeletonActivityList,
} from './SkeletonLoader';

jest.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (chave, padrao) => padrao || chave }),
}));

describe('Button', () => {
  it('mostra o conteúdo', () => {
    render(<Button>Salvar</Button>);
    expect(screen.getByRole('button', { name: 'Salvar' })).toBeInTheDocument();
  });

  it('é do tipo button por padrão', () => {
    // Sem isso, um "Cancelar" dentro de um formulário viraria submit e
    // enviaria o cadastro que o operador estava desistindo de fazer.
    render(<Button>Cancelar</Button>);
    expect(screen.getByRole('button')).toHaveAttribute('type', 'button');
  });

  it('aceita ser um submit explícito', () => {
    render(<Button type="submit">Enviar</Button>);
    expect(screen.getByRole('button')).toHaveAttribute('type', 'submit');
  });

  it('chama o handler no clique', async () => {
    const aoClicar = jest.fn();
    render(<Button onClick={aoClicar}>Ok</Button>);
    await userEvent.click(screen.getByRole('button'));
    expect(aoClicar).toHaveBeenCalled();
  });

  it('desabilitado não dispara o handler', async () => {
    // É o que evita o duplo registro enquanto a requisição anterior corre.
    const aoClicar = jest.fn();
    render(<Button onClick={aoClicar} disabled>Ok</Button>);
    await userEvent.click(screen.getByRole('button'));
    expect(aoClicar).not.toHaveBeenCalled();
  });

  it('aplica variante e tamanho padrão', () => {
    render(<Button>Ok</Button>);
    expect(screen.getByRole('button')).toHaveClass('btn', 'btn-primary', 'btn-medium');
  });

  it('aceita variante, tamanho e classe extra', () => {
    render(<Button variant="danger" size="small" className="minha">Ok</Button>);
    const b = screen.getByRole('button');
    expect(b).toHaveClass('btn-danger', 'btn-small', 'minha');
  });
});

describe('Card', () => {
  it('mostra o conteúdo', () => {
    render(<Card>corpo</Card>);
    expect(screen.getByText('corpo')).toBeInTheDocument();
  });

  it('mostra o título quando informado', () => {
    render(<Card title="Resumo">corpo</Card>);
    expect(screen.getByText('Resumo')).toBeInTheDocument();
  });

  it('sem título não renderiza o cabeçalho vazio', () => {
    // Um cabeçalho vazio deixaria um espaço inexplicável no topo do cartão.
    const { container } = render(<Card>corpo</Card>);
    expect(container.querySelector('.card-header')).toBeNull();
  });

  it('aceita classe extra', () => {
    const { container } = render(<Card className="destaque">x</Card>);
    expect(container.querySelector('.card')).toHaveClass('destaque');
  });
});

describe('EmptyState', () => {
  it('mostra ícone e título', () => {
    render(<EmptyState icon="🎲" title="Nenhum torneio" />);
    expect(screen.getByText('🎲')).toBeInTheDocument();
    expect(screen.getByText('Nenhum torneio')).toBeInTheDocument();
  });

  it('mostra o subtítulo quando há', () => {
    render(<EmptyState title="Vazio" subtitle="Crie o primeiro" />);
    expect(screen.getByText('Crie o primeiro')).toBeInTheDocument();
  });

  it('sem subtítulo não renderiza o parágrafo', () => {
    const { container } = render(<EmptyState title="Vazio" />);
    expect(container.querySelector('.es-subtitle')).toBeNull();
  });

  it('mostra a ação quando há rótulo e handler', () => {
    render(<EmptyState title="Vazio" ctaLabel="Criar" onCta={() => {}} />);
    expect(screen.getByRole('button', { name: /Criar/ })).toBeInTheDocument();
  });

  it('rótulo sem handler não vira botão', () => {
    // Um botão que não faz nada é um beco sem saída para o operador.
    render(<EmptyState title="Vazio" ctaLabel="Criar" />);
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('handler sem rótulo não vira botão', () => {
    render(<EmptyState title="Vazio" onCta={() => {}} />);
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('chama a ação no clique', async () => {
    const aoClicar = jest.fn();
    render(<EmptyState title="Vazio" ctaLabel="Criar" onCta={aoClicar} />);
    await userEvent.click(screen.getByRole('button'));
    expect(aoClicar).toHaveBeenCalled();
  });
});

describe('Breadcrumb', () => {
  const montar = (itens) =>
    render(
      <MemoryRouter>
        <Breadcrumb items={itens} />
      </MemoryRouter>
    );

  it('o último item é a página atual, não um link', () => {
    // Clicar nele recarregaria a mesma tela; leitores de tela anunciariam um
    // link para lugar nenhum.
    montar([
      { label: 'Torneios', to: '/torneios' },
      { label: 'Etapa Rio' },
    ]);
    expect(screen.getByRole('link', { name: 'Torneios' })).toHaveAttribute(
      'href',
      '/torneios'
    );
    const atual = screen.getByText('Etapa Rio');
    expect(atual).toHaveAttribute('aria-current', 'page');
    expect(screen.queryByRole('link', { name: 'Etapa Rio' })).toBeNull();
  });

  it('coloca separador entre os itens, mas não antes do primeiro', () => {
    const { container } = montar([
      { label: 'A', to: '/a' },
      { label: 'B', to: '/b' },
      { label: 'C' },
    ]);
    expect(container.querySelectorAll('.breadcrumb-sep')).toHaveLength(2);
  });

  it('um item só não gera separador', () => {
    const { container } = montar([{ label: 'Única' }]);
    expect(container.querySelectorAll('.breadcrumb-sep')).toHaveLength(0);
  });

  it('é uma navegação rotulada', () => {
    montar([{ label: 'Só' }]);
    expect(screen.getByRole('navigation')).toBeInTheDocument();
  });
});

describe('SkeletonLoader', () => {
  it('o bloco usa as dimensões informadas', () => {
    // O esqueleto precisa ocupar o mesmo espaço do conteúdo real; se for
    // menor, a tela "pula" quando os dados chegam.
    const { container } = render(<SkeletonBlock width="200px" height="2rem" />);
    const bloco = container.firstChild;
    expect(bloco).toHaveStyle({ width: '200px', height: '2rem' });
  });

  it('o bloco tem dimensões padrão', () => {
    const { container } = render(<SkeletonBlock />);
    expect(container.firstChild).toHaveStyle({ width: '100%' });
  });

  it('o cartão de indicador renderiza', () => {
    const { container } = render(<SkeletonStatCard />);
    expect(container.querySelector('.skeleton-stat-card')).toBeInTheDocument();
  });

  it('a linha de tabela respeita o número de colunas', () => {
    const { container } = render(
      <table><tbody><SkeletonTableRow cols={3} /></tbody></table>
    );
    expect(container.querySelectorAll('td')).toHaveLength(3);
  });

  it('a linha de tabela tem 5 colunas por padrão', () => {
    const { container } = render(
      <table><tbody><SkeletonTableRow /></tbody></table>
    );
    expect(container.querySelectorAll('td')).toHaveLength(5);
  });

  it('o cartão de torneio renderiza', () => {
    const { container } = render(<SkeletonTournamentCard />);
    expect(container.querySelector('.skeleton-tournament-card')).toBeInTheDocument();
  });

  it('a tabela de jogadores respeita o número de linhas', () => {
    const { container } = render(<SkeletonPlayersTable rows={3} />);
    expect(container.querySelectorAll('tbody tr')).toHaveLength(3);
  });

  it('a tabela de jogadores tem 5 linhas por padrão', () => {
    const { container } = render(<SkeletonPlayersTable />);
    expect(container.querySelectorAll('tbody tr')).toHaveLength(5);
  });

  it('a lista de atividade respeita o número de linhas', () => {
    const { container } = render(<SkeletonActivityList rows={4} />);
    expect(container.querySelectorAll('.skeleton-activity-item')).toHaveLength(4);
  });

  it('a lista de atividade tem 3 linhas por padrão', () => {
    const { container } = render(<SkeletonActivityList />);
    expect(container.querySelectorAll('.skeleton-activity-item')).toHaveLength(3);
  });
});
