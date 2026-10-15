import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import api from '../../config/api';
import Button from '../Button';
import { useCurrency } from '../../contexts/CurrencyContext';
import { usePaymentMethods } from '../../contexts/PaymentMethodsContext';
import { methodLabel } from '../../utils/paymentMethodLabels';
import { useEscapeKey } from '../../hooks/useEscapeKey';
import './Equipes.css';

const novoId = () => (typeof crypto !== 'undefined' && crypto.randomUUID
  ? crypto.randomUUID()
  : `cm-${Date.now()}-${Math.random().toString(16).slice(2)}`);

/**
 * "Cobrar equipe": a inscrição da equipe inteira num lançamento só. O valor do
 * meio "por equipe" é dividido entre os integrantes (centavos que sobram ficam
 * com o capitão); quem já se inscreveu sozinho no Caixa não paga de novo.
 * Precisa de rede e do caixa aberto — o servidor recusa com o motivo.
 */
const CobrarEquipeModal = ({ tournamentId, equipe: equipeDada = null, onFechar, onCobrado }) => {
  const { t } = useTranslation();
  const { formatCurrency = (v) => String(v) } = useCurrency() || {};
  const { activeMethods = [] } = usePaymentMethods() || {};
  // Do Caixa a equipe ainda não foi escolhida: a lista vem do torneio.
  const [equipes, setEquipes] = useState(null);
  const [equipeId, setEquipeId] = useState(equipeDada?.id || '');
  const [meios, setMeios] = useState(null);
  const [meio, setMeio] = useState('');
  const [metodo, setMetodo] = useState('cash');
  const [ocupado, setOcupado] = useState(false);
  const [erro, setErro] = useState('');
  // Um id por abertura: o reenvio do mesmo clique não cobra duas vezes.
  const cmid = useRef(novoId());
  useEscapeKey(!ocupado, onFechar);

  useEffect(() => {
    let vivo = true;
    api.get(`/tournaments/${tournamentId}/buy-types`)
      .then((res) => {
        if (!vivo) return;
        const porEquipe = (res?.data || []).filter((m) => m.per_team && m.active !== false && m.category === 'buy_in');
        setMeios(porEquipe);
        if (porEquipe.length) setMeio(porEquipe[0].id);
      })
      .catch((err) => { if (vivo) { setMeios([]); setErro(err.userMessage || ''); } });
    return () => { vivo = false; };
  }, [tournamentId]);

  useEffect(() => {
    if (equipeDada) return undefined;
    let vivo = true;
    api.get(`/tournaments/${tournamentId}/teams`)
      .then((res) => {
        if (!vivo) return;
        const pendentes = (res?.data?.teams || []).filter((e) => e.members.some((m) => !m.tp_id || m.status === 'cancelled'));
        setEquipes(pendentes);
        if (pendentes.length) setEquipeId(pendentes[0].id);
      })
      .catch((err) => { if (vivo) { setEquipes([]); setErro(err.userMessage || ''); } });
    return () => { vivo = false; };
  }, [tournamentId, equipeDada]);

  const equipe = equipeDada || (equipes || []).find((e) => e.id === equipeId) || null;

  useEffect(() => {
    if (activeMethods.length && !activeMethods.some((m) => m.code === metodo)) setMetodo(activeMethods[0].code);
  }, [activeMethods, metodo]);

  const faltam = useMemo(
    () => (equipe?.members || []).filter((m) => !m.tp_id || m.status === 'cancelled'),
    [equipe],
  );
  const escolhido = (meios || []).find((m) => m.id === meio);
  const parte = escolhido && equipe?.members?.length ? Number(escolhido.amount || 0) / equipe.members.length : 0;

  const cobrar = async () => {
    setOcupado(true);
    setErro('');
    try {
      const res = await api.post(`/tournaments/${tournamentId}/teams/${equipe.id}/charge`, {
        buy_type_id: meio, payment_method: metodo, client_mutation_id: cmid.current,
      });
      onCobrado(res?.data);
    } catch (err) {
      setErro(err.userMessage || t('teams.chargeError', 'Não foi possível cobrar a equipe.'));
    } finally {
      setOcupado(false);
    }
  };

  const offline = typeof navigator !== 'undefined' && navigator.onLine === false;
  return (
    <div className="eq-overlay" role="presentation" onClick={(e) => { if (e.target === e.currentTarget && !ocupado) onFechar(); }}>
      <div className="eq-modal" role="dialog" aria-modal="true" aria-label={t('teams.chargeTitle', 'Cobrar equipe')}>
        <div className="eq-modal-header">
          <h3>{t('teams.chargeTitle', 'Cobrar equipe')}{equipeDada ? ` — ${equipeDada.name}` : ''}</h3>
          <button type="button" className="eq-close" onClick={onFechar} disabled={ocupado} aria-label={t('common.close', 'Fechar')}>✕</button>
        </div>
        {!equipeDada && (
          <div className="eq-field">
            <label htmlFor="eq-equipe">{t('teams.team', 'Equipe')}</label>
            <select id="eq-equipe" value={equipeId} onChange={(e) => setEquipeId(e.target.value)} disabled={ocupado || !equipes?.length}>
              {(equipes || []).map((e) => <option key={e.id} value={e.id}>{e.name}</option>)}
            </select>
            {equipes && !equipes.length && (
              <small className="eq-hint">{t('teams.noTeamToCharge', 'Nenhuma equipe com integrante a inscrever.')}</small>
            )}
          </div>
        )}
        {meios === null ? (
          <div className="loading">{t('common.loading')}</div>
        ) : meios.length === 0 ? (
          <p className="eq-hint">
            {t('teams.noPerTeamType', 'Nenhum meio de entrada "por equipe" cadastrado. Marque "Por equipe" numa Entrada na edição do torneio — ou inscreva cada integrante no Caixa.')}
          </p>
        ) : (
          <>
            <div className="eq-field">
              <label htmlFor="eq-meio">{t('teams.chargeType', 'Meio de entrada')}</label>
              <select id="eq-meio" value={meio} onChange={(e) => setMeio(e.target.value)} disabled={ocupado}>
                {meios.map((m) => (
                  <option key={m.id} value={m.id}>{m.name} — {formatCurrency(m.amount)}</option>
                ))}
              </select>
            </div>
            <div className="eq-field">
              <label htmlFor="eq-metodo">{t('cashRegister.paymentMethod', 'Forma de pagamento')}</label>
              <select id="eq-metodo" value={metodo} onChange={(e) => setMetodo(e.target.value)} disabled={ocupado}>
                {activeMethods.length === 0 && <option value="cash">{t('cashRegister.cash', 'Dinheiro')}</option>}
                {activeMethods.map((m) => (
                  <option key={m.id} value={m.code}>{methodLabel(t, m)}</option>
                ))}
              </select>
            </div>
            <p className="eq-hint">
              {t('teams.chargeSplit', '{{valor}} por integrante. Serão cobrados: {{nomes}}.', {
                valor: formatCurrency(parte),
                nomes: faltam.map((m) => m.name).join(', ') || '—',
              })}
            </p>
          </>
        )}
        {offline && <div className="eq-erro" role="alert">{t('teams.chargeOffline', 'Sem conexão: a cobrança por equipe precisa de rede.')}</div>}
        {erro && <div className="eq-erro" role="alert">{erro}</div>}
        <div className="eq-modal-footer">
          <Button type="button" variant="secondary" onClick={onFechar} disabled={ocupado}>{t('common.cancel', 'Cancelar')}</Button>
          <Button type="button" onClick={cobrar} disabled={ocupado || offline || !meio || !equipe || !faltam.length}>
            {t('teams.charge', 'Cobrar equipe')}
          </Button>
        </div>
      </div>
    </div>
  );
};

export default CobrarEquipeModal;
