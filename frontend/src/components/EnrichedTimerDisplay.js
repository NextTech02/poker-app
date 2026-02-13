import React from 'react';
import { useTimerSync, formatTime, formatTimeHuman } from '../hooks/useTimerSync';
import './EnrichedTimerDisplay.css';

/**
 * Enriched Timer Display Component
 *
 * Shows:
 * - Current blind level with values
 * - Next blind preview
 * - Time until next break
 *
 * @param {string} dayId - Tournament day ID
 * @param {boolean} compact - Show compact version (default: false)
 */
const EnrichedTimerDisplay = ({ dayId, compact = false }) => {
  const { timerState, isLoading, error } = useTimerSync(dayId);

  if (isLoading) {
    return <div className="enriched-timer-loading">Carregando...</div>;
  }

  if (error || !timerState) {
    return null; // Silently fail - don't break the page
  }

  const { current_blind, next_blind, next_break } = timerState;

  if (compact) {
    // Compact version for smaller displays
    return (
      <div className="enriched-timer-compact">
        {/* Next Blind Preview */}
        {next_blind && (
          <div className="next-blind-compact">
            <span className="label">Próximo:</span>
            {next_blind.is_break ? (
              <span className="value">Intervalo ({next_blind.duration / 60}min)</span>
            ) : (
              <span className="value">
                {next_blind.small_blind}/{next_blind.big_blind}
                {next_blind.ante > 0 && ` (${next_blind.ante})`}
              </span>
            )}
          </div>
        )}

        {/* Break Countdown */}
        {next_break && (
          <div className="break-countdown-compact">
            <span className="label">Intervalo em:</span>
            <span className="value">{formatTimeHuman(next_break.time_until_break)}</span>
          </div>
        )}
      </div>
    );
  }

  // Full version for main displays
  return (
    <div className="enriched-timer-full">
      {/* Current Level Status */}
      {current_blind && (
        <div className="current-blind-section">
          {current_blind.is_break ? (
            <div className="break-indicator">
              <h2 className="break-title">INTERVALO</h2>
              <p className="break-subtitle">Tempo restante: {formatTime(timerState.time_remaining_current_level)}</p>
            </div>
          ) : (
            <div className="blind-values-grid">
              <div className="blind-value-item">
                <span className="blind-label">Small Blind</span>
                <span className="blind-amount">{current_blind.small_blind}</span>
              </div>
              <div className="blind-value-item">
                <span className="blind-label">Big Blind</span>
                <span className="blind-amount">{current_blind.big_blind}</span>
              </div>
              {current_blind.ante > 0 && (
                <div className="blind-value-item">
                  <span className="blind-label">Ante</span>
                  <span className="blind-amount">{current_blind.ante}</span>
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {/* Next Blind Preview */}
      {next_blind && (
        <div className="next-blind-section">
          <h3 className="section-title">Próximo Nível</h3>
          {next_blind.is_break ? (
            <p className="next-blind-info">
              Intervalo - {next_blind.duration / 60} minutos
            </p>
          ) : (
            <p className="next-blind-info">
              {next_blind.small_blind} / {next_blind.big_blind}
              {next_blind.ante > 0 && ` (Ante: ${next_blind.ante})`}
            </p>
          )}
        </div>
      )}

      {/* Break Countdown */}
      {next_break && !current_blind?.is_break && (
        <div className="break-countdown-section">
          <h3 className="section-title">Próximo Intervalo</h3>
          <p className="break-countdown-time">
            {formatTimeHuman(next_break.time_until_break)}
          </p>
        </div>
      )}
    </div>
  );
};

export default EnrichedTimerDisplay;
