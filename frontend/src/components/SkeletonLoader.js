import React from 'react';
import './SkeletonLoader.css';

// Generic shimmer block
export const SkeletonBlock = ({ width = '100%', height = '1rem', className = '' }) => (
  <div
    className={`skeleton-shimmer ${className}`}
    style={{ width, height, borderRadius: '6px' }}
  />
);

// KPI card skeleton (Dashboard)
export const SkeletonStatCard = () => (
  <div className="skeleton-stat-card">
    <SkeletonBlock width="40px" height="40px" className="skeleton-stat-icon" />
    <div className="skeleton-stat-body">
      <SkeletonBlock width="80px" height="1.75rem" />
      <SkeletonBlock width="120px" height="0.875rem" />
    </div>
  </div>
);

// Table row skeleton
export const SkeletonTableRow = ({ cols = 5 }) => (
  <tr className="skeleton-row">
    {Array.from({ length: cols }).map((_, i) => (
      <td key={i}>
        <SkeletonBlock width={i === 0 ? '140px' : i === cols - 1 ? '80px' : '100px'} height="0.875rem" />
      </td>
    ))}
  </tr>
);

// Tournament card skeleton
export const SkeletonTournamentCard = () => (
  <div className="skeleton-tournament-card">
    <div className="skeleton-tc-header">
      <SkeletonBlock width="40px" height="40px" className="skeleton-tc-icon" />
      <div style={{ flex: 1 }}>
        <SkeletonBlock width="60%" height="1rem" />
        <SkeletonBlock width="40%" height="0.75rem" />
      </div>
    </div>
    <SkeletonBlock width="80%" height="0.875rem" />
    <div className="skeleton-tc-footer">
      <SkeletonBlock width="70px" height="28px" />
      <SkeletonBlock width="70px" height="28px" />
    </div>
  </div>
);

// Players table skeleton
export const SkeletonPlayersTable = ({ rows = 5 }) => (
  <div className="pl-table-card">
    <div className="pl-table-header">
      <SkeletonBlock width="120px" height="0.875rem" />
    </div>
    <div className="pl-table-wrap">
      <table className="pl-table">
        <thead>
          <tr>
            {['Jogador', 'Contato', 'Nacionalidade', 'Documento', 'Ações'].map((h) => (
              <th key={h}>{h}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {Array.from({ length: rows }).map((_, i) => (
            <SkeletonTableRow key={i} cols={5} />
          ))}
        </tbody>
      </table>
    </div>
  </div>
);

// Dashboard activity list skeleton
export const SkeletonActivityList = ({ rows = 3 }) => (
  <div className="skeleton-activity-list">
    {Array.from({ length: rows }).map((_, i) => (
      <div key={i} className="skeleton-activity-item">
        <SkeletonBlock width="60%" height="0.875rem" />
        <SkeletonBlock width="25%" height="0.75rem" />
      </div>
    ))}
  </div>
);

export default SkeletonBlock;
