import { createContext, useContext, useEffect, useState } from 'react';

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

  const selectStage = (stage) => {
    setSelectedStage(stage);
    localStorage.setItem('selected_stage', JSON.stringify(stage));
  };

  const clearStage = () => {
    setSelectedStage(null);
    localStorage.removeItem('selected_stage');
  };

  const value = {
    selectedStage,
    selectStage,
    clearStage,
    loading,
  };

  return <StageContext.Provider value={value}>{children}</StageContext.Provider>;
};
