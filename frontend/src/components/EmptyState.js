import React, { memo } from 'react';
import './EmptyState.css';

/**
 * Unified EmptyState component (A2)
 * @param {string} icon - emoji or SVG element
 * @param {string} title - main title
 * @param {string} subtitle - helper text
 * @param {string} ctaLabel - button label (optional)
 * @param {function} onCta - button click handler (optional)
 */
const EmptyState = ({ icon, title, subtitle, ctaLabel, onCta }) => (
  <div className="empty-state-card">
    <div className="es-icon">{icon}</div>
    <h3 className="es-title">{title}</h3>
    {subtitle && <p className="es-subtitle">{subtitle}</p>}
    {ctaLabel && onCta && (
      <button type="button" className="es-cta" onClick={onCta}>
        <svg viewBox="0 0 24 24" fill="currentColor" width="16" height="16">
          <path d="M19 13h-6v6h-2v-6H5v-2h6V5h2v6h6v2z"/>
        </svg>
        {ctaLabel}
      </button>
    )}
  </div>
);

export default memo(EmptyState);
