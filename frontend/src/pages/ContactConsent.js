import React, { useCallback, useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import api from '../config/api';
import Button from '../components/Button';
import LanguageSelector from '../components/LanguageSelector';
import aceblindLogo from '../assets/aceblind-logo-white.png';
import './Login.css';
import './SetPassword.css';
import './ContactConsent.css';

/**
 * Página PÚBLICA onde o jogador responde ao pedido de contatos (LGPD).
 *
 * Chega pelo link do e-mail que o clube manda no cadastro. O token do link é a
 * única credencial: uso único, 30 dias. A página mostra só o nome do clube e o
 * primeiro nome do jogador — o link pode ter sido encaminhado.
 *
 * Os dois botões têm o MESMO peso visual de propósito: recusar precisa ser tão
 * fácil quanto autorizar, senão não é consentimento.
 */
const ContactConsent = () => {
  const { t } = useTranslation();
  const { token } = useParams();

  // loading | ready | answered | invalid | expired
  const [status, setStatus] = useState('loading');
  const [info, setInfo] = useState(null);
  const [answer, setAnswer] = useState(null);   // 'granted' | 'denied'
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const carregar = useCallback(async () => {
    try {
      const res = await api.get(`/public/consent/${encodeURIComponent(token || '')}`, { _silentError: true });
      const d = res.data || {};
      setInfo(d);
      if (d.used || d.status === 'granted' || d.status === 'denied') {
        setAnswer(d.status === 'granted' || d.status === 'denied' ? d.status : null);
        setStatus('answered');
      } else if (d.expired) {
        setStatus('expired');
      } else {
        setStatus('ready');
      }
    } catch {
      setStatus('invalid');
    }
  }, [token]);

  useEffect(() => { carregar(); }, [carregar]);

  const responder = async (aceita) => {
    setSaving(true);
    setError('');
    try {
      const res = await api.post(
        `/public/consent/${encodeURIComponent(token || '')}`,
        { accept: aceita },
        { _silentError: true },
      );
      setAnswer(res.data?.status || (aceita ? 'granted' : 'denied'));
      setStatus('answered');
    } catch (err) {
      const code = err?.response?.data?.detail?.code;
      if (code === 'link_expirado') setStatus('expired');
      else if (code === 'link_ja_usado') await carregar();
      else setError(err.userMessage || t('consent.error', 'Não foi possível registrar sua resposta. Tente de novo.'));
    } finally {
      setSaving(false);
    }
  };

  const clube = info?.organization_name || '';
  const nome = info?.player_first_name || '';

  return (
    <div className="login-container login-centered">
      <div className="login-language-selector">
        <LanguageSelector />
      </div>
      <div className="login-card">
        <div className="login-header">
          <img src={aceblindLogo} alt="AceBlind" className="login-logo" />
        </div>

        {status === 'loading' && (
          <p className="sp-state">{t('common.loading', 'Carregando...')}</p>
        )}

        {status === 'invalid' && (
          <div className="sp-state">
            <h2 className="sp-title">{t('consent.invalidTitle', 'Link inválido')}</h2>
            <p className="sp-hint">
              {t('consent.invalidHint', 'Confira se o endereço está completo, ou peça ao clube um novo e-mail.')}
            </p>
          </div>
        )}

        {status === 'expired' && (
          <div className="sp-state">
            <h2 className="sp-title">{t('consent.expiredTitle', 'Este link expirou')}</h2>
            <p className="sp-hint">
              {t('consent.expiredHint', 'Peça ao {{club}} para reenviar o pedido. Enquanto isso, nenhum contato promocional é feito.', { club: clube || t('consent.theClub', 'clube') })}
            </p>
          </div>
        )}

        {status === 'answered' && (
          <div className="sp-state" role="status">
            <h2 className="sp-title">
              {answer === 'granted'
                ? t('consent.grantedTitle', 'Obrigado! Contatos autorizados.')
                : answer === 'denied'
                  ? t('consent.deniedTitle', 'Tudo certo. Você não receberá contatos promocionais.')
                  : t('consent.answeredTitle', 'Este pedido já foi respondido.')}
            </h2>
            <p className="sp-hint">
              {t('consent.changeHint', 'Mudou de ideia? É só falar com o {{club}}.', { club: clube || t('consent.theClub', 'clube') })}
            </p>
          </div>
        )}

        {status === 'ready' && (
          <>
            <h2 className="sp-title">
              {nome
                ? t('consent.titleNamed', 'Olá, {{name}}!', { name: nome })
                : t('consent.title', 'Olá!')}
            </h2>
            <p className="sp-hint">
              {t('consent.question', 'O {{club}} pode enviar a você novidades, programação de torneios, promoções e avisos por e-mail, WhatsApp ou telefone?', { club: clube })}
            </p>
            {error && <div className="error-message" role="alert">{error}</div>}
            <div className="cc-actions">
              <Button type="button" variant="primary" className="login-btn" disabled={saving} onClick={() => responder(true)}>
                {t('consent.accept', 'Sim, autorizo')}
              </Button>
              <Button type="button" variant="secondary" className="login-btn" disabled={saving} onClick={() => responder(false)}>
                {t('consent.decline', 'Não autorizo')}
              </Button>
            </div>
            <p className="sp-hint cc-note">
              {t('consent.note', 'Sua resposta vale só para contatos promocionais deste clube. Você pode mudar de ideia quando quiser, pedindo ao clube.')}
            </p>
          </>
        )}
      </div>
    </div>
  );
};

export default ContactConsent;
