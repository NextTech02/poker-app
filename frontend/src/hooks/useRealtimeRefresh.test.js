/**
 * O contrato do hook que trocou o polling de 5s pelo aviso do banco.
 *
 * O que precisa ser verdade, e por quê:
 *  - evento do banco recarrega a tela  -> é a razão de existir;
 *  - rajada vira UM refetch            -> sentar um jogador escreve em três
 *                                         tabelas de uma vez;
 *  - o poll lento continua             -> WebSocket cai, e a tela não pode
 *                                         parar de atualizar para sempre;
 *  - sem Realtime, degrada             -> já houve variável de ambiente que
 *                                         não chegou na imagem Docker.
 */
import { act, renderHook, waitFor } from '@testing-library/react';
import { useRealtimeRefresh } from './useRealtimeRefresh';
import { supabase } from '../config/supabase';

jest.mock('../config/supabase', () => ({
  supabase: { channel: jest.fn(), removeChannel: jest.fn() },
}));

/** Canal de mentira que guarda os handlers para o teste disparar à mão. */
function canalFalso() {
  const inscricoes = [];
  const canal = {
    inscricoes,
    subscribe: jest.fn(),
    on: jest.fn((tipo, config, handler) => {
      inscricoes.push({ tipo, config, handler });
      return canal; // encadeável, como o de verdade
    }),
  };
  return canal;
}

const TABELAS = [{ table: 'cash_seats', filter: 'table_id=eq.m1' }];

describe('useRealtimeRefresh', () => {
  let canal;

  beforeEach(() => {
    canal = canalFalso();
    supabase.channel.mockReturnValue(canal);
    supabase.removeChannel.mockClear();
  });

  it('assina cada tabela pedida, com o filtro', () => {
    renderHook(() =>
      useRealtimeRefresh({ canal: 'c1', tabelas: TABELAS, aoMudar: jest.fn() })
    );

    expect(supabase.channel).toHaveBeenCalledWith('c1');
    expect(canal.on).toHaveBeenCalledTimes(1);
    const [tipo, config] = canal.on.mock.calls[0];
    expect(tipo).toBe('postgres_changes');
    expect(config).toMatchObject({
      schema: 'public',
      table: 'cash_seats',
      filter: 'table_id=eq.m1',
      event: '*',
    });
    expect(canal.subscribe).toHaveBeenCalled();
  });

  it('evento do banco recarrega a tela', async () => {
    const aoMudar = jest.fn();
    renderHook(() => useRealtimeRefresh({ canal: 'c1', tabelas: TABELAS, aoMudar }));

    act(() => canal.inscricoes[0].handler({ eventType: 'UPDATE' }));

    await waitFor(() => expect(aoMudar).toHaveBeenCalledTimes(1));
  });

  it('uma rajada de eventos vira UM refetch', async () => {
    // Sentar um jogador escreve em cash_seats, cash_player_sessions e
    // cash_transactions. Sem o debounce seriam três buscas para um ato só.
    const aoMudar = jest.fn();
    renderHook(() =>
      useRealtimeRefresh({
        canal: 'c1',
        tabelas: [
          { table: 'cash_seats' },
          { table: 'cash_player_sessions' },
          { table: 'cash_transactions' },
        ],
        aoMudar,
      })
    );

    act(() => {
      canal.inscricoes.forEach((i) => i.handler({}));
    });

    await waitFor(() => expect(aoMudar).toHaveBeenCalledTimes(1));
    expect(aoMudar).toHaveBeenCalledTimes(1);
  });

  it('o poll de segurança continua rodando', async () => {
    // Realtime é o caminho rápido, não o único: WebSocket cai quando o tablet
    // suspende ou o proxy derruba a conexão ociosa.
    jest.useFakeTimers();
    try {
      const aoMudar = jest.fn();
      renderHook(() =>
        useRealtimeRefresh({
          canal: 'c1',
          tabelas: TABELAS,
          aoMudar,
          intervaloDeSeguranca: 30000,
        })
      );

      expect(aoMudar).not.toHaveBeenCalled();
      await act(async () => {
        jest.advanceTimersByTime(30000 + 200); // intervalo + debounce
      });
      expect(aoMudar).toHaveBeenCalled();
    } finally {
      jest.useRealTimers();
    }
  });

  it('com a aba oculta não busca nada', async () => {
    // Operador deixa tela aberta; sem isto ela martela a API em segundo plano.
    jest.useFakeTimers();
    const oculto = jest.spyOn(document, 'hidden', 'get').mockReturnValue(true);
    try {
      const aoMudar = jest.fn();
      renderHook(() =>
        useRealtimeRefresh({
          canal: 'c1',
          tabelas: TABELAS,
          aoMudar,
          intervaloDeSeguranca: 30000,
        })
      );

      await act(async () => {
        jest.advanceTimersByTime(90000);
      });
      expect(aoMudar).not.toHaveBeenCalled();
    } finally {
      oculto.mockRestore();
      jest.useRealTimers();
    }
  });

  it('`ativo` falso não assina nada', () => {
    renderHook(() =>
      useRealtimeRefresh({
        canal: 'c1',
        tabelas: TABELAS,
        aoMudar: jest.fn(),
        ativo: false,
      })
    );

    expect(supabase.channel).not.toHaveBeenCalled();
  });

  it('larga o canal ao sair da tela', () => {
    const { unmount } = renderHook(() =>
      useRealtimeRefresh({ canal: 'c1', tabelas: TABELAS, aoMudar: jest.fn() })
    );

    unmount();

    expect(supabase.removeChannel).toHaveBeenCalledWith(canal);
  });

  it('sem Realtime no ambiente, a tela fica lenta — não quebra', async () => {
    // Modo de falha deliberado: já aconteceu neste projeto de uma variável de
    // ambiente não chegar à imagem Docker.
    supabase.channel.mockImplementation(() => {
      throw new Error('sem realtime');
    });
    jest.useFakeTimers();
    try {
      const aoMudar = jest.fn();
      expect(() =>
        renderHook(() =>
          useRealtimeRefresh({
            canal: 'c1',
            tabelas: TABELAS,
            aoMudar,
            intervaloDeSeguranca: 30000,
          })
        )
      ).not.toThrow();

      // E o poll de segurança segue de pé, que é o ponto.
      await act(async () => {
        jest.advanceTimersByTime(30000 + 200);
      });
      expect(aoMudar).toHaveBeenCalled();
    } finally {
      jest.useRealTimers();
    }
  });

  it('não reassina o canal quando a tela re-renderiza', () => {
    // `tabelas` é um literal no corpo do componente: identidade nova a cada
    // render. Comparar por identidade derrubaria e refaria o canal sem parar.
    const { rerender } = renderHook(
      ({ cb }) =>
        useRealtimeRefresh({
          canal: 'c1',
          tabelas: [{ table: 'cash_seats', filter: 'table_id=eq.m1' }],
          aoMudar: cb,
        }),
      { initialProps: { cb: jest.fn() } }
    );

    rerender({ cb: jest.fn() });
    rerender({ cb: jest.fn() });

    expect(supabase.channel).toHaveBeenCalledTimes(1);
    expect(supabase.removeChannel).not.toHaveBeenCalled();
  });
});
