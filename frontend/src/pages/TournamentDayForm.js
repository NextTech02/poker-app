import React, { useEffect, useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import Sidebar from '../components/Sidebar';
import Card from '../components/Card';
import Button from '../components/Button';
import api from '../config/api';
import { useToast } from '../contexts/ToastContext';
import { useCurrency } from '../contexts/CurrencyContext';
import { currencySymbol } from '../utils/currencyUtils';
import { colunasDoDia, linhasDaApi } from '../utils/entryTypes';
import './TournamentDayForm.css';

const TournamentDayForm = () => {
  const { t } = useTranslation();
  const { tournamentId, dayId } = useParams(); // dayId comes from URL param when editing
  const navigate = useNavigate();
  const { currency } = useCurrency();

  const [tournament, setTournament] = useState(null);
  const [days, setDays] = useState([]);
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState(null);

  const { toast } = useToast();

  const [formData, setFormData] = useState({
    day_name: '',
    day_number: 1,
    buy_in: 100,
    rebuy_amount: 100,
    addon_amount: 100,
    max_players: 100,
    // O rake do DIA é só reserva: quem manda é o meio de entrada escolhido na
    // venda. Fica 0 aqui porque, sem meio escolhido, não há rake a cobrar.
    rake_percentage: 0,
    starting_chips: 10000,
    rebuy_chips: 10000,
    addon_chips: 10000,
    rebuy_level_limit: '',
    allocation_type: 'automatic',
    day_type: 'regular',
    qualifies_to_day_id: '',
    currency: 'BRL',
  });

  // Meios de entrada do TORNEIO (nome, valor, rake e fichas por linha). A lista
  // é uma só, vale para todos os dias e se edita no torneio — aqui ela só é
  // mostrada, e é dela que saem as colunas antigas do dia (buy_in, fichas...).
  const [meiosDoTorneio, setMeiosDoTorneio] = useState([]);

  const isEditing = !!dayId;

  // O tipo do dia só existe em torneio classificatório. Em torneio de dia único
  // o select teria uma opção só ("Regular"), então o campo não decide nada.
  // A flag do torneio é a fonte principal, mas dias antigos podem ter sido
  // marcados como classificatório/final sem ela — nesses casos o bloco continua
  // visível, senão não haveria como corrigir o vínculo.
  const eClassificatorio =
    !!tournament?.has_qualifying ||
    days.some((d) => d.day_type === 'qualifying' || d.day_type === 'final') ||
    formData.day_type !== 'regular';

  // loadData e recriada a cada render; incluir na lista de dependencias causaria
  // refetch infinito. So os ids da rota devem disparar o recarregamento.
  useEffect(() => {
    loadData();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tournamentId, dayId]);

  const loadData = async () => {
    try {
      setLoading(true);

      // Nenhuma das quatro depende das outras — em série, o formulário
      // esperava a soma de todas; em paralelo, espera só a mais lenta.
      const [tournamentRes, daysRes, dayRes, meiosRes] = await Promise.all([
        api.get(`/tournaments/${tournamentId}`),
        api.get(`/tournament-days/tournament/${tournamentId}`),
        dayId ? api.get(`/tournament-days/${dayId}`) : Promise.resolve(null),
        // Os meios de entrada são do TORNEIO: existem antes do dia, e é deles
        // que as colunas antigas do dia são preenchidas ao salvar.
        api.get(`/tournaments/${tournamentId}/buy-types`).catch((e) => {
          // Falha aqui não pode derrubar o formulário inteiro: o dia continua
          // editável e as colunas ficam com o que o dia já tinha.
          console.error('Erro ao carregar meios de entrada:', e);
          return null;
        }),
      ]);

      setTournament(tournamentRes.data);
      setDays(daysRes.data);
      setMeiosDoTorneio(linhasDaApi(meiosRes?.data).ativos);

      // If editing, load the day data
      if (dayRes) {
        const day = dayRes.data;
        setFormData({
          day_name: day.day_name,
          day_number: day.day_number,
          buy_in: day.buy_in,
          rebuy_amount: day.rebuy_amount || 0,
          addon_amount: day.addon_amount || 0,
          max_players: day.max_players,
          rake_percentage: day.rake_percentage,
          starting_chips: day.starting_chips,
          rebuy_chips: day.rebuy_chips,
          addon_chips: day.addon_chips,
          rebuy_level_limit: day.rebuy_level_limit || '',
          allocation_type: day.allocation_type,
          day_type: day.day_type || 'regular',
          qualifies_to_day_id: day.qualifies_to_day_id || '',
          currency: day.currency || 'BRL',
        });
      } else {
        // Novos dias adicionados manualmente são sempre 'regular' — os dias
        // classificatórios e o final são gerados automaticamente na criação do
        // torneio classificatório.
        setFormData(prev => ({
          ...prev,
          day_number: daysRes.data.length + 1,
          day_type: 'regular',
          // A moeda segue o setting GLOBAL (Financeiro) — não há mais seleção por dia.
          currency,
        }));
      }
    } catch (err) {
      console.error('Error loading data:', err);
      setError(t('common.error'));
    } finally {
      setLoading(false);
    }
  };

  const rotuloDaCategoria = (categoria) => ({
    buy_in: t('tournamentDayForm.categoryBuyIn', 'Entrada'),
    rebuy: t('tournamentDayForm.categoryRebuy', 'Recompra'),
    addon: t('tournamentDayForm.categoryAddon', 'Add-on'),
  }[categoria] || categoria);

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError(null);
    setSubmitting(true);

    try {
      // As colunas antigas do dia (buy_in, fichas...) continuam existindo e são
      // lidas por telas e relatórios que ainda não conhecem os meios de entrada.
      // Preenchemos com o PRIMEIRO meio de cada categoria do TORNEIO para elas
      // não ficarem contando uma história diferente da que o Caixa cobra.
      // Torneio ainda sem meios: o dia mantém o que já tinha — com zero de
      // rebuy/add-on virando NULO ("rebuy de R$ 0,00" diria que o rebuy é de
      // graça; nulo diz que ele não existe, e é o que o CHECK `> 0` aceita).
      const colunas = meiosDoTorneio.length
        ? colunasDoDia(meiosDoTorneio)
        : {
            buy_in: Number(formData.buy_in) || 0,
            starting_chips: Number(formData.starting_chips) || 0,
            rebuy_amount: Number(formData.rebuy_amount) > 0 ? Number(formData.rebuy_amount) : null,
            rebuy_chips: Number(formData.rebuy_chips) || 0,
            addon_amount: Number(formData.addon_amount) > 0 ? Number(formData.addon_amount) : null,
            addon_chips: Number(formData.addon_chips) || 0,
          };

      let dayData = {
        ...formData,
        tournament_id: tournamentId,
        ...colunas,
        rebuy_level_limit: formData.rebuy_level_limit ? parseInt(formData.rebuy_level_limit) : null,
        qualifies_to_day_id: formData.qualifies_to_day_id || null,
      };

      // For final days, set financial and entry values to defaults (they come from qualifying days)
      if (formData.day_type === 'final') {
        dayData = {
          ...dayData,
          buy_in: 0,
          rebuy_amount: null,
          addon_amount: null,
          rake_percentage: 0,
          max_players: 1000, // High limit since qualified players come automatically
          starting_chips: 0, // Players bring their chips from qualifying days
          rebuy_chips: 0,
          addon_chips: 0,
          rebuy_level_limit: null,
        };
      }

      if (isEditing) {
        await api.patch(`/tournament-days/${dayId}`, dayData);
      } else {
        const createRes = await api.post('/tournament-days', dayData);
        const newDayId = createRes?.data?.id;
        // Herança automática: um novo dia (exceto o Final) já nasce com a mesma
        // estrutura de blinds dos dias classificatórios — copiamos os blinds de
        // um dia classificatório existente que já tenha estrutura configurada.
        if (newDayId && formData.day_type !== 'final') {
          await inheritBlindsFromQualifying(newDayId);
        }
      }

      // Navigate back to tournament detail
      navigate(`/torneios/${tournamentId}`);
    } catch (err) {
      console.error('Error saving day:', err);
      const detail = err.response?.data?.detail;
      let errorMessage = t('common.error');
      if (typeof detail === 'string') {
        errorMessage = detail;
      } else if (Array.isArray(detail)) {
        errorMessage = detail.map(e => `${e.loc?.join('.') || ''}: ${e.msg || ''}`).join(', ');
      }
      setError(errorMessage);
    } finally {
      setSubmitting(false);
    }
  };

  // Copia a estrutura de blinds de um dia classificatório existente para o novo
  // dia recém-criado. Best-effort: se nenhum classificatório tiver blinds ainda,
  // simplesmente não copia nada (o dia fica vazio, como antes).
  const inheritBlindsFromQualifying = async (newDayId) => {
    try {
      const sourceDays = days.filter(d => d.day_type === 'qualifying' && d.id !== newDayId);
      let sourceBlinds = [];
      for (const d of sourceDays) {
        const res = await api.get(`/tournament-days/${d.id}/blinds`);
        if (res?.data?.length) {
          sourceBlinds = res.data;
          break;
        }
      }
      if (!sourceBlinds.length) return;

      const ordered = [...sourceBlinds].sort((a, b) => a.level - b.level);
      for (const b of ordered) {
        await api.post(`/tournament-days/${newDayId}/blinds`, {
          level: b.level,
          small_blind: b.small_blind,
          big_blind: b.big_blind,
          ante: b.ante,
          duration: b.duration,
          is_break: b.is_break,
        });
      }
      toast.success(t('tournamentDayForm.blindsInherited', 'Estrutura de blinds herdada dos dias classificatórios.'));
    } catch (err) {
      console.error('Erro ao herdar blinds:', err);
      toast.warning(t('tournamentDayForm.blindsInheritError', 'Dia criado, mas não foi possível herdar a estrutura de blinds. Configure na tela de Blinds.'));
    }
  };

  const handleCancel = () => {
    navigate(`/torneios/${tournamentId}`);
  };

  if (loading) {
    return (
      <div className="app-container">
        <Sidebar />
        <main className="main-content tournament-day-form-page">
          <div className="loading">{t('common.loading')}</div>
        </main>
      </div>
    );
  }

  return (
    <div className="app-container">
      <Sidebar />
      <main className="main-content tournament-day-form-page">
        <div className="page-header">
          <div>
            <h1>{isEditing ? t('tournamentDayForm.editDay') : t('tournamentDayForm.newDay')} - {tournament?.name}</h1>
          </div>
          <Button variant="secondary" onClick={handleCancel}>
            {t('common.back')}
          </Button>
        </div>

        {error && (
          <div className="error-message">
            {error}
          </div>
        )}

        <Card className="form-card">
          <form onSubmit={handleSubmit}>
            {/* Basic Info */}
            <div className="form-section">
              <h3 className="form-section-title">{t('tournamentDayForm.basicInfo')}</h3>
              <div className="form-row">
                <div className="form-group">
                  <label htmlFor="day_name">{t('tournamentDays.dayName')} *</label>
                  <input
                    id="day_name"
                    type="text"
                    value={formData.day_name}
                    onChange={(e) => setFormData({ ...formData, day_name: e.target.value })}
                    placeholder={t('tournamentDayForm.dayNamePlaceholder')}
                    required
                  />
                </div>
              </div>
              {eClassificatorio && (
                <div className="form-row">
                  <div className="form-group">
                    <label htmlFor="day_type">{t('tournamentDays.dayType')}</label>
                    <select
                      id="day_type"
                      value={formData.day_type}
                      onChange={(e) => setFormData({ ...formData, day_type: e.target.value, qualifies_to_day_id: '' })}
                    >
                      <option value="regular">{t('tournamentDays.regular')}</option>
                      {/* Classificatório e Final só aparecem ao EDITAR um dia que já
                          é desse tipo — na criação manual só existe "Regular", pois
                          classificatórios/final são gerados na criação do torneio. */}
                      {isEditing && <option value="qualifying">{t('tournamentDays.qualifying')}</option>}
                      {isEditing && <option value="final">{t('tournamentDays.final')}</option>}
                    </select>
                    <small className="form-hint">
                      {formData.day_type === 'qualifying' && t('tournamentDayForm.qualifyingHint')}
                      {formData.day_type === 'final' && t('tournamentDayForm.finalHint')}
                      {formData.day_type === 'regular' && t('tournamentDayForm.regularHint')}
                    </small>
                  </div>
                  {formData.day_type === 'qualifying' && (
                    <div className="form-group">
                      <label htmlFor="qualifies_to_day_id">{t('tournamentDays.qualifiesTo')} *</label>
                      <select
                        id="qualifies_to_day_id"
                        value={formData.qualifies_to_day_id}
                        onChange={(e) => setFormData({ ...formData, qualifies_to_day_id: e.target.value })}
                        required={formData.day_type === 'qualifying'}
                      >
                        <option value="">{t('tournamentDayForm.selectFinalDay')}</option>
                        {days
                          .filter(d => d.id !== dayId && (d.day_type === 'final' || d.day_type === 'regular'))
                          .map(d => (
                            <option key={d.id} value={d.id}>{d.day_name}</option>
                          ))
                        }
                      </select>
                      <small className="form-hint">{t('tournamentDayForm.qualifiesToHint')}</small>
                    </div>
                  )}
                </div>
              )}
            </div>

            {/* Meios de entrada: são do TORNEIO e valem para todos os dias — aqui
                só se lê (o Final não vende entrada). Para alterar, edita-se o
                torneio; é de lá que o Caixa vende. */}
            {formData.day_type !== 'final' && (
              <div className="form-section entry-methods-section">
                <h3 className="form-section-title">
                  {t('tournamentDayForm.entryMethodsFromTournament', 'Meios de entrada do torneio')}
                </h3>
                <p className="form-hint entry-methods-intro">
                  {t(
                    'tournamentDayForm.entryMethodsFromTournamentHint',
                    'A lista é do torneio e vale para todos os dias dele. Para alterar, edite o torneio.'
                  )}
                </p>

                {meiosDoTorneio.length > 0 ? (
                  <table className="entry-methods-table">
                    <thead>
                      <tr>
                        <th>{t('tournamentDayForm.entryMethodName', 'Nome')}</th>
                        <th>{t('tournamentDayForm.entryMethodCategory', 'Categoria')}</th>
                        <th>{t('tournamentDayForm.entryMethodAmount', 'Valor')}</th>
                        <th>{t('tournamentDayForm.entryMethodRake', 'Rake (%)')}</th>
                        <th>{t('tournamentDayForm.entryMethodChips', 'Fichas')}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {meiosDoTorneio.map((meio) => (
                        <tr key={meio.key}>
                          <td>{meio.name}</td>
                          <td>{rotuloDaCategoria(meio.category)}</td>
                          <td>{currencySymbol(currency)} {Number(meio.amount || 0).toFixed(2)}</td>
                          <td>{Number(meio.rake_percentage || 0)}%</td>
                          <td>{Number(meio.chips || 0).toLocaleString()}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                ) : (
                  <p className="form-hint entry-methods-none">
                    {t('tournamentDayForm.entryMethodsNone', 'Este torneio ainda não tem meios de entrada cadastrados.')}
                  </p>
                )}

                <Button type="button" variant="secondary" onClick={() => navigate(`/torneios/${tournamentId}`)}>
                  {t('tournamentDayForm.editOnTournament', 'Editar no torneio')}
                </Button>
              </div>
            )}

            {/* Lotação - only for non-final days */}
            {formData.day_type !== 'final' && (
              <div className="form-section">
                <h3 className="form-section-title">{t('tournamentDayForm.playersSection', 'Jogadores')}</h3>
                <div className="form-row">
                  <div className="form-group">
                    <label htmlFor="max_players">{t('tournaments.maxPlayers')} *</label>
                    <input
                      id="max_players"
                      type="number"
                      min="1"
                      value={formData.max_players}
                      onChange={(e) => setFormData({ ...formData, max_players: parseInt(e.target.value) })}
                      required
                    />
                  </div>
                </div>
              </div>
            )}

            {/* Rebuy Limit - only for non-final days */}
            {formData.day_type !== 'final' && (
              <div className="form-section">
                <h3 className="form-section-title">{t('tournamentDayForm.rebuyConfig')}</h3>
                <div className="form-row">
                  <div className="form-group">
                    <label htmlFor="rebuy_level_limit">{t('tournamentDayForm.rebuyLevelLimit')}</label>
                    <input
                      id="rebuy_level_limit"
                      type="number"
                      min="1"
                      value={formData.rebuy_level_limit}
                      onChange={(e) => setFormData({ ...formData, rebuy_level_limit: e.target.value })}
                      placeholder={t('tournamentDayForm.leaveEmptyUnlimited')}
                    />
                    <small className="form-hint">{t('tournamentDayForm.rebuyLevelHint')}</small>
                  </div>
                </div>
              </div>
            )}


            <div className="form-actions">
              <Button type="button" variant="secondary" onClick={handleCancel}>
                {t('common.cancel')}
              </Button>
              <Button type="submit" disabled={submitting}>
                {submitting ? t('tournamentDayForm.saving') : (isEditing ? t('tournamentDayForm.saveChanges') : t('tournamentDayForm.createDay'))}
              </Button>
            </div>
          </form>
        </Card>
      </main>
    </div>
  );
};

export default TournamentDayForm;
