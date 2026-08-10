import React, { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import api from '../config/api';
import { useToast } from '../contexts/ToastContext';
import { enterOrg } from '../utils/orgScope';
import './OrgInviteModal.css';

const ADIADO = 'orgInvites:adiado';

/**
 * Convites de clube para quem JÁ tem conta.
 *
 * Essa pessoa não refaz cadastro — já tem nome e senha. Só decide se entra.
 * Antes deste fluxo ela era adicionada em silêncio, sem aviso e sem escolha.
 *
 * É modal porque exige uma decisão, mas dá para adiar: quem está no meio de um
 * torneio não pode ficar preso numa tela. O adiamento vale só para a sessão —
 * na próxima entrada o convite reaparece.
 */
const OrgInviteModal = () => {
  const { t } = useTranslation();
  const { toast } = useToast();
  const [convites, setConvites] = useState([]);
  const [ocupado, setOcupado] = useState(null);
  const [oculto, setOculto] = useState(() => sessionStorage.getItem(ADIADO) === '1');

  useEffect(() => {
    if (oculto) return;
    // Sem token não há a quem perguntar (tela de login, /tv, broadcast).
    if (!localStorage.getItem('supabase_token')) return;
    let vivo = true;
    api.get('/organizations/invites', { _silentError: true })
      .then((res) => { if (vivo) setConvites(res.data || []); })
      .catch(() => { /* sem permissão ou offline: não atrapalha */ });
    return () => { vivo = false; };
  }, [oculto]);

  const responder = useCallback(async (convite, aceitar) => {
    setOcupado(convite.staff_id);
    try {
      if (aceitar) {
        await api.post(`/organizations/invites/${convite.staff_id}/accept`);
        toast.success(t('orgInvite.accepted', 'Você agora faz parte de {{org}}.',
                        { org: convite.organization_name }));
      } else {
        await api.post(`/organizations/invites/${convite.staff_id}/decline`);
        toast.success(t('orgInvite.declined', 'Convite recusado.'));
      }
      const restantes = convites.filter((c) => c.staff_id !== convite.staff_id);
      setConvites(restantes);

      // Aceitar só vale de verdade com token novo: o vínculo entra no claim na
      // próxima emissão. Sem isso o clube aceito não apareceria no seletor.
      if (aceitar && restantes.length === 0) {
        await enterOrg(convite.organization_id);
      }
    } catch (err) {
      toast.error(err.userMessage || t('orgInvite.error', 'Não foi possível responder ao convite.'));
    } finally {
      setOcupado(null);
    }
  }, [convites, t, toast]);

  const adiar = () => {
    sessionStorage.setItem(ADIADO, '1');
    setOculto(true);
  };

  if (oculto || convites.length === 0) return null;

  return (
    <div className="oim-overlay">
      <div className="oim-modal" role="dialog" aria-modal="true">
        <h2 className="oim-title">
          {convites.length === 1
            ? t('orgInvite.titleOne', 'Você recebeu um convite')
            : t('orgInvite.titleMany', 'Você recebeu {{n}} convites', { n: convites.length })}
        </h2>
        <p className="oim-hint">
          {t('orgInvite.hint', 'Sua conta continua a mesma — você só decide se quer trabalhar neste clube.')}
        </p>

        <ul className="oim-list">
          {convites.map((c) => (
            <li key={c.staff_id} className="oim-item">
              <div className="oim-info">
                <span className="oim-org">{c.organization_name}</span>
                <span className="oim-role">
                  {c.group_name || t('orgInvite.noGroup', 'Sem grupo de permissão')}
                </span>
              </div>
              <div className="oim-acoes">
                <button
                  type="button"
                  className="oim-btn ghost"
                  onClick={() => responder(c, false)}
                  disabled={!!ocupado}
                >
                  {t('orgInvite.decline', 'Recusar')}
                </button>
                <button
                  type="button"
                  className="oim-btn"
                  onClick={() => responder(c, true)}
                  disabled={!!ocupado}
                >
                  {ocupado === c.staff_id
                    ? t('common.loading', 'Carregando...')
                    : t('orgInvite.accept', 'Aceitar')}
                </button>
              </div>
            </li>
          ))}
        </ul>

        <button type="button" className="oim-depois" onClick={adiar} disabled={!!ocupado}>
          {t('orgInvite.later', 'Decidir depois')}
        </button>
      </div>
    </div>
  );
};

export default OrgInviteModal;
