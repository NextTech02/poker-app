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
import './TournamentDayForm.css';

// A categoria NÃO é rótulo: é ela que decide o efeito da venda no Caixa (entrada
// soma jogador novo, recompra devolve alguém à mesa, add-on só entrega fichas).
// O NOME é livre justamente para o clube poder ter "Buy-in duplo" e "Rebuy
// triplo" sem precisar de categoria nova.
//
// Chave só do React/DOM: linhas novas ainda não têm id do banco, e usar o índice
// como key faria o React reaproveitar o input errado ao remover uma linha do meio
// (o texto digitado "pularia" de linha).
let sequenciaLinha = 0;
const proximaChave = () => `em${++sequenciaLinha}`;

// O input guarda TEXTO, não número: `parseFloat('')` é NaN, e um NaN no `value`
// de um <input type="number"> faz o React reclamar e o campo ficar impossível de
// apagar. A conversão acontece só na hora de enviar.
const novaLinha = (dados = {}) => ({
  key: proximaChave(),
  id: dados.id ?? null,
  name: dados.name ?? '',
  category: dados.category ?? 'buy_in',
  amount: dados.amount === undefined || dados.amount === null ? '' : String(dados.amount),
  rake_percentage:
    dados.rake_percentage === undefined || dados.rake_percentage === null
      ? '0'
      : String(dados.rake_percentage),
  chips: dados.chips === undefined || dados.chips === null ? '0' : String(dados.chips),
});

const numero = (texto) => {
  const n = parseFloat(texto);
  return Number.isFinite(n) ? n : 0;
};

const inteiro = (texto) => {
  const n = parseInt(texto, 10);
  return Number.isFinite(n) ? n : 0;
};

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

  // Meios de entrada do DIA (nome, valor, rake e FICHAS próprios). Substituem os
  // seis campos soltos que existiam aqui: "rebuy duplo" não é rebuy × 2, tem
  // valor e fichas próprios, e isso não cabia em campos fixos.
  const [entryMethods, setEntryMethods] = useState([]);
  // Meios desativados que vieram do banco. Não aparecem na tela, mas voltam no
  // PUT: sumir com eles apagaria linhas que vendas antigas ainda referenciam.
  const [inactiveMethods, setInactiveMethods] = useState([]);
  const [entryError, setEntryError] = useState('');

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

  // Um dia começa com os três meios de sempre; o clube renomeia, muda valor e
  // acrescenta quantos quiser. Sem nenhum meio de entrada não há como inscrever
  // ninguém, então a tela nunca abre vazia.
  const meiosPadrao = () => [
    novaLinha({ name: t('tournamentDayForm.defaultBuyIn', 'Buy-in'), category: 'buy_in', amount: 100, chips: 10000 }),
    novaLinha({ name: t('tournamentDayForm.defaultRebuy', 'Rebuy'), category: 'rebuy', amount: 100, chips: 10000 }),
    novaLinha({ name: t('tournamentDayForm.defaultAddon', 'Add-on'), category: 'addon', amount: 100, chips: 10000 }),
  ];

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
        // Os meios de entrada só existem depois que o dia existe. Na criação
        // eles são coletados na tela e enviados logo após o POST do dia.
        dayId
          ? api.get(`/tournament-days/${dayId}/buy-types`).catch((e) => {
              // Falha aqui não pode derrubar o formulário inteiro: o dia
              // continua editável e a lista cai nos valores do próprio dia
              // (mesmo caminho do dia antigo, ainda sem meios cadastrados).
              console.error('Erro ao carregar meios de entrada:', e);
              return null;
            })
          : Promise.resolve(null),
      ]);

      setTournament(tournamentRes.data);
      setDays(daysRes.data);

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

        const vindos = Array.isArray(meiosRes?.data) ? meiosRes.data : [];
        const ativos = vindos.filter((m) => m.active !== false);
        setInactiveMethods(vindos.filter((m) => m.active === false));
        // Dia antigo, migrado antes de ter meios cadastrados: mostra os três
        // padrões já preenchidos com o que o dia cobra, em vez de tela vazia.
        setEntryMethods(
          ativos.length
            ? [...ativos]
                .sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0))
                .map((m) => novaLinha(m))
            : [
                novaLinha({ name: t('tournamentDayForm.defaultBuyIn', 'Buy-in'), category: 'buy_in', amount: day.buy_in ?? 0, chips: day.starting_chips ?? 0, rake_percentage: day.rake_percentage ?? 0 }),
                novaLinha({ name: t('tournamentDayForm.defaultRebuy', 'Rebuy'), category: 'rebuy', amount: day.rebuy_amount ?? 0, chips: day.rebuy_chips ?? 0, rake_percentage: day.rake_percentage ?? 0 }),
                novaLinha({ name: t('tournamentDayForm.defaultAddon', 'Add-on'), category: 'addon', amount: day.addon_amount ?? 0, chips: day.addon_chips ?? 0, rake_percentage: day.rake_percentage ?? 0 }),
              ]
        );
      } else {
        setEntryMethods(meiosPadrao());
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

  // ── Meios de entrada: edição das linhas ───────────────────────────────────
  const alterarMeio = (chave, campoAlterado, valor) => {
    setEntryMethods((linhas) =>
      linhas.map((l) => (l.key === chave ? { ...l, [campoAlterado]: valor } : l))
    );
    setEntryError('');
  };

  const adicionarMeio = () => {
    setEntryMethods((linhas) => [...linhas, novaLinha({ category: 'buy_in' })]);
    setEntryError('');
  };

  const removerMeio = (chave) => {
    const restantes = entryMethods.filter((l) => l.key !== chave);
    // Sem nenhum meio de ENTRADA não há como inscrever ninguém no dia — a venda
    // de rebuy/add-on pressupõe alguém já inscrito. Bloqueia com mensagem em vez
    // de deixar o operador descobrir isso no Caixa, com o clube cheio.
    if (!restantes.some((l) => l.category === 'buy_in')) {
      setEntryError(
        t(
          'tournamentDayForm.entryMethodsNeedBuyIn',
          'É preciso manter ao menos um meio de entrada da categoria "Entrada" — sem ele não há como inscrever jogadores neste dia.'
        )
      );
      return;
    }
    setEntryMethods(restantes);
    setEntryError('');
  };

  // Devolve a mensagem do problema, ou '' quando está tudo certo.
  const validarMeios = (linhas) => {
    if (linhas.some((l) => !l.name.trim())) {
      return t('tournamentDayForm.entryMethodsNeedName', 'Dê um nome a cada meio de entrada.');
    }
    if (!linhas.some((l) => l.category === 'buy_in')) {
      return t(
        'tournamentDayForm.entryMethodsNeedBuyIn',
        'É preciso manter ao menos um meio de entrada da categoria "Entrada" — sem ele não há como inscrever jogadores neste dia.'
      );
    }
    return '';
  };

  const meiosParaApi = (linhas) => [
    ...linhas.map((l, indice) => ({
      id: l.id,
      name: l.name.trim(),
      category: l.category,
      amount: numero(l.amount),
      rake_percentage: numero(l.rake_percentage),
      chips: inteiro(l.chips),
      active: true,
      // A ordem da tela é a ordem que o Caixa mostra: o operador organiza aqui.
      sort_order: indice,
    })),
    // Os desativados voltam intocados (ver comentário na declaração do estado).
    ...inactiveMethods.map((m, indice) => ({
      id: m.id,
      name: m.name,
      category: m.category,
      amount: m.amount,
      rake_percentage: m.rake_percentage,
      chips: m.chips,
      active: false,
      sort_order: linhas.length + indice,
    })),
  ];

  const primeiroDa = (linhas, categoria) => linhas.find((l) => l.category === categoria) || null;

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError(null);

    // O dia final não vende entrada — quem chega vem classificado —, então lá
    // não há meio de entrada para validar.
    const usaMeios = formData.day_type !== 'final';
    if (usaMeios) {
      const problema = validarMeios(entryMethods);
      if (problema) {
        setEntryError(problema);
        return;
      }
    }

    setSubmitting(true);

    try {
      // As colunas antigas do dia (buy_in, fichas...) continuam existindo e são
      // lidas por telas e relatórios que ainda não conhecem os meios de entrada.
      // Preenchemos com o PRIMEIRO meio de cada categoria para elas não ficarem
      // contando uma história diferente da que o Caixa cobra.
      const entrada = primeiroDa(entryMethods, 'buy_in');
      const recompra = primeiroDa(entryMethods, 'rebuy');
      const addon = primeiroDa(entryMethods, 'addon');

      let dayData = {
        ...formData,
        tournament_id: tournamentId,
        buy_in: entrada ? numero(entrada.amount) : 0,
        starting_chips: entrada ? inteiro(entrada.chips) : 0,
        // Valor zerado vira NULO, não zero: "rebuy de R$ 0,00" diria que o rebuy
        // é de graça; nulo diz que ele não existe neste dia.
        rebuy_amount: recompra && numero(recompra.amount) > 0 ? numero(recompra.amount) : null,
        rebuy_chips: recompra ? inteiro(recompra.chips) : 0,
        addon_amount: addon && numero(addon.amount) > 0 ? numero(addon.amount) : null,
        addon_chips: addon ? inteiro(addon.chips) : 0,
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
        if (usaMeios) await api.put(`/tournament-days/${dayId}/buy-types`, { items: meiosParaApi(entryMethods) });
      } else {
        const createRes = await api.post('/tournament-days', dayData);
        const newDayId = createRes?.data?.id;
        // O dia só existe agora — por isso os meios são coletados na tela e
        // gravados aqui, na mesma ação de salvar.
        if (newDayId && usaMeios) {
          await api.put(`/tournament-days/${newDayId}/buy-types`, { items: meiosParaApi(entryMethods) });
        }
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

            {/* Meios de entrada — só para dias que vendem entrada (o Final não vende) */}
            {formData.day_type !== 'final' && (
              <div className="form-section entry-methods-section">
                <h3 className="form-section-title">
                  {t('tournamentDayForm.entryMethods', 'Meios de entrada')}
                </h3>
                <p className="form-hint entry-methods-intro">
                  {t(
                    'tournamentDayForm.entryMethodsIntro',
                    'Cada meio de entrada tem nome, valor, rake e fichas próprios. Cadastre aqui o que este dia vende — inclusive variações como "Buy-in duplo" ou "Rebuy triplo".'
                  )}
                </p>

                {entryError && (
                  <div className="entry-methods-error" role="alert">
                    {entryError}
                  </div>
                )}

                <div className="entry-methods-list">
                  {entryMethods.map((meio, indice) => (
                    <div className="entry-method-row" key={meio.key}>
                      <div className="form-group entry-method-name">
                        <label htmlFor={`entry_name_${meio.key}`}>
                          {t('tournamentDayForm.entryMethodName', 'Nome')} *
                        </label>
                        <input
                          id={`entry_name_${meio.key}`}
                          type="text"
                          value={meio.name}
                          onChange={(e) => alterarMeio(meio.key, 'name', e.target.value)}
                          placeholder={t('tournamentDayForm.entryMethodNamePlaceholder', 'Ex: Buy-in duplo')}
                          required
                        />
                      </div>
                      <div className="form-group">
                        <label htmlFor={`entry_amount_${meio.key}`}>
                          {t('tournamentDayForm.entryMethodAmount', 'Valor')} ({currencySymbol(currency)})
                        </label>
                        <input
                          id={`entry_amount_${meio.key}`}
                          type="number"
                          min="0"
                          step="0.01"
                          value={meio.amount}
                          onChange={(e) => alterarMeio(meio.key, 'amount', e.target.value)}
                        />
                      </div>
                      <div className="form-group">
                        <label htmlFor={`entry_rake_${meio.key}`}>
                          {t('tournamentDayForm.entryMethodRake', 'Rake (%)')}
                        </label>
                        <input
                          id={`entry_rake_${meio.key}`}
                          type="number"
                          min="0"
                          max="100"
                          step="0.01"
                          value={meio.rake_percentage}
                          onChange={(e) => alterarMeio(meio.key, 'rake_percentage', e.target.value)}
                        />
                      </div>
                      <div className="form-group">
                        <label htmlFor={`entry_chips_${meio.key}`}>
                          {t('tournamentDayForm.entryMethodChips', 'Fichas')}
                        </label>
                        <input
                          id={`entry_chips_${meio.key}`}
                          type="number"
                          min="0"
                          value={meio.chips}
                          onChange={(e) => alterarMeio(meio.key, 'chips', e.target.value)}
                        />
                      </div>
                      <div className="form-group">
                        <label htmlFor={`entry_category_${meio.key}`}>
                          {t('tournamentDayForm.entryMethodCategory', 'Categoria')}
                        </label>
                        <select
                          id={`entry_category_${meio.key}`}
                          value={meio.category}
                          onChange={(e) => alterarMeio(meio.key, 'category', e.target.value)}
                          /* A dica é uma só para a coluna inteira (repeti-la em
                             cada linha viraria ruído); o aria-describedby liga
                             todos os selects a ela. */
                          aria-describedby="entry_category_hint"
                        >
                          <option value="buy_in">{t('tournamentDayForm.categoryBuyIn', 'Entrada')}</option>
                          <option value="rebuy">{t('tournamentDayForm.categoryRebuy', 'Recompra')}</option>
                          <option value="addon">{t('tournamentDayForm.categoryAddon', 'Add-on')}</option>
                        </select>
                        {indice === 0 && (
                          <small className="form-hint" id="entry_category_hint">
                            {t(
                              'tournamentDayForm.entryMethodCategoryHint',
                              'A categoria decide o efeito da venda: Entrada soma um jogador novo, Recompra devolve alguém à mesa, Add-on só entrega fichas a quem já joga.'
                            )}
                          </small>
                        )}
                      </div>
                      <div className="entry-method-actions">
                        <Button
                          type="button"
                          variant="danger"
                          size="small"
                          onClick={() => removerMeio(meio.key)}
                          aria-label={t('tournamentDayForm.removeEntryMethodOf', 'Remover meio de entrada {{nome}}', {
                            nome: meio.name || t('tournamentDayForm.entryMethodUnnamed', 'sem nome'),
                          })}
                        >
                          {t('tournamentDayForm.removeEntryMethod', 'Remover')}
                        </Button>
                      </div>
                    </div>
                  ))}
                </div>

                <Button type="button" variant="secondary" onClick={adicionarMeio}>
                  {t('tournamentDayForm.addEntryMethod', 'Adicionar meio de entrada')}
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
