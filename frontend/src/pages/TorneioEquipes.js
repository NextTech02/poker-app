import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useParams, useSearchParams } from 'react-router-dom';
import Sidebar from '../components/Sidebar';
import Button from '../components/Button';
import Breadcrumb from '../components/Breadcrumb';
import api from '../config/api';
import { useToast } from '../contexts/ToastContext';
import { useRealtimeRefresh } from '../hooks/useRealtimeRefresh';
import EquipeFormModal from '../components/equipes/EquipeFormModal';
import CobrarEquipeModal from '../components/equipes/CobrarEquipeModal';
import Fase1Tab from '../components/equipes/Fase1Tab';
import FinalTab from '../components/equipes/FinalTab';
import { JOGADORES_POR_EQUIPE } from '../utils/equipes';
import '../components/equipes/Equipes.css';
import './TorneioEquipes.css';

const ABAS = ['equipes', 'fase1', 'final'];
const VIVOS = new Set(['registered', 'active']);

/**
 * Torneio por equipes (bases do NSOP): cadastro das equipes, Fase 1 (mesas,
 * pontos, conferência e oficialização) e a final por revezamento.
 */
const TorneioEquipes = () => {
  const { id } = useParams();
  const { t } = useTranslation();
  const { toast, confirm } = useToast();
  const [busca] = useSearchParams();
  const [aba, setAba] = useState(ABAS.includes(busca.get('aba')) ? busca.get('aba') : 'equipes');
  const [dados, setDados] = useState(null);
  const [fase1, setFase1] = useState(null);
  const [relay, setRelay] = useState(null);
  const [erro, setErro] = useState('');
  const [editando, setEditando] = useState(null); // equipe | 'nova' | null
  const [cobrando, setCobrando] = useState(null);
  const [ocupado, setOcupado] = useState(false);
  const [erroModal, setErroModal] = useState('');

  const carregar = useCallback(async () => {
    try {
      const res = await api.get(`/tournaments/${id}/teams`);
      setDados(res.data);
      setErro('');
      if (aba === 'fase1') {
        const r = await api.get(`/tournaments/${id}/teams/stage1`);
        setFase1(r.data);
      }
      if (aba === 'final') {
        const r = await api.get(`/tournaments/${id}/teams/relay`);
        setRelay(r.data);
      }
    } catch (err) {
      setErro(err.userMessage || t('teams.loadError', 'Não foi possível carregar as equipes.'));
    }
  }, [id, aba, t]);

  useEffect(() => { carregar(); }, [carregar]);

  useRealtimeRefresh({
    canal: `equipes-${id}`,
    tabelas: [
      { table: 'tournament_players', filter: `tournament_id=eq.${id}` },
      { table: 'tournament_team_results', filter: `tournament_id=eq.${id}` },
      { table: 'tournament_teams', filter: `tournament_id=eq.${id}` },
      { table: 'seat_allocations', filter: `tournament_id=eq.${id}` },
    ],
    aoMudar: carregar,
    ativo: !!id,
  });

  const inscritosVivos = useMemo(() => {
    // Prévia das mesas: integrantes inscritos e vivos (avulsos entram pelo resumo da Fase 1).
    const membros = (dados?.teams || []).flatMap((e) => e.members);
    return membros.filter((m) => m.tp_id && VIVOS.has(m.status)).length;
  }, [dados]);

  const salvarEquipe = async (corpo) => {
    setOcupado(true);
    setErroModal('');
    try {
      if (editando && editando !== 'nova') {
        await api.patch(`/tournaments/${id}/teams/${editando.id}`, corpo);
      } else {
        await api.post(`/tournaments/${id}/teams`, corpo);
      }
      setEditando(null);
      await carregar();
    } catch (err) {
      setErroModal(err.userMessage || t('teams.saveError', 'Não foi possível salvar a equipe.'));
    } finally {
      setOcupado(false);
    }
  };

  const excluir = async (equipe) => {
    if (!(await confirm(t('teams.deleteConfirm', 'Excluir a equipe {{nome}}? As inscrições dos integrantes continuam.', { nome: equipe.name })))) return;
    try {
      await api.delete(`/tournaments/${id}/teams/${equipe.id}`);
      await carregar();
    } catch (err) {
      toast.error(err.userMessage || t('teams.actionError', 'Não foi possível concluir.'));
    }
  };

  const estornar = async (equipe) => {
    if (!(await confirm(t('teams.refundConfirm', 'Estornar a cobrança da equipe {{nome}}? Cada venda "por equipe" dos integrantes é estornada.', { nome: equipe.name })))) return;
    try {
      const res = await api.post(`/tournaments/${id}/teams/${equipe.id}/charge/cancel`, {});
      toast.success(t('teams.refunded', '{{n}} venda(s) estornada(s).', { n: res?.data?.cancelled ?? 0 }));
      await carregar();
    } catch (err) {
      toast.error(err.userMessage || t('teams.actionError', 'Não foi possível concluir.'));
    }
  };

  const torneio = dados?.tournament;
  const oficial = !!torneio?.team_results_official_at;

  return (
    <div className="app-container">
      <Sidebar />
      <main className="main-content eq-pagina">
        <Breadcrumb items={[
          { label: t('common.home'), to: '/' },
          { label: t('tournaments.title'), to: '/torneios' },
          { label: torneio?.name || '…', to: `/torneios/${id}` },
          { label: t('teams.title', 'Equipes') },
        ]} />
        <div className="page-header">
          <div>
            <h1>{t('teams.title', 'Equipes')} — {torneio?.name || ''}</h1>
            <p className="subtitle">
              {t('teams.subtitle', 'Equipes de 4: Fase 1 com pontos pela posição em cada mesa e final por revezamento.')}
            </p>
          </div>
        </div>

        {erro && <div className="eq-erro" role="alert">{erro}</div>}

        <div className="eq-abas" role="tablist">
          {ABAS.map((nome) => (
            <button
              key={nome}
              type="button"
              role="tab"
              aria-selected={aba === nome}
              className={`eq-aba ${aba === nome ? 'active' : ''}`}
              onClick={() => setAba(nome)}
            >
              {t(`teams.tab_${nome}`, { equipes: 'Equipes', fase1: 'Fase 1', final: 'Final' }[nome])}
            </button>
          ))}
        </div>

        {!dados ? (
          !erro && <div className="loading">{t('common.loading')}</div>
        ) : aba === 'equipes' ? (
          <div className="eq-bloco">
            <div className="eq-bloco-header">
              <h3>{t('teams.teamsCount', '{{n}} equipe(s)', { n: dados.teams.length })}</h3>
              <Button size="small" onClick={() => { setErroModal(''); setEditando('nova'); }} disabled={oficial}>
                {t('teams.newTeam', 'Nova equipe')}
              </Button>
            </div>
            <p className="eq-hint">
              {t('teams.registrationHint', 'Inscrição: cada integrante pode comprar no Caixa (por jogador) ou a equipe inteira de uma vez em "Cobrar equipe" (meio de entrada marcado "Por equipe").')}
            </p>
            {dados.teams.length === 0 ? (
              <p className="eq-hint">{t('teams.empty', 'Nenhuma equipe cadastrada ainda.')}</p>
            ) : (
              <div className="eq-cartoes">
                {dados.teams.map((equipe) => {
                  const inscritos = equipe.members.filter((m) => m.tp_id && m.status !== 'cancelled').length;
                  return (
                    <div className="eq-cartao" key={equipe.id}>
                      <div className="eq-cartao-header">
                        <strong>{equipe.name}</strong>
                        <span className={`eq-selo ${inscritos === equipe.members.length ? 'ok' : ''}`}>
                          {t('teams.registeredCount', '{{n}}/{{total}} inscritos', { n: inscritos, total: equipe.members.length })}
                        </span>
                      </div>
                      <ol className="eq-integrantes">
                        {equipe.members.map((m) => (
                          <li key={m.player_id}>
                            <span>{m.name}{m.is_captain ? ` · ${t('teams.captain', 'Capitão')}` : ''}</span>
                            <span className={`eq-situacao eq-situacao-${m.status || 'none'}`}>
                              {m.status ? t(`teams.memberStatus_${m.status}`, m.status) : t('teams.notRegistered', 'não inscrito')}
                            </span>
                          </li>
                        ))}
                      </ol>
                      {equipe.members.length < JOGADORES_POR_EQUIPE && (
                        <p className="eq-aviso-curto">{t('teams.incomplete', 'Equipe com menos de 4 integrantes.')}</p>
                      )}
                      <div className="eq-cartao-acoes">
                        <Button size="small" variant="secondary" onClick={() => { setErroModal(''); setEditando(equipe); }} disabled={oficial}>
                          {t('common.edit', 'Editar')}
                        </Button>
                        <Button size="small" onClick={() => setCobrando(equipe)} disabled={inscritos === equipe.members.length}>
                          {t('teams.charge', 'Cobrar equipe')}
                        </Button>
                        {inscritos > 0 && (
                          <button type="button" className="eq-link-btn" onClick={() => estornar(equipe)}>
                            {t('teams.refund', 'Estornar cobrança')}
                          </button>
                        )}
                        <button type="button" className="eq-link-btn perigo" onClick={() => excluir(equipe)} disabled={oficial}>
                          {t('common.delete', 'Excluir')}
                        </button>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        ) : aba === 'fase1' ? (
          <Fase1Tab tournamentId={id} torneio={torneio} resumo={fase1} inscritosVivos={inscritosVivos} onMudou={carregar} />
        ) : (
          relay ? <FinalTab tournamentId={id} dados={dados} relay={relay} onMudou={carregar} />
            : <div className="loading">{t('common.loading')}</div>
        )}

        {editando && (
          <EquipeFormModal
            equipe={editando === 'nova' ? null : editando}
            onSalvar={salvarEquipe}
            onFechar={() => setEditando(null)}
            ocupado={ocupado}
            erro={erroModal}
          />
        )}
        {cobrando && (
          <CobrarEquipeModal
            tournamentId={id}
            equipe={cobrando}
            onFechar={() => setCobrando(null)}
            onCobrado={(res) => {
              setCobrando(null);
              toast.success(t('teams.charged', 'Equipe cobrada: {{n}} inscrição(ões).', { n: res?.charged ?? 0 }));
              carregar();
            }}
          />
        )}
      </main>
    </div>
  );
};

export default TorneioEquipes;
