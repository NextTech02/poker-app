import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import Sidebar from '../components/Sidebar';
import Icon from '../components/Icon';
import Card from '../components/Card';
import Button from '../components/Button';
import EmptyState from '../components/EmptyState';
import api from '../config/api';
import { useToast } from '../contexts/ToastContext';
import { useStage } from '../contexts/StageContext';
import { useCurrency } from '../contexts/CurrencyContext';
import { referenciaEmOutraMoeda } from '../utils/rankingPontos';
import { exportSections } from '../utils/reportExport';
import './RankingPontos.css';

/**
 * Ranking de pontos (Manual de Ranking NSOP).
 *
 * - Etapa: soma os torneios oficializados da etapa.
 * - Temporadas: um grupo de etapas, somando só os N melhores resultados de
 *   cada jogador (o manual sugere 8).
 * - Regras: os parâmetros da fórmula, que o clube anuncia antes da temporada.
 *
 * Os pontos de cada torneio são congelados na aba "Ranking" da Premiação; esta
 * tela só lê e soma. Empate: mais 1ºs → 2ºs → 3ºs → mesas finais → melhor
 * resultado; persistindo, a posição é compartilhada (o "=").
 */
const codigoDoErro = (err) => err?.response?.data?.detail?.code;

const CAMPOS_DAS_REGRAS = [
  ['pontos_base', 'Pontos do 1º (base)'],
  ['jogadores_referencia', 'Jogadores únicos de referência'],
  ['jogadores_expoente', 'Expoente dos jogadores'],
  ['jogadores_fator_minimo', 'Fator de jogadores: piso'],
  ['jogadores_fator_maximo', 'Fator de jogadores: teto'],
  ['buy_in_referencia', 'Buy-in de referência'],
  ['buy_in_expoente', 'Expoente do buy-in'],
  ['buy_in_fator_minimo', 'Fator de buy-in: piso'],
  ['buy_in_fator_maximo', 'Fator de buy-in: teto'],
  ['minimo_de_jogadores', 'Mínimo de jogadores únicos para pontuar'],
];

// ── Tabela de classificação (etapa e temporada) ──────────────────────────────

const Classificacao = ({ dados, titulo, nomeDoArquivo }) => {
  const { t } = useTranslation();
  const torneios = dados?.tournaments || [];
  const linhas = dados?.standings || [];
  const temporada = dados?.best_results != null;

  const exportar = async (format) => {
    const colunas = [
      { key: 'posicao', label: t('pointsRanking.colPosition', 'Posição'), type: 'text' },
      { key: 'player_name', label: t('pointsRanking.colPlayer', 'Jogador'), type: 'text' },
      ...torneios.map((tr) => ({ key: `t:${tr.id}`, label: tr.name, type: 'int' })),
      { key: 'total', label: t('pointsRanking.colTotal', 'Total'), type: 'int' },
      { key: 'events', label: t('pointsRanking.colEvents', 'Torneios'), type: 'int' },
      { key: 'firsts', label: t('pointsRanking.colFirsts', '1ºs'), type: 'int' },
      { key: 'seconds', label: t('pointsRanking.colSeconds', '2ºs'), type: 'int' },
      { key: 'thirds', label: t('pointsRanking.colThirds', '3ºs'), type: 'int' },
      { key: 'final_tables', label: t('pointsRanking.colFinalTables', 'Mesas finais'), type: 'int' },
    ];
    const rows = linhas.map((l) => ({
      ...l,
      posicao: `${l.position}${l.tied ? '=' : ''}`,
      ...Object.fromEntries(torneios.map((tr) => [`t:${tr.id}`, l.by_tournament?.[tr.id] ?? null])),
    }));
    try {
      await exportSections([{ kind: 'table', title: titulo, columns: colunas, rows }], {
        format,
        filename: nomeDoArquivo,
        meta: {
          title: titulo,
          subtitle: temporada
            ? t('pointsRanking.bestResultsNote', 'Somam os {{n}} melhores resultados de cada jogador.', { n: dados.best_results })
            : t('pointsRanking.stageNote', 'Soma de todos os torneios oficializados.'),
          footer: t('pointsRanking.title', 'Ranking de pontos'),
        },
      });
    } catch {
      /* exportSections só recusa seção vazia: o botão nem aparece sem linhas */
    }
  };

  return (
    <>
      {(dados?.pending || []).length > 0 && (
        <div className="rk-card rk-aviso">
          <strong>{t('pointsRanking.pendingTitle', 'Torneios pontuáveis ainda não oficializados:')}</strong>{' '}
          {dados.pending.map((p, i) => (
            <React.Fragment key={p.id}>
              {i > 0 && ', '}
              <Link to={`/premiacao/${p.id}?aba=ranking`}>{p.name}</Link>
            </React.Fragment>
          ))}
        </div>
      )}
      {linhas.length === 0 ? (
        <EmptyState
          icon={null}
          title={t('pointsRanking.emptyTitle', 'Nenhum resultado oficializado ainda')}
          subtitle={t('pointsRanking.emptyHint', 'Na Premiação de cada torneio pontuável, aba Ranking, confira as posições premiadas e oficialize.')}
        />
      ) : (
        <>
          <div className="rk-exportar">
            <Button size="small" variant="secondary" onClick={() => exportar('pdf')}>PDF</Button>
            <Button size="small" variant="secondary" onClick={() => exportar('xlsx')}>Excel</Button>
          </div>
          <div className="table-container">
            <table className="rk-tabela rk-tabela--classificacao">
              <thead>
                <tr>
                  <th className="rk-num">{t('pointsRanking.colPosition', 'Posição')}</th>
                  <th>{t('pointsRanking.colPlayer', 'Jogador')}</th>
                  {torneios.map((tr) => (
                    <th key={tr.id} className="rk-num" title={tr.name}>
                      <span className="rk-col-torneio">{tr.name}</span>
                    </th>
                  ))}
                  <th className="rk-num">{t('pointsRanking.colTotal', 'Total')}</th>
                  <th className="rk-num">{t('pointsRanking.colEvents', 'Torneios')}</th>
                  <th className="rk-num" title={t('pointsRanking.tiebreakHint', 'Desempate: 1ºs, 2ºs, 3ºs, mesas finais e melhor resultado')}>
                    {t('pointsRanking.colFirsts', '1ºs')}
                  </th>
                  <th className="rk-num">{t('pointsRanking.colFinalTables', 'Mesas finais')}</th>
                </tr>
              </thead>
              <tbody>
                {linhas.map((l) => (
                  <tr key={l.player_id} data-jogador={l.player_id}>
                    <td className="rk-num">{l.position}{l.tied ? '=' : ''}</td>
                    <td>{l.player_name}</td>
                    {torneios.map((tr) => {
                      const valor = l.by_tournament?.[tr.id];
                      const descartado = (l.discarded || []).includes(tr.id);
                      return (
                        <td
                          key={tr.id}
                          className={`rk-num ${descartado ? 'rk-descartado' : ''}`}
                          title={descartado ? t('pointsRanking.discarded', 'Fora dos melhores resultados') : undefined}
                        >
                          {valor ?? ''}
                        </td>
                      );
                    })}
                    <td className="rk-num"><strong>{l.total}</strong></td>
                    <td className="rk-num">{temporada ? `${l.counted}/${l.events}` : l.events}</td>
                    <td className="rk-num">{l.firsts}</td>
                    <td className="rk-num">{l.final_tables}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </>
  );
};

// ── Etapa ────────────────────────────────────────────────────────────────────

const AbaEtapa = ({ etapas }) => {
  const { t } = useTranslation();
  const { toast } = useToast();
  const { selectedStage } = useStage() || {};
  const [etapaId, setEtapaId] = useState(selectedStage?.id || '');
  const [dados, setDados] = useState(null);
  const [carregando, setCarregando] = useState(false);

  useEffect(() => {
    if (!etapaId && etapas.length > 0) setEtapaId(selectedStage?.id || etapas[0].id);
  }, [etapas, etapaId, selectedStage]);

  useEffect(() => {
    if (!etapaId) return;
    let vivo = true;
    setCarregando(true);
    api.get(`/points-ranking/stages/${etapaId}`)
      .then((res) => { if (vivo) setDados(res.data); })
      .catch((err) => { if (vivo) toast.error(err?.userMessage || t('pointsRanking.loadError', 'Não foi possível carregar o ranking.')); })
      .finally(() => { if (vivo) setCarregando(false); });
    return () => { vivo = false; };
  }, [etapaId, toast, t]);

  const etapa = etapas.find((e) => e.id === etapaId);
  return (
    <Card>
      <div className="rk-filtros">
        <label htmlFor="rk-etapa">{t('pointsRanking.stage', 'Etapa')}</label>
        <select id="rk-etapa" value={etapaId} onChange={(e) => setEtapaId(e.target.value)}>
          {etapas.map((e) => <option key={e.id} value={e.id}>{e.name}</option>)}
        </select>
      </div>
      {carregando && !dados ? <p className="rk-muted">{t('common.loading', 'Carregando...')}</p> : (
        <Classificacao
          dados={dados}
          titulo={`${t('pointsRanking.title', 'Ranking de pontos')} — ${etapa?.name || ''}`}
          nomeDoArquivo={`ranking_${(etapa?.name || 'etapa').replace(/\s+/g, '_')}`}
        />
      )}
    </Card>
  );
};

// ── Temporadas ───────────────────────────────────────────────────────────────

const FORM_VAZIO = { id: null, name: '', best_results: '8', stage_ids: [] };

const AbaTemporadas = ({ etapas }) => {
  const { t } = useTranslation();
  const { toast } = useToast();
  const [temporadas, setTemporadas] = useState([]);
  const [selecionada, setSelecionada] = useState('');
  const [dados, setDados] = useState(null);
  const [form, setForm] = useState(null);
  const [excluindo, setExcluindo] = useState(false);

  const carregar = useCallback(async () => {
    try {
      const res = await api.get('/points-ranking/seasons');
      setTemporadas(res.data || []);
      setSelecionada((atual) => atual || res.data?.[0]?.id || '');
    } catch (err) {
      toast.error(err?.userMessage || t('pointsRanking.loadError', 'Não foi possível carregar o ranking.'));
    }
  }, [toast, t]);

  useEffect(() => { carregar(); }, [carregar]);

  useEffect(() => {
    if (!selecionada) { setDados(null); return undefined; }
    let vivo = true;
    api.get(`/points-ranking/seasons/${selecionada}/standings`)
      .then((res) => { if (vivo) setDados(res.data); })
      .catch((err) => { if (vivo) toast.error(err?.userMessage || t('pointsRanking.loadError', 'Não foi possível carregar o ranking.')); });
    return () => { vivo = false; };
  }, [selecionada, temporadas, toast, t]);

  const salvar = async () => {
    const corpo = {
      name: form.name,
      best_results: form.best_results === '' ? null : Number(form.best_results),
      stage_ids: form.stage_ids,
    };
    try {
      const res = form.id
        ? await api.put(`/points-ranking/seasons/${form.id}`, corpo)
        : await api.post('/points-ranking/seasons', corpo);
      toast.success(t('pointsRanking.seasonSaved', 'Temporada salva.'));
      setForm(null);
      setSelecionada(res.data?.id || selecionada);
      carregar();
    } catch (err) {
      toast.error(err?.userMessage || t('pointsRanking.saveError', 'Não foi possível salvar.'));
    }
  };

  const excluir = async () => {
    try {
      await api.delete(`/points-ranking/seasons/${selecionada}`);
      toast.success(t('pointsRanking.seasonDeleted', 'Temporada excluída.'));
      setExcluindo(false);
      setSelecionada('');
      carregar();
    } catch (err) {
      toast.error(err?.userMessage || t('pointsRanking.saveError', 'Não foi possível salvar.'));
    }
  };

  const atual = temporadas.find((s) => s.id === selecionada);
  const alternarEtapa = (id) => setForm((f) => ({
    ...f,
    stage_ids: f.stage_ids.includes(id) ? f.stage_ids.filter((s) => s !== id) : [...f.stage_ids, id],
  }));

  return (
    <Card>
      <div className="rk-filtros">
        {temporadas.length > 0 && (
          <>
            <label htmlFor="rk-temporada">{t('pointsRanking.season', 'Temporada')}</label>
            <select id="rk-temporada" value={selecionada} onChange={(e) => setSelecionada(e.target.value)}>
              {temporadas.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
            </select>
            {atual && (
              <Button size="small" variant="secondary" onClick={() => setForm({
                id: atual.id, name: atual.name,
                best_results: atual.best_results == null ? '' : String(atual.best_results),
                stage_ids: atual.stage_ids || [],
              })}
              >
                {t('common.edit', 'Editar')}
              </Button>
            )}
          </>
        )}
        <Button size="small" onClick={() => setForm({ ...FORM_VAZIO })}>
          {t('pointsRanking.newSeason', 'Nova temporada')}
        </Button>
      </div>

      {form && (
        <div className="rk-card rk-form form-group">
          <label htmlFor="rk-nome">{t('pointsRanking.seasonName', 'Nome')}</label>
          <input id="rk-nome" value={form.name} maxLength={120} onChange={(e) => setForm({ ...form, name: e.target.value })} />
          <label htmlFor="rk-melhores">{t('pointsRanking.bestResults', 'Melhores resultados que somam (vazio = todos)')}</label>
          <input
            id="rk-melhores"
            type="number"
            min="1"
            max="100"
            value={form.best_results}
            onChange={(e) => setForm({ ...form, best_results: e.target.value })}
          />
          <span className="rk-rotulo">{t('pointsRanking.seasonStages', 'Etapas da temporada')}</span>
          <div className="rk-etapas">
            {etapas.map((e) => (
              <label key={e.id} className="rk-check">
                <input type="checkbox" checked={form.stage_ids.includes(e.id)} onChange={() => alternarEtapa(e.id)} />
                <span>{e.name}</span>
              </label>
            ))}
          </div>
          <div className="rk-acoes">
            {form.id && !excluindo && (
              <Button variant="secondary" onClick={() => setExcluindo(true)}>{t('common.delete', 'Excluir')}</Button>
            )}
            {form.id && excluindo && (
              <Button variant="danger-solid" onClick={excluir}>{t('pointsRanking.confirmDelete', 'Confirmar exclusão')}</Button>
            )}
            <Button variant="secondary" onClick={() => { setForm(null); setExcluindo(false); }}>{t('common.cancel', 'Cancelar')}</Button>
            <Button onClick={salvar} disabled={!form.name.trim()}>{t('common.save', 'Salvar')}</Button>
          </div>
        </div>
      )}

      {temporadas.length === 0 && !form ? (
        <EmptyState
          icon={null}
          title={t('pointsRanking.noSeasons', 'Nenhuma temporada criada')}
          subtitle={t('pointsRanking.noSeasonsHint', 'Uma temporada junta etapas e soma os melhores resultados de cada jogador.')}
        />
      ) : (
        atual && (
          <Classificacao
            dados={dados}
            titulo={`${t('pointsRanking.title', 'Ranking de pontos')} — ${atual.name}`}
            nomeDoArquivo={`ranking_${atual.name.replace(/\s+/g, '_')}`}
          />
        )
      )}
    </Card>
  );
};

// ── Regras ───────────────────────────────────────────────────────────────────

const AbaRegras = () => {
  const { t } = useTranslation();
  const { toast } = useToast();
  const { currency } = useCurrency();
  const [regras, setRegras] = useState(null);
  const [form, setForm] = useState({});

  useEffect(() => {
    api.get('/points-ranking/rules')
      .then((res) => {
        setRegras(res.data);
        setForm(Object.fromEntries(CAMPOS_DAS_REGRAS.map(([c]) => [c, String(res.data[c])])));
      })
      .catch((err) => toast.error(err?.userMessage || t('pointsRanking.loadError', 'Não foi possível carregar o ranking.')));
  }, [toast, t]);

  const salvar = async () => {
    try {
      const corpo = Object.fromEntries(CAMPOS_DAS_REGRAS.map(([c]) => [c, Number(form[c])]));
      const res = await api.put('/points-ranking/rules', corpo);
      setRegras(res.data);
      toast.success(t('pointsRanking.rulesSaved', 'Regras salvas. Valem para os próximos torneios oficializados.'));
    } catch (err) {
      toast.error(err?.userMessage || t('pointsRanking.saveError', 'Não foi possível salvar.'));
    }
  };

  if (!regras) return <Card><p className="rk-muted">{t('common.loading', 'Carregando...')}</p></Card>;
  return (
    <Card>
      <p className="rk-formula">
        {t('pointsRanking.formula', 'Pontos = ({{base}} ÷ √posição) × FJ × FB — só as posições premiadas pontuam.', {
          base: regras.pontos_base,
        })}
        <br />
        <span className="rk-muted">
          {t('pointsRanking.formulaFactors', 'FJ = (jogadores únicos ÷ {{nRef}})^{{nExp}}, entre {{nMin}} e {{nMax}} · FB = (buy-in ÷ {{bRef}})^{{bExp}}, entre {{bMin}} e {{bMax}}', {
            nRef: regras.jogadores_referencia, nExp: regras.jogadores_expoente,
            nMin: regras.jogadores_fator_minimo, nMax: regras.jogadores_fator_maximo,
            bRef: regras.buy_in_referencia, bExp: regras.buy_in_expoente,
            bMin: regras.buy_in_fator_minimo, bMax: regras.buy_in_fator_maximo,
          })}
        </span>
      </p>
      {!regras.personalizadas && (
        <p className="rk-muted">{t('pointsRanking.rulesDefault', 'Valores sugeridos. Ajuste e anuncie antes da temporada.')}</p>
      )}
      {referenciaEmOutraMoeda(regras.personalizadas, currency) && (
        <p className="rk-card rk-aviso" role="status">
          {t('pointsRanking.currencyRulesWarning', 'O buy-in de referência padrão ({{ref}}) está em soles e o clube usa {{moeda}}. Troque pelo buy-in típico do clube e salve: é ele que vale fator 1.', {
            ref: regras.buy_in_referencia, moeda: currency,
          })}
        </p>
      )}
      <div className="rk-regras">
        {CAMPOS_DAS_REGRAS.map(([campo, padrao]) => (
          <div className="form-group" key={campo}>
            <label htmlFor={`rk-${campo}`}>{t(`pointsRanking.rule.${campo}`, padrao)}</label>
            <input
              id={`rk-${campo}`}
              type="number"
              step="any"
              min="0"
              value={form[campo] ?? ''}
              onChange={(e) => setForm({ ...form, [campo]: e.target.value })}
            />
          </div>
        ))}
      </div>
      <p className="rk-muted">{t('pointsRanking.rulesFrozen', 'Torneios já oficializados mantêm os pontos que receberam.')}</p>
      <div className="rk-acoes">
        <Button onClick={salvar}>{t('common.save', 'Salvar')}</Button>
      </div>
    </Card>
  );
};

// ── Página ───────────────────────────────────────────────────────────────────

const RankingPontos = () => {
  const { t } = useTranslation();
  const [aba, setAba] = useState('etapa');
  const [etapas, setEtapas] = useState([]);
  const [pendente, setPendente] = useState(false);

  useEffect(() => {
    api.get('/stages').then((res) => setEtapas(res.data || [])).catch(() => setEtapas([]));
    // Migração pendente: a tela inteira diz isso uma vez, em vez de três erros.
    api.get('/points-ranking/rules', { _silentError: true })
      .catch((err) => { if (codigoDoErro(err) === 'ranking_migracao_pendente') setPendente(true); });
  }, []);

  const abas = useMemo(() => [
    ['etapa', t('pointsRanking.tabStage', 'Etapa')],
    ['temporadas', t('pointsRanking.tabSeasons', 'Temporadas')],
    ['regras', t('pointsRanking.tabRules', 'Regras')],
  ], [t]);

  return (
    <div className="app-container">
      <Sidebar />
      <main className="main-content">
        <div className="cx-header">
          <div className="cx-header-left">
            <div className="cx-header-icon"><Icon name="award" /></div>
            <div>
              <h1 className="cx-title">{t('pointsRanking.title', 'Ranking de pontos')}</h1>
              <p className="cx-subtitle">{t('pointsRanking.subtitle', 'Posição final, jogadores únicos e buy-in: recompra, add-on e prêmio não dão ponto.')}</p>
            </div>
          </div>
        </div>

        {pendente ? (
          <div className="rk-card rk-aviso">
            {t('pointsRanking.migrationPending', 'O ranking de pontos ainda não está ativo neste servidor. Peça ao suporte para concluir a ativação.')}
          </div>
        ) : (
          <>
            <div className="rk-abas" role="tablist">
              {abas.map(([id, rotulo]) => (
                <button
                  key={id}
                  type="button"
                  role="tab"
                  aria-selected={aba === id}
                  className={`rk-aba ${aba === id ? 'rk-aba--ativa' : ''}`}
                  onClick={() => setAba(id)}
                >
                  {rotulo}
                </button>
              ))}
            </div>
            {aba === 'etapa' && <AbaEtapa etapas={etapas} />}
            {aba === 'temporadas' && <AbaTemporadas etapas={etapas} />}
            {aba === 'regras' && <AbaRegras />}
          </>
        )}
      </main>
    </div>
  );
};

export default RankingPontos;
