/**
 * Utility functions for working with selected stage
 */

/**
 * Get the currently selected stage from localStorage
 * @returns {Object|null} Selected stage object or null
 */
export const getSelectedStage = () => {
  try {
    const storedStage = localStorage.getItem('selected_stage');
    return storedStage ? JSON.parse(storedStage) : null;
  } catch (error) {
    console.error('Error getting selected stage:', error);
    return null;
  }
};

/**
 * Get the ID of the currently selected stage
 * @returns {string|null} Stage ID or null
 */
export const getSelectedStageId = () => {
  const stage = getSelectedStage();
  return stage?.id || null;
};

/**
 * Add stage_id to API request params if a stage is selected
 * @param {Object} params - Existing request params
 * @returns {Object} Params with stage_id added if applicable
 */
export const addStageToParams = (params = {}) => {
  const stageId = getSelectedStageId();
  if (stageId) {
    return { ...params, stage_id: stageId };
  }
  return params;
};

/**
 * Add stage_id to API request body if a stage is selected
 * @param {Object} data - Request body data
 * @returns {Object} Data with stage_id added if applicable
 */
export const addStageToData = (data = {}) => {
  const stageId = getSelectedStageId();
  if (stageId) {
    return { ...data, stage_id: stageId };
  }
  return data;
};

/**
 * Check if a stage is currently selected
 * @returns {boolean} True if a stage is selected
 */
export const hasSelectedStage = () => {
  return getSelectedStageId() !== null;
};
