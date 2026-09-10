import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { clearCache } from '../utils/apiCache';

const StageContext = createContext({});

export const useStage = () => useContext(StageContext);

export const StageProvider = ({ children }) => {
  const [selectedStage, setSelectedStage] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    // Load selected stage from localStorage on mount
    const storedStage = localStorage.getItem('selected_stage');
    if (storedStage) {
      try {
        setSelectedStage(JSON.parse(storedStage));
      } catch (error) {
        console.error('Error parsing stored stage:', error);
        localStorage.removeItem('selected_stage');
      }
    }
    setLoading(false);
  }, []);

  const selectStage = useCallback((stage) => {
    // Drop cached responses from the previous stage so the next reads can't
    // serve another stage's data (the stage lives in a header, not the URL).
    clearCache();
    setSelectedStage(stage);
    localStorage.setItem('selected_stage', JSON.stringify(stage));
  }, []);

  const clearStage = useCallback(() => {
    clearCache();
    setSelectedStage(null);
    localStorage.removeItem('selected_stage');
  }, []);

  // A etapa selecionada e lida por quase toda tela do modulo de torneio: sem
  // memo, qualquer render deste provider repintava todas elas.
  const value = useMemo(
    () => ({ selectedStage, selectStage, clearStage, loading }),
    [selectedStage, loading, selectStage, clearStage],
  );

  return <StageContext.Provider value={value}>{children}</StageContext.Provider>;
};
