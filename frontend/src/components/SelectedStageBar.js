import { useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { useStage } from '../contexts/StageContext';
import './SelectedStageBar.css';

const SelectedStageBar = () => {
  const { t } = useTranslation();
  const { selectedStage, clearStage } = useStage();

  useEffect(() => {
    if (selectedStage) {
      // Add class to all main-content elements
      const mainContents = document.querySelectorAll('.main-content');
      mainContents.forEach(el => el.classList.add('with-stage-bar'));

      return () => {
        mainContents.forEach(el => el.classList.remove('with-stage-bar'));
      };
    }
  }, [selectedStage]);

  if (!selectedStage) {
    return null;
  }

  const formatDate = (dateString) => {
    if (!dateString) return '';
    return new Date(dateString).toLocaleDateString('pt-BR');
  };

  return (
    <div className="selected-stage-bar">
      <div className="selected-stage-content">
        <div className="stage-indicator">
          <div className="stage-details">
            <span className="stage-label">{t('stageBar.selectedStage')}</span>
            <span className="stage-name">{selectedStage.name}</span>
            {selectedStage.location && (
              <span className="stage-location"> • {selectedStage.location}</span>
            )}
            {selectedStage.start_date && (
              <span className="stage-dates">
                {' '}• {formatDate(selectedStage.start_date)}
                {selectedStage.end_date && ` - ${formatDate(selectedStage.end_date)}`}
              </span>
            )}
          </div>
        </div>
        <button
          className="clear-stage-btn"
          onClick={clearStage}
          title={t('stageBar.deselectTitle')}
        >
          {t('stageBar.deselect')}
        </button>
      </div>
    </div>
  );
};

export default SelectedStageBar;
