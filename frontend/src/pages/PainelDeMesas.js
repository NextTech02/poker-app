import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import Sidebar from '../components/Sidebar';
import Icon from '../components/Icon';
import SeatTicket from '../components/SeatTicket';
import ModaisDaEliminacao from '../components/ko/ModaisDaEliminacao';
import api from '../config/api';
import { useToast } from '../contexts/ToastContext';
import { useEliminacaoNoAssento } from '../hooks/useEliminacaoNoAssento';
import { useEscapeKey } from '../hooks/useEscapeKey';
import { MODO_MESA, modoDoTorneio } from '../hooks/useModoDeEliminacao';
import { usePresencaDoRelogio } from '../hooks/usePresencaDoRelogio';
import { useRealtimeRefresh } from '../hooks/useRealtimeRefresh';
import { useTorneioKo } from '../hooks/useTorneioKo';
import { equilibrio } from '../utils/equilibrioDasMesas';
import { assentosDaMesa, nomeCurto, posicaoDoAssento } from '../utils/mesaDesenhada';
import './PainelDeMesas.css';

// Quantos eliminados ficam à vista para desfazer um engano.
const ELIMINADOS_A_VISTA = 5;

const motivoDoErro = (err) => {
  const detail = err?.response?.data?.detail;
  return err?.userMessage || (typeof detail === 'string' ? detail : detail?.message) || err?.message;
};

const lugaresQueRecebem = (mesa) => mesa.seats - (mesa.blocked_seats || []).length;

/**
 * Painel de mesas: todas as mesas desenhadas numa tela, para o floor e o
 * diretor verem e agirem pelo tablet ou pelo celular. Tocar no assento abre as
 * ações. Eliminar usa o mesmo caminho da Gestão de Mesas
 * (useEliminacaoNoAssento); montar mesas e distribuir em lote continuam lá.
 */
const PainelDeMesas = () => {
  const { dayId } = useParams();
  const { t } = useTranslation();
  const { toast } = useToast();

  const [day, setDay] = useState(null);
  const [torneioNome, setTorneioNome] = useState('');
  const [tables, setTables] = useState([]);
  const [allocations, setAllocations] = useState([]);
  const [semMesa, setSemMesa] = useState([]);
  const [inscritos, setInscritos] = useState([]);
  // tournament_player_id → cartões. Nulo sem time bank ou sem acesso a ele.
  const [cartoes, setCartoes] = useState(null);
  const [carregado, setCarregado] = useState(false);
  const [falha, setFalha] = useState('');
  // { tipo: 'jogador', alocacao } | { tipo: 'livre', mesa, assento }
  // | { tipo: 'destino', jogador: { playerId, nome, allocationId, mesaAtual }, mesaId }
  const [escolha, setEscolha] = useState(null);
  const [gravando, setGravando] = useState(false);
  const [bilhete, setBilhete] = useState(null);
  const abertas = usePresencaDoRelogio(dayId);

  const carregar = useCallback(async () => {
    try {
      const [dRes, tRes, aRes, uRes] = await Promise.all([
        api.get(`/tournament-days/${dayId}`),
        api.get(`/tables/day/${dayId}`),
        api.get(`/allocations/day/${dayId}`),
        api.get(`/allocations/day/${dayId}/unallocated`),
      ]);
      setDay(dRes.data);
      setTables(tRes.data || []);
      setAllocations(aRes.data || []);
      setSemMesa(uRes.data || []);
      setCarregado(true);
      setFalha('');
    } catch (erro) {
      setFalha(erro.userMessage || t('floorPanel.loadError', 'Não deu para abrir o painel.'));
      return;
    }
    // Fora do Promise.all, como na Gestão de Mesas: sem os inscritos as mesas
    // continuam à vista; só eliminar fica sem a quem apontar.
    api.get(`/tournament-players/day/${dayId}`, { _silentError: true })
      .then((res) => setInscritos(Array.isArray(res?.data) ? res.data : []))
      .catch(() => {});
    api.get(`/table-clock/day/${dayId}/panel`, { _silentError: true })
      .then((res) => setCartoes(res?.data?.time_bank?.available
        ? new Map((res.data.players || []).map((p) => [p.tournament_player_id, p.cards]))
        : null))
      .catch(() => setCartoes(null));
  }, [dayId, t]);

  useEffect(() => {
    carregar();
  }, [carregar]);

  const torneioId = day?.tournament_id;
  useEffect(() => {
    if (!torneioId) return;
    api.get(`/tournaments/${torneioId}`, { _silentError: true })
      .then((res) => setTorneioNome(res?.data?.name || ''))
      .catch(() => {});
  }, [torneioId]);

  useRealtimeRefresh({
    canal: `painel-mesas-${dayId}`,
    tabelas: [
      { table: 'tournament_tables', filter: `tournament_day_id=eq.${dayId}` },
      { table: 'seat_allocations', filter: `tournament_day_id=eq.${dayId}` },
      { table: 'tournament_players', filter: `tournament_day_id=eq.${dayId}` },
      { table: 'time_bank_events', filter: `tournament_day_id=eq.${dayId}` },
    ],
    aoMudar: carregar,
    ativo: !!dayId,
  });

  const ko = useTorneioKo(torneioId);
  const porMesa = !!ko.torneio && modoDoTorneio(ko.torneio) === MODO_MESA;

  const inscritoPorJogador = useMemo(
    () => new Map(inscritos.map((i) => [i.player_id, i])),
    [inscritos]
  );
  const assentoPorJogador = useMemo(() => {
    const numeroDaMesa = new Map(tables.map((m) => [m.id, m.table_number]));
    return new Map(allocations.map((a) => [
      a.player_id, { mesa: numeroDaMesa.get(a.table_id) ?? null, assento: a.seat_number },
    ]));
  }, [allocations, tables]);

  const ativas = useMemo(
    () => tables.filter((m) => m.status === 'active').sort((a, b) => a.table_number - b.table_number),
    [tables]
  );
  // Eliminado ainda sentado (assento não liberado) não conta como jogando.
  const sentadosPorMesa = useMemo(() => {
    const mapa = new Map();
    allocations.forEach((a) => {
      if (inscritoPorJogador.get(a.player_id)?.status === 'eliminated') return;
      if (!mapa.has(a.table_id)) mapa.set(a.table_id, []);
      mapa.get(a.table_id).push(a);
    });
    return mapa;
  }, [allocations, inscritoPorJogador]);

  const resumoDasMesas = ativas.map((m) => ({
    id: m.id,
    numero: m.table_number,
    jogadores: (sentadosPorMesa.get(m.id) || []).length,
    lugares: lugaresQueRecebem(m),
  }));
  const jogadoresPorMesa = new Map(resumoDasMesas.map((r) => [r.id, r]));
  const { mover, quebrar } = equilibrio(resumoDasMesas);
  const jogando = resumoDasMesas.reduce((soma, r) => soma + r.jogadores, 0);
  const eliminados = porMesa
    ? inscritos
      .filter((i) => i.status === 'eliminated')
      .sort((a, b) => String(b.eliminated_at || '').localeCompare(String(a.eliminated_at || '')))
      .slice(0, ELIMINADOS_A_VISTA)
    : [];

  const eliminacao = useEliminacaoNoAssento({
    ko, inscritos, setInscritos, assentoPorJogador, aoMudar: carregar,
  });

  const fecharEscolha = useCallback(() => setEscolha(null), []);
  const fecharBilhete = useCallback(() => setBilhete(null), []);
  useEscapeKey(!!escolha && !gravando, fecharEscolha);
  useEscapeKey(!!bilhete, fecharBilhete);

  const cartoesDe = (playerId) => {
    const inscrito = inscritoPorJogador.get(playerId);
    return cartoes && inscrito && cartoes.has(inscrito.id) ? cartoes.get(inscrito.id) : null;
  };

  const gravarAssento = async (jogador, mesaId, assento) => {
    setGravando(true);
    try {
      let lugar;
      if (jogador.allocationId) {
        await api.patch(`/allocations/${jogador.allocationId}`, { table_id: mesaId, seat_number: assento });
        lugar = (await api.get(`/allocations/${jogador.allocationId}`)).data;
      } else {
        lugar = (await api.post(`/allocations/day/${dayId}/manual`, {
          player_id: jogador.playerId, table_id: mesaId, seat_number: assento,
        })).data;
      }
      setEscolha(null);
      setBilhete(lugar);
      carregar();
    } catch (err) {
      toast.error(jogador.allocationId
        ? t('floorPanel.moveError', { defaultValue: 'Não deu para trocar de mesa: {{detail}}', detail: motivoDoErro(err) })
        : t('floorPanel.seatError', { defaultValue: 'Não deu para sentar o jogador: {{detail}}', detail: motivoDoErro(err) }));
    } finally {
      setGravando(false);
    }
  };

  const assentosLivres = (mesa) => {
    const ocupados = new Set(allocations.filter((a) => a.table_id === mesa.id).map((a) => a.seat_number));
    const bloqueados = mesa.blocked_seats || [];
    return Array.from({ length: mesa.seats }, (_, i) => i + 1)
      .filter((n) => !ocupados.has(n) && !bloqueados.includes(n));
  };

  const pedirEliminacao = (alocacao) => {
    setEscolha(null);
    eliminacao.pedirEliminacao({ playerId: alocacao.player_id, nome: alocacao.players?.name });
  };

  if (!carregado) {
    return (
      <div className="app-container">
        <Sidebar />
        <main className="main-content">
          {falha ? <p className="pm-falha" role="alert">{falha}</p> : <p className="loading">{t('common.loading')}</p>}
        </main>
      </div>
    );
  }

  const numeroDe = (mesaId) => tables.find((m) => m.id === mesaId)?.table_number;

  const ehSugerida = (mesa, jogador) => {
    // Quem já está sentado: a mesa da dica de equilíbrio. Quem chega: a mais vazia.
    if (jogador.mesaAtual) return !!mover && mover.de.id === jogador.mesaAtual && mover.para.id === mesa.id;
    const maisVazia = resumoDasMesas
      .filter((r) => r.jogadores < r.lugares)
      .reduce((a, b) => (!a || b.jogadores < a.jogadores ? b : a), null);
    return maisVazia?.id === mesa.id;
  };

  const desenharMesa = (mesa) => {
    const sentados = sentadosPorMesa.get(mesa.id) || [];
    const lugares = assentosDaMesa(mesa.seats, sentados, mesa.blocked_seats || []);
    const resumo = jogadoresPorMesa.get(mesa.id);
    return (
      <section key={mesa.id} className="pm-mesa">
        <h2 className="pm-mesa-titulo">
          <span>{t('floorPanel.table', { defaultValue: 'Mesa {{number}}', number: mesa.table_number })}</span>
          <span className="pm-ocupacao">{`${resume(resumo)}`}</span>
          {abertas.includes(mesa.id) && (
            <span className="pm-relogio">{t('floorPanel.clockOpen', 'Relógio')}</span>
          )}
        </h2>
        <div className="pm-desenho">
          <div className="pm-feltro" aria-hidden="true">{mesa.table_number}</div>
          {lugares.map(({ numero, jogador, bloqueado }, indice) => {
            const { x, y } = posicaoDoAssento(indice, lugares.length);
            const nCartoes = jogador ? cartoesDe(jogador.player_id) : null;
            const livreParaSentar = !jogador && !bloqueado && semMesa.length > 0;
            let classe = 'pm-assento';
            if (!jogador) classe += ' pm-assento--vazio';
            if (bloqueado) classe += ' pm-assento--bloqueado';
            return (
              <button
                key={numero}
                type="button"
                className={classe}
                style={{ left: `${x}%`, top: `${y}%` }}
                disabled={!jogador && !livreParaSentar}
                onClick={() => setEscolha(jogador
                  ? { tipo: 'jogador', alocacao: jogador }
                  : { tipo: 'livre', mesa, assento: numero })}
              >
                <span className="pm-assento-numero">{numero}</span>
                {/* Cartões na segunda linha: na mesma, tomavam o lugar do nome. */}
                <span className="pm-assento-info">
                  <span className="pm-assento-nome">
                    {jogador
                      ? nomeCurto(jogador.players?.name)
                      : bloqueado ? t('floorPanel.blocked', 'Bloqueado') : t('floorPanel.empty', 'Livre')}
                  </span>
                  {nCartoes != null && (
                    <span className="pm-cartoes" title={t('floorPanel.cardsTitle', 'Cartões de time bank')}>{nCartoes}</span>
                  )}
                </span>
              </button>
            );
          })}
        </div>
      </section>
    );
  };

  // `x/y`: sentados e cadeiras que recebem jogador.
  function resume(r) {
    return r ? `${r.jogadores}/${r.lugares}` : '';
  }

  const janelaDoJogador = () => {
    const { alocacao } = escolha;
    const nome = alocacao.players?.name;
    const nCartoes = cartoesDe(alocacao.player_id);
    return (
      <>
        <h2>{nome}</h2>
        <p className="pm-janela-sub">
          {t('floorPanel.seatOf', {
            defaultValue: 'Mesa {{table}} · assento {{seat}}',
            table: numeroDe(alocacao.table_id), seat: alocacao.seat_number,
          })}
        </p>
        {nCartoes != null && (
          <p className="pm-janela-sub">
            {t('floorPanel.cards', { defaultValue: 'Cartões: {{cards}}', cards: nCartoes })}
          </p>
        )}
        {!porMesa && (
          <p className="pm-janela-nota">
            {t('floorPanel.bulkHint', 'Eliminação em massa: elimine pelo contador do Controle.')}
          </p>
        )}
        <div className="pm-janela-acoes">
          {porMesa && (
            <button type="button" className="pm-acao pm-acao--perigo" onClick={() => pedirEliminacao(alocacao)}>
              {t('floorPanel.eliminate', 'Eliminar')}
            </button>
          )}
          <button
            type="button"
            className="pm-acao"
            onClick={() => setEscolha({
              tipo: 'destino',
              jogador: { playerId: alocacao.player_id, nome, allocationId: alocacao.id, mesaAtual: alocacao.table_id },
              mesaId: null,
            })}
          >
            {t('floorPanel.changeTable', 'Trocar de mesa')}
          </button>
          <button type="button" className="pm-acao pm-acao--neutra" onClick={fecharEscolha}>
            {t('floorPanel.close', 'Fechar')}
          </button>
        </div>
      </>
    );
  };

  const janelaDoLugarLivre = () => (
    <>
      <h2>
        {t('floorPanel.seatOf', {
          defaultValue: 'Mesa {{table}} · assento {{seat}}',
          table: escolha.mesa.table_number, seat: escolha.assento,
        })}
      </h2>
      <p className="pm-janela-sub">{t('floorPanel.whoSitsHere', 'Quem senta aqui?')}</p>
      <div className="pm-janela-lista">
        {semMesa.map((j) => (
          <button
            key={j.player_id}
            type="button"
            className="pm-acao"
            disabled={gravando}
            onClick={() => gravarAssento(
              { playerId: j.player_id, nome: j.player_name, allocationId: null }, escolha.mesa.id, escolha.assento,
            )}
          >
            {j.player_name}
          </button>
        ))}
      </div>
      <div className="pm-janela-acoes">
        <button type="button" className="pm-acao pm-acao--neutra" onClick={fecharEscolha}>
          {t('floorPanel.close', 'Fechar')}
        </button>
      </div>
    </>
  );

  const janelaDoDestino = () => {
    const { jogador, mesaId } = escolha;
    const titulo = jogador.allocationId
      ? t('floorPanel.moveTitle', { defaultValue: 'Trocar {{name}} de mesa', name: jogador.nome })
      : t('floorPanel.seatTitle', { defaultValue: 'Sentar {{name}}', name: jogador.nome });
    const destino = mesaId ? ativas.find((m) => m.id === mesaId) : null;
    return (
      <>
        <h2>{titulo}</h2>
        {!destino ? (
          <>
            <p className="pm-janela-sub">{t('floorPanel.chooseTable', 'Escolha a mesa')}</p>
            <div className="pm-janela-lista">
              {ativas.filter((m) => m.id !== jogador.mesaAtual).map((m) => {
                const livres = assentosLivres(m).length;
                const r = jogadoresPorMesa.get(m.id);
                return (
                  <button
                    key={m.id}
                    type="button"
                    className="pm-acao pm-acao--mesa"
                    disabled={livres === 0}
                    onClick={() => setEscolha({ ...escolha, mesaId: m.id })}
                  >
                    <span>
                      {t('floorPanel.table', { defaultValue: 'Mesa {{number}}', number: m.table_number })}
                      {` · ${resume(r)}`}
                    </span>
                    {ehSugerida(m, jogador) && (
                      <span className="pm-sugerida">{t('floorPanel.suggested', 'Sugerida')}</span>
                    )}
                  </button>
                );
              })}
            </div>
          </>
        ) : (
          <>
            <p className="pm-janela-sub">
              {t('floorPanel.chooseSeat', { defaultValue: 'Escolha o assento na mesa {{table}}', table: destino.table_number })}
            </p>
            <div className="pm-janela-lista pm-janela-lista--assentos">
              {assentosLivres(destino).map((n) => (
                <button
                  key={n}
                  type="button"
                  className="pm-acao"
                  disabled={gravando}
                  onClick={() => gravarAssento(jogador, destino.id, n)}
                >
                  {t('floorPanel.seatN', { defaultValue: 'Assento {{seat}}', seat: n })}
                </button>
              ))}
            </div>
          </>
        )}
        <div className="pm-janela-acoes">
          {destino && (
            <button type="button" className="pm-acao pm-acao--neutra" onClick={() => setEscolha({ ...escolha, mesaId: null })}>
              {t('floorPanel.back', 'Voltar')}
            </button>
          )}
          <button type="button" className="pm-acao pm-acao--neutra" onClick={fecharEscolha}>
            {t('floorPanel.close', 'Fechar')}
          </button>
        </div>
      </>
    );
  };

  return (
    <div className="app-container">
      <Sidebar />
      <main className="main-content pm-tela">
        <div className="cx-header">
          <div className="cx-header-left">
            <div className="cx-header-icon"><Icon name="grid" /></div>
            <div>
              <h1 className="cx-title">{t('floorPanel.title', 'Painel de mesas')}</h1>
              <p className="cx-subtitle">{[torneioNome, day?.day_name].filter(Boolean).join(' · ')}</p>
            </div>
          </div>
          <div className="pm-links">
            <Link to={`/alocacao/dia/${dayId}`}>{t('floorPanel.manageTables', 'Gestão de mesas')}</Link>
            <Link to={`/relogio-mesa/${dayId}`}>{t('floorPanel.tableClock', 'Relógio de mesa')}</Link>
          </div>
        </div>

        <p className="pm-resumo">
          {t('floorPanel.summary', { defaultValue: '{{players}} jogando · {{tables}} mesas', players: jogando, tables: ativas.length })}
          {semMesa.length > 0 && (
            <strong>{` · ${t('floorPanel.withoutTable', { defaultValue: 'Sem mesa: {{total}}', total: semMesa.length })}`}</strong>
          )}
        </p>

        {(mover || quebrar) && (
          <div className="pm-alertas" role="status">
            {quebrar && (
              <p>
                {t('floorPanel.balanceBreak', {
                  defaultValue: 'Dá para quebrar a mesa {{table}}: os {{players}} jogadores cabem nas outras mesas.',
                  table: quebrar.mesa.numero, players: quebrar.jogadores,
                })}
              </p>
            )}
            {mover && (
              <p>
                {t('floorPanel.balanceMove', {
                  defaultValue: 'Equilibrar: passe 1 jogador da mesa {{from}} ({{fromCount}}) para a mesa {{to}} ({{toCount}}).',
                  from: mover.de.numero, fromCount: mover.de.jogadores, to: mover.para.numero, toCount: mover.para.jogadores,
                })}
              </p>
            )}
          </div>
        )}

        {semMesa.length > 0 && (
          <section className="pm-faixa pm-sem-mesa">
            <h2>{t('floorPanel.withoutTableTitle', 'Sem mesa')}</h2>
            <div className="pm-faixa-itens">
              {semMesa.map((j) => (
                <button
                  key={j.player_id}
                  type="button"
                  className="pm-chip"
                  onClick={() => setEscolha({
                    tipo: 'destino',
                    jogador: { playerId: j.player_id, nome: j.player_name, allocationId: null, mesaAtual: null },
                    mesaId: null,
                  })}
                >
                  {j.player_name}
                </button>
              ))}
            </div>
          </section>
        )}

        {ativas.length === 0 ? (
          <p className="pm-vazio">{t('floorPanel.noTables', 'Este dia ainda não tem mesas ativas.')}</p>
        ) : (
          <div className="pm-mesas">{ativas.map(desenharMesa)}</div>
        )}

        {eliminados.length > 0 && (
          <section className="pm-faixa pm-eliminados">
            <h2>{t('floorPanel.eliminatedTitle', 'Eliminados agora há pouco')}</h2>
            <div className="pm-faixa-itens">
              {eliminados.map((i) => (
                <span key={i.id} className="pm-eliminado">
                  {i.player_name}
                  <button
                    type="button"
                    onClick={() => eliminacao.desfazerEliminacao(i)}
                    aria-label={`${t('floorPanel.undo', 'Desfazer')}: ${i.player_name}`}
                  >
                    {t('floorPanel.undo', 'Desfazer')}
                  </button>
                </span>
              ))}
            </div>
          </section>
        )}

        {escolha && (
          <div
            className="modal-overlay"
            role="presentation"
            onClick={(e) => { if (e.target === e.currentTarget && !gravando) fecharEscolha(); }}
          >
            <div className="modal pm-janela" role="dialog" aria-modal="true">
              {escolha.tipo === 'jogador' && janelaDoJogador()}
              {escolha.tipo === 'livre' && janelaDoLugarLivre()}
              {escolha.tipo === 'destino' && janelaDoDestino()}
            </div>
          </div>
        )}

        {bilhete && (
          <div
            className="modal-overlay"
            role="presentation"
            onClick={(e) => { if (e.target === e.currentTarget) fecharBilhete(); }}
          >
            <div className="modal pm-janela" role="dialog" aria-modal="true">
              <h2>{t('floorPanel.playerSeated', 'Jogador no lugar novo')}</h2>
              <SeatTicket allocation={bilhete} />
              <div className="pm-janela-acoes">
                <button type="button" className="pm-acao pm-acao--neutra" onClick={fecharBilhete}>
                  {t('floorPanel.close', 'Fechar')}
                </button>
              </div>
            </div>
          </div>
        )}

        <ModaisDaEliminacao
          eliminacao={eliminacao}
          ko={ko}
          tournamentId={torneioId}
          torneioNome={torneioNome}
          assentoPorJogador={assentoPorJogador}
          onPago={carregar}
        />
      </main>
    </div>
  );
};

export default PainelDeMesas;
