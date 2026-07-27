import React from 'react';
import i18n from 'i18next';
import { isOnline } from '../offline/connectivity';
import './ErrorBoundary.css';

// Offline de verdade = o app perdeu a conexão OU o navegador está offline.
// navigator.onLine sozinho não basta: ele continua true quando só o servidor
// caiu (a máquina tem wi-fi, mas a API não responde). O isOnline() do app é
// marcado como offline pelo interceptor assim que uma request falha por rede.
const appOffline = () => !isOnline() || !navigator.onLine;

/**
 * ErrorBoundary — B2.2
 * Cada seção/página tem seu próprio boundary para evitar que o app inteiro quebre.
 *
 * Consciente de OFFLINE: uma tela que ainda não foi aberta com internet não tem
 * dados em cache e pode estourar ao renderizar sem eles. Nesse caso mostramos um
 * aviso calmo de "sem conexão" — e não o alarmante "Erro na aplicação /
 * Recarregue a página", que assustava o operador durante um evento.
 */
class ErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { hasError: false, error: null, offline: appOffline() };
  }

  static getDerivedStateFromError(error) {
    return { hasError: true, error, offline: appOffline() };
  }

  componentDidCatch(error, info) {
    console.error('[ErrorBoundary]', error, info);
  }

  handleRetry = () => {
    this.setState({ hasError: false, error: null });
  };

  render() {
    if (this.state.hasError) {
      if (this.state.offline) {
        return (
          <div className="eb-container">
            <div className="eb-icon">⚡</div>
            <h3 className="eb-title">
              {i18n.t('offline.screenNeedsNetTitle', 'Sem conexão')}
            </h3>
            <p className="eb-subtitle">
              {i18n.t('offline.screenNeedsNetDesc',
                'Esta tela ainda não foi carregada offline. Abra-a uma vez com internet, ou volte para uma tela já usada.')}
            </p>
            <button className="eb-btn" onClick={() => window.history.back()}>
              {i18n.t('common.back', 'Voltar')}
            </button>
          </div>
        );
      }
      return (
        <div className="eb-container">
          <div className="eb-icon">!</div>
          <h3 className="eb-title">
            {this.props.title || 'Não foi possível carregar esta seção'}
          </h3>
          <p className="eb-subtitle">
            {this.props.subtitle || 'Ocorreu um erro inesperado. Tente novamente.'}
          </p>
          <button className="eb-btn" onClick={this.handleRetry}>
            {i18n.t('common.retry', 'Tentar novamente')}
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}

export default ErrorBoundary;
