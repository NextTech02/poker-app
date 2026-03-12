// Singleton toast emitter for use outside React components (e.g., axios interceptor)
let _toast = null;

export const registerToast = (toastApi) => {
  _toast = toastApi;
};

export const emitToastError = (message) => {
  _toast?.error(message);
};

export const emitToastSuccess = (message) => {
  _toast?.success(message);
};
