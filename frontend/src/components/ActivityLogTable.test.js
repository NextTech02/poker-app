/**
 * Tabela do log de acessos.
 *
 * O componente não sabe de QUAL organização está mostrando — recebe um
 * `fetchPage` e confia nele. O que se testa aqui é o que ele faz com a
 * resposta: como mostra um login e um diff, como filtra e como pagina.
 */
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import ActivityLogTable from './ActivityLogTable';

// O `t` falso devolve o fallback quando há um: eventos e tabelas passam o
// próprio identificador como fallback, então "login" e "update tournaments".
jest.mock('react-i18next', () => {
  const t = (chave, segundo, terceiro) => {
    const vars = segundo && typeof segundo === 'object' ? segundo : terceiro;
    if (vars) return `${chave}:${Object.values(vars).join(',')}`;
    return typeof segundo === 'string' ? segundo : chave;
  };
  const traducao = { t, i18n: { language: 'pt-BR' } };
  return { useTranslation: () => traducao };
});

const LOGIN = {
  id: 'l1', event_type: 'login', user_email: 'ana@clube.com', created_at: '2026-09-10T20:15:00Z',
  ip: '187.10.0.1', user_agent: 'Mozilla/5.0 (Windows NT 10.0) Chrome/128.0 Safari/537.36',
};
const ALTERACAO = {
  id: 'a1', event_type: 'tournaments.update', user_email: 'beto@clube.com',
  created_at: '2026-09-10T21:00:00Z', entity_label: 'Main Event',
  changes: {
    name: { old: 'Main', new: 'Main Event' },
    status: { old: 'pending', new: 'active' },
    buy_in: { old: 100, new: 150 },
    guaranteed_prize: { old: null, new: 5000 },
    max_players: { old: 80, new: 100 },
  },
};
const DO_SISTEMA = {
  id: 's1', event_type: 'staff.delete', user_email: null,
  created_at: '2026-09-11T09:00:00Z', entity_label: 'Carla', changes: { email: 'carla@x.com' },
};

const montar = async ({ items = [LOGIN, ALTERACAO, DO_SISTEMA], total, users, fetchPage } = {}) => {
  const fetch = fetchPage || jest.fn().mockResolvedValue({ items, total: total ?? items.length });
  render(<ActivityLogTable fetchPage={fetch} users={users} pageSize={2} />);
  await waitFor(() => expect(document.querySelector('.skeleton-row')).toBeNull());
  return fetch;
};

describe('o que a tabela mostra', () => {
  it('login traz e-mail, IP e dispositivo', async () => {
    await montar();
    const linha = screen.getByText('ana@clube.com').closest('tr');
    expect(within(linha).getByText('login')).toBeInTheDocument();
    expect(within(linha).getByText('187.10.0.1 · Chrome · Windows')).toBeInTheDocument();
  });

  it('alteração mostra a entidade e só o que mudou, com limite', async () => {
    await montar();
    const linha = screen.getByText('beto@clube.com').closest('tr');
    expect(within(linha).getByText('update tournaments')).toBeInTheDocument();
    expect(linha.querySelector('.al-entity')).toHaveTextContent('Main Event');
    expect(within(linha).getByText('Main')).toHaveClass('al-old');
    expect(within(linha).getByText('active')).toHaveClass('al-new');
    // 5 campos mudaram, 4 aparecem e o resto vira "+1".
    expect(within(linha).getByText('+1')).toBeInTheDocument();
    expect(within(linha).queryByText('max_players:')).toBeNull();
  });

  it('evento sem usuário é do sistema', async () => {
    await montar();
    const linha = screen.getByText('Carla').closest('tr');
    expect(within(linha).getByText('Sistema')).toBeInTheDocument();
  });

  it('período padrão são os últimos 30 dias', async () => {
    const fetch = await montar();
    const params = fetch.mock.calls[0][0];
    expect(params.date_from < params.date_to).toBe(true);
    expect(params.page).toBe(1);
    expect(params.page_size).toBe(2);
    expect(params.event_type).toBeUndefined();
  });

  it('vazio explica', async () => {
    await montar({ items: [] });
    expect(screen.getByText('Nenhum registro no período')).toBeInTheDocument();
  });

  it('falha não vira tela em branco', async () => {
    await montar({ fetchPage: jest.fn().mockRejectedValue(new Error('500')) });
    expect(screen.getByText('Não foi possível carregar o log')).toBeInTheDocument();
  });
});

describe('filtros', () => {
  it('trocar o evento refaz a busca na página 1', async () => {
    const fetch = await montar();
    await userEvent.selectOptions(screen.getByLabelText('Evento'), 'tournaments.*');
    await waitFor(() => expect(fetch).toHaveBeenLastCalledWith(
      expect.objectContaining({ event_type: 'tournaments.*', page: 1 }),
    ));
  });

  it('com a equipe em mãos o usuário é um select por auth_user_id', async () => {
    const fetch = await montar({
      users: [
        { id: 's1', auth_user_id: 'u-ana', name: 'Ana' },
        { id: 's2', auth_user_id: null, name: 'Convidado' }, // sem conta ainda: não filtra nada
      ],
    });
    const select = screen.getByLabelText('Usuário');
    expect(within(select).queryByText('Convidado')).toBeNull();
    await userEvent.selectOptions(select, 'u-ana');
    await waitFor(() => expect(fetch).toHaveBeenLastCalledWith(
      expect.objectContaining({ user_id: 'u-ana' }),
    ));
  });
});

describe('paginação', () => {
  it('próxima pede a página 2 e volta desabilita no fim', async () => {
    const fetch = await montar({ items: [LOGIN, ALTERACAO], total: 3 });
    expect(screen.getByText('activityLog.range:1,2,3')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Anterior' })).toBeDisabled();

    await userEvent.click(screen.getByRole('button', { name: 'Próxima' }));
    await waitFor(() => expect(fetch).toHaveBeenLastCalledWith(expect.objectContaining({ page: 2 })));
  });

  it('numa página só, próxima fica desabilitada', async () => {
    await montar({ items: [LOGIN], total: 1 });
    expect(screen.getByRole('button', { name: 'Próxima' })).toBeDisabled();
  });
});
