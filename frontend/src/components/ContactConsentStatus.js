import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';
import api from '../config/api';
import Button from './Button';
import { useToast } from '../contexts/ToastContext';
import './ContactConsentStatus.css';

/**
 * Situação da autorização de contatos do jogador (LGPD) e, enquanto ele não
 * respondeu, o botão de (re)enviar o pedido por e-mail.
 *
 * Só "autorizado" permite contato promocional. Pendente e "não pedido" valem
 * como NÃO. Quem recusou não recebe novo pedido — o botão some.
 *
 * `compact` mostra só o selo (lista de jogadores).
 */
const ESTILO = {
  granted: 'badge-success',
  denied: 'badge-danger',
  pending: 'badge-warning',
};

const ContactConsentStatus = ({ player, onChange, compact = false }) => {
  const { t } = useTranslation();
  const { toast } = useToast();
  const [sending, setSending] = useState(false);

  if (!player) return null;
  const status = player.contact_consent || null;

  const rotulo = {
    granted: t('consent.statusGranted', 'Contatos autorizados'),
    denied: t('consent.statusDenied', 'Contatos recusados'),
    pending: t('consent.statusPending', 'Aguardando autorização'),
  }[status] || t('consent.statusNone', 'Autorização não pedida');

  const podeEnviar = !compact && (status === null || status === 'pending');

  const enviar = async () => {
    setSending(true);
    try {
      const res = await api.post(`/players/${player.id}/consent/resend`);
      toast.success(t('consent.resent', 'Pedido de autorização enviado para {{email}}', { email: player.email }));
      onChange?.({ ...player, contact_consent: res.data?.contact_consent || 'pending' });
    } catch (err) {
      toast.error(err.userMessage || t('consent.resendError', 'Não foi possível enviar o pedido'));
    } finally {
      setSending(false);
    }
  };

  return (
    <span className="ccs">
      <span
        className={`badge badge-plain ${ESTILO[status] || 'badge-secondary'}`}
        title={t('consent.badgeHint', 'Autorização do jogador para contatos promocionais (e-mail, WhatsApp, telefone)')}
      >
        {rotulo}
      </span>
      {podeEnviar && (
        <Button variant="ghost" size="small" onClick={enviar} disabled={sending}>
          {status === 'pending'
            ? t('consent.resend', 'Reenviar pedido')
            : t('consent.send', 'Pedir autorização')}
        </Button>
      )}
    </span>
  );
};

export default ContactConsentStatus;
