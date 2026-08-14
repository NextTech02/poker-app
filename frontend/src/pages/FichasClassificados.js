import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import Sidebar from '../components/Sidebar';
import Card from '../components/Card';
import Button from '../components/Button';
import Breadcrumb from '../components/Breadcrumb';
import EmptyState from '../components/EmptyState';
import { SkeletonBlock } from '../components/SkeletonLoader';
import api from '../config/api';
import { useToast } from '../contexts/ToastContext';
import './FichasClassificados.css';

// A partir de quantos classificados a busca por nome passa a valer a pena.
// Abaixo disso o campo só ocupa espaço; acima, achar um jogador na lista vira
// um problema real na mesa.
const LIMITE_PARA_BUSCA = 20;

/**
 * Valida o que o operador digitou como stack.
 *
 * Só inteiro positivo passa: fichas são unidades, e o número vai virar o stack
 * inicial do jogador no dia final. "0", negativo, "12,5" e texto são recusados.
 * Devolve null quando está válido.
 */
export const validarFichas = (valor) => {
  const texto = String(valor ?? '').trim();
  if (texto === '') return 'vazio';
  if (!/^\d+$/.test(texto)) return 'invalido';
  if (Number(texto) <= 0) return 'invalido';
  return null;
};

const nomeDo = (s) => s?.players?.name || s?.player_name || '';

/**
 * Uma linha por classificado. Isolada em memo porque num Dia 1 grande a lista
 * passa de 100 linhas: sem isso, cada tecla digitada num campo re-renderiza
 * todos os outros e a digitação engasga na mesa.
 */
export const LinhaSobrevivente = React.memo(({ sobrevivente, valor, erro, rotulos, onChange }) => {
  const playerId = sobrevivente.player_id;
  const nome = nomeDo(sobrevivente);
  const apelido = sobrevivente.players?.nickname;
  const idDoCampo = `fichas-${playerId}`;

  return (
    <div className={`fc-linha ${erro ? 'fc-linha-erro' : ''}`} data-testid={`linha-${playerId}`}>
      <div className="fc-jogador">
        <span className="fc-nome">{nome}</span>
        {apelido && <span className="fc-apelido">"{apelido}"</span>}
      </div>

      <div className="fc-entradas">
        <span title={rotulos.buyIns}>{rotulos.buyInsCurto}: {sobrevivente.buy_in_count || 0}</span>
        <span title={rotulos.rebuys}>{rotulos.rebuysCurto}: {sobrevivente.rebuy_count || 0}</span>
        <span title={rotulos.addons}>{rotulos.addonsCurto}: {sobrevivente.addon_count || 0}</span>
      </div>

      <div className="fc-teoricas">
        <span className="fc-rotulo">{rotulos.teoricas}</span>
        <span className="fc-valor">{Number(sobrevivente.total_chips || 0).toLocaleString()}</span>
      </div>

      <div className="fc-campo">
        <label className="fc-rotulo" htmlFor={idDoCampo}>{rotulos.reais}</label>
        <input
          id={idDoCampo}
          type="number"
          min="1"
          step="1"
          inputMode="numeric"
          className={erro ? 'fc-input fc-input-erro' : 'fc-input'}
          value={valor}
          aria-invalid={erro ? 'true' : 'false'}
          aria-describedby={erro ? `${idDoCampo}-erro` : undefined}
          onChange={(e) => onChange(playerId, e.target.value)}
        />
        {erro && (
          <span className="fc-erro-inline" id={`${idDoCampo}-erro`} role="alert">
            {erro === 'vazio' ? rotulos.erroObrigatorio : rotulos.erroPositivo}
          </span>
        )}
      </div>
    </div>
  );
});

const FichasClassificados = () => {
  const { t } = useTranslation();
  const { dayId } = useParams();
  const navigate = useNavigate();
  const { toast } = useToast();

  const [dia, setDia] = useState(null);
  const [sobreviventes, setSobreviventes] = useState([]);
  const [chips, setChips] = useState({});      // { [player_id]: string }
  const [originais, setOriginais] = useState({});
  const [busca, setBusca] = useState('');
  const [carregando, setCarregando] = useState(true);
  const [salvando, setSalvando] = useState(false);
  const [erro, setErro] = useState(null);

  const carregar = useCallback(async () => {
    try {
      setCarregando(true);
      const [diaRes, sobrevRes] = await Promise.all([
        api.get(`/tournament-days/${dayId}`),
        api.get(`/tournament-days/${dayId}/survivors`),
      ]);
      const lista = (sobrevRes.data || []).slice().sort(
        (a, b) => nomeDo(a).localeCompare(nomeDo(b))
      );
      // Reabrir a tela mostra o que já foi digitado antes: a contagem de fichas
      // acontece mesa a mesa, quase nunca de uma vez só.
      const iniciais = {};
      lista.forEach((s) => {
        iniciais[s.player_id] = s.final_chip_count == null ? '' : String(s.final_chip_count);
      });
      setDia(diaRes.data);
      setSobreviventes(lista);
      setChips(iniciais);
      setOriginais(iniciais);
      setErro(null);
    } catch (e) {
      console.error('Erro ao carregar fichas dos classificados:', e);
      setErro(t('tournamentDays.chipsLoadError', 'Não foi possível carregar os classificados deste dia.'));
    } finally {
      setCarregando(false);
    }
  }, [dayId, t]);

  useEffect(() => { carregar(); }, [carregar]);

  const aoDigitar = useCallback((playerId, valor) => {
    setChips((atual) => ({ ...atual, [playerId]: valor }));
  }, []);

  // Campo vazio só é erro quando havia um valor gravado e o operador o apagou —
  // apagar é uma intenção de mudança que não dá para salvar. Quem ainda não
  // chegou naquela mesa fica vazio, sem sinal vermelho.
  const errosPorJogador = useMemo(() => {
    const mapa = {};
    sobreviventes.forEach((s) => {
      const problema = validarFichas(chips[s.player_id]);
      if (!problema) return;
      if (problema === 'vazio') {
        if (originais[s.player_id]) mapa[s.player_id] = 'vazio';
        return;
      }
      mapa[s.player_id] = 'invalido';
    });
    return mapa;
  }, [sobreviventes, chips, originais]);

  const alterados = useMemo(
    () => sobreviventes
      .map((s) => s.player_id)
      .filter((pid) => (chips[pid] ?? '') !== (originais[pid] ?? '')),
    [sobreviventes, chips, originais]
  );

  const resumo = useMemo(() => {
    let preenchidos = 0;
    let total = 0;
    sobreviventes.forEach((s) => {
      const valor = chips[s.player_id];
      if (validarFichas(valor)) return;
      preenchidos += 1;
      total += Number(valor);
    });
    return {
      total: sobreviventes.length,
      preenchidos,
      chipcount: total,
      media: preenchidos ? Math.round(total / preenchidos) : 0,
    };
  }, [sobreviventes, chips]);

  const temErro = Object.keys(errosPorJogador).length > 0;
  const podeSalvar = !salvando && alterados.length > 0 && !temErro;

  const salvar = async () => {
    if (!podeSalvar) return;
    const updates = alterados.map((pid) => ({
      player_id: pid,
      chip_count: Number(chips[pid]),
    }));
    try {
      setSalvando(true);
      const res = await api.post(`/tournament-days/${dayId}/bulk-update-chips`, { updates });
      const gravados = res?.data?.updated_count ?? updates.length;
      if (gravados < updates.length) {
        // Menos linhas gravadas do que enviadas = algum jogador não está mais
        // neste dia. Silenciar isso faria o operador achar que salvou tudo.
        toast.warning(t('tournamentDays.chipsPartiallySaved',
          '{{gravados}} de {{enviados}} classificados tiveram as fichas salvas.',
          { gravados, enviados: updates.length }));
      } else {
        toast.success(t('tournamentDays.chipsSaved', 'Fichas registradas ({{count}}).', { count: gravados }));
      }
      await carregar();
    } catch (e) {
      console.error('Erro ao salvar fichas:', e);
      // Não recarrega: o que o operador digitou continua na tela para ele
      // tentar de novo sem recontar as mesas.
      toast.error(e.response?.data?.detail || e.userMessage || t('common.error'));
    } finally {
      setSalvando(false);
    }
  };

  const voltar = () => {
    if (dia?.tournament_id) navigate(`/torneios/${dia.tournament_id}`);
    else navigate(-1);
  };

  const rotulos = useMemo(() => ({
    buyIns: t('dayStats.buyIns', 'Buy-ins'),
    buyInsCurto: t('tournamentDays.buyInShort', 'BI'),
    rebuys: t('dayStats.rebuys', 'Rebuys'),
    rebuysCurto: t('tournamentDays.rebuyShort', 'RE'),
    addons: t('dayStats.addons', 'Add-ons'),
    addonsCurto: t('tournamentDays.addonShort', 'AD'),
    teoricas: t('tournamentDays.theoreticalChips', 'Fichas concedidas'),
    reais: t('tournamentDays.realChips', 'Fichas reais'),
    erroObrigatorio: t('tournamentDays.chipsRequired', 'Informe as fichas.'),
    erroPositivo: t('tournamentDays.chipsMustBePositive', 'Use um número inteiro maior que zero.'),
  }), [t]);

  const visiveis = useMemo(() => {
    const termo = busca.trim().toLowerCase();
    if (!termo) return sobreviventes;
    return sobreviventes.filter((s) => {
      const apelido = s.players?.nickname || '';
      return nomeDo(s).toLowerCase().includes(termo) || apelido.toLowerCase().includes(termo);
    });
  }, [sobreviventes, busca]);

  const moldura = (conteudo) => (
    <div className="app-container">
      <Sidebar />
      <main className="main-content">
        <Breadcrumb items={[
          { label: t('common.home'), to: '/' },
          { label: t('tournaments.title'), to: '/torneios' },
          { label: t('tournamentDays.chipCountTitle', 'Fichas dos Classificados') },
        ]} />
        {conteudo}
      </main>
    </div>
  );

  if (carregando) {
    return moldura(
      <div className="fc-skeleton">
        {[0, 1, 2, 3, 4].map((i) => (
          <SkeletonBlock key={i} height="52px" />
        ))}
      </div>
    );
  }

  if (erro) {
    return moldura(
      <Card>
        <div className="error-message">{erro}</div>
        <Button onClick={voltar}>{t('common.back')}</Button>
      </Card>
    );
  }

  const naoEClassificatorio = dia && dia.day_type !== 'qualifying';

  return moldura(
    <>
      <div className="page-header">
        <div>
          <h1>{t('tournamentDays.chipCountTitle', 'Fichas dos Classificados')}</h1>
          <p className="subtitle">
            {dia?.day_name} — {t('tournamentDays.chipCountSubtitle',
              'Informe o stack contado de cada classificado antes de avançar para o dia final.')}
          </p>
        </div>
        <Button variant="secondary" onClick={voltar}>{t('common.back')}</Button>
      </div>

      {naoEClassificatorio && (
        <Card className="fc-aviso">
          <p role="alert">
            {t('tournamentDays.notAQualifyingDay',
              'Este dia não é classificatório: não há classificados para registrar fichas.')}
          </p>
        </Card>
      )}

      {!naoEClassificatorio && !dia?.qualifies_to_day_id && (
        <Card className="fc-aviso">
          <p role="alert">
            {t('tournamentDays.noFinalDayLinked',
              'Este dia classificatório ainda não aponta para um dia final. Vincule o dia final antes de avançar os classificados.')}
          </p>
        </Card>
      )}

      {!naoEClassificatorio && sobreviventes.length === 0 && (
        <EmptyState
          icon="🃏"
          title={t('tournamentDays.noSurvivors', 'Nenhum classificado neste dia')}
          subtitle={t('tournamentDays.noSurvivorsHint',
            'Enquanto todos os jogadores estiverem eliminados (ou nenhum tiver sido inscrito), não há fichas a registrar.')}
        />
      )}

      {!naoEClassificatorio && sobreviventes.length > 0 && (
        <Card className="fc-lista-card">
          {sobreviventes.length > LIMITE_PARA_BUSCA && (
            <input
              type="search"
              className="fc-busca"
              value={busca}
              placeholder={t('tournamentDays.searchPlayer', 'Buscar jogador...')}
              aria-label={t('tournamentDays.searchPlayer', 'Buscar jogador...')}
              onChange={(e) => setBusca(e.target.value)}
            />
          )}

          <div className="fc-lista">
            {visiveis.map((s) => (
              <LinhaSobrevivente
                key={s.player_id}
                sobrevivente={s}
                valor={chips[s.player_id] ?? ''}
                erro={errosPorJogador[s.player_id]}
                rotulos={rotulos}
                onChange={aoDigitar}
              />
            ))}
            {visiveis.length === 0 && (
              <p className="fc-sem-resultado">{t('common.noData')}</p>
            )}
          </div>

          <div className="fc-rodape">
            <div className="fc-resumo">
              <span>
                {t('tournamentDays.survivors', 'Classificados')}: <strong>{resumo.total}</strong>
              </span>
              <span>
                {t('tournamentDays.chipsFilled', 'Com fichas')}:{' '}
                <strong>{resumo.preenchidos}/{resumo.total}</strong>
              </span>
              <span>
                {t('tournamentDays.totalChipcount', 'Chipcount total')}:{' '}
                <strong>{resumo.chipcount.toLocaleString()}</strong>
              </span>
              <span>
                {t('tournamentDays.averageStack', 'Stack médio')}:{' '}
                <strong>{resumo.media.toLocaleString()}</strong>
              </span>
            </div>

            {resumo.preenchidos < resumo.total && (
              <p className="fc-alerta">
                {t('tournamentDays.allSurvivorsNeedChips',
                  'O avanço para o dia final só é liberado quando todos os classificados tiverem fichas registradas.')}
              </p>
            )}

            <Button onClick={salvar} disabled={!podeSalvar}>
              {salvando ? t('common.saving', 'Salvando...') : t('common.save')}
            </Button>
          </div>
        </Card>
      )}
    </>
  );
};

export default FichasClassificados;
