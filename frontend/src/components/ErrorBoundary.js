import React from 'react';
import './ErrorBoundary.css';

/**
 * ErrorBoundary — B2.2
 * Cada seção/página tem seu próprio boundary para evitar que o app inteiro quebre.
 */
class ErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error) {
    return { hasError: true, error };
  }

  componentDidCatch(error, info) {
    console.error('[ErrorBoundary]', error, info);
  }

  handleRetry = () => {
    this.setState({ hasError: false, error: null });
  };

  render() {
    if (this.state.hasError) {
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
            Tentar novamente
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}

export default ErrorBoundary;
