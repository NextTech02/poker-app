import React, { createContext, useContext, useState, useCallback, useRef, useEffect } from 'react';
import '../components/Toast.css';
import { registerToast } from '../utils/toastEmitter';

const ToastContext = createContext(null);

let toastIdCounter = 0;

const ICONS = {
  success: (
    <svg viewBox="0 0 20 20" fill="currentColor" width="20" height="20">
      <path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.707-9.293a1 1 0 00-1.414-1.414L9 10.586 7.707 9.293a1 1 0 00-1.414 1.414l2 2a1 1 0 001.414 0l4-4z" clipRule="evenodd" />
    </svg>
  ),
  error: (
    <svg viewBox="0 0 20 20" fill="currentColor" width="20" height="20">
      <path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zM8.707 7.293a1 1 0 00-1.414 1.414L8.586 10l-1.293 1.293a1 1 0 101.414 1.414L10 11.414l1.293 1.293a1 1 0 001.414-1.414L11.414 10l1.293-1.293a1 1 0 00-1.414-1.414L10 8.586 8.707 7.293z" clipRule="evenodd" />
    </svg>
  ),
  warning: (
    <svg viewBox="0 0 20 20" fill="currentColor" width="20" height="20">
      <path fillRule="evenodd" d="M8.257 3.099c.765-1.36 2.722-1.36 3.486 0l5.58 9.92c.75 1.334-.213 2.98-1.742 2.98H4.42c-1.53 0-2.493-1.646-1.743-2.98l5.58-9.92zM11 13a1 1 0 11-2 0 1 1 0 012 0zm-1-8a1 1 0 00-1 1v3a1 1 0 002 0V6a1 1 0 00-1-1z" clipRule="evenodd" />
    </svg>
  ),
  info: (
    <svg viewBox="0 0 20 20" fill="currentColor" width="20" height="20">
      <path fillRule="evenodd" d="M18 10a8 8 0 11-16 0 8 8 0 0116 0zm-7-4a1 1 0 11-2 0 1 1 0 012 0zM9 9a1 1 0 000 2v3a1 1 0 001 1h1a1 1 0 100-2v-3a1 1 0 00-1-1H9z" clipRule="evenodd" />
    </svg>
  ),
};

export const ToastProvider = ({ children }) => {
  const [toasts, setToasts] = useState([]);
  const [confirmDialog, setConfirmDialog] = useState(null);
  const timersRef = useRef({});

  const removeToast = useCallback((id) => {
    // Mark as exiting for animation
    setToasts(prev => prev.map(t => t.id === id ? { ...t, exiting: true } : t));
    // Remove after animation
    setTimeout(() => {
      setToasts(prev => prev.filter(t => t.id !== id));
    }, 300);
    if (timersRef.current[id]) {
      clearTimeout(timersRef.current[id]);
      delete timersRef.current[id];
    }
  }, []);

  const addToast = useCallback((type, message, options = {}) => {
    const id = ++toastIdCounter;
    const duration = options.duration || (type === 'error' ? 6000 : 4000);

    setToasts(prev => [...prev, {
      id,
      type,
      title: options.title || null,
      message,
      duration,
      exiting: false,
    }]);

    timersRef.current[id] = setTimeout(() => {
      removeToast(id);
    }, duration);

    return id;
  }, [removeToast]);

  const toast = useCallback({
    success: (message, options) => addToast('success', message, options),
    error: (message, options) => addToast('error', message, options),
    warning: (message, options) => addToast('warning', message, options),
    info: (message, options) => addToast('info', message, options),
  }, [addToast]);

  // Fix: useCallback doesn't work with object literal
  const toastApi = {
    success: (message, options) => addToast('success', message, options),
    error: (message, options) => addToast('error', message, options),
    warning: (message, options) => addToast('warning', message, options),
    info: (message, options) => addToast('info', message, options),
  };

  const confirm = useCallback((message, options = {}) => {
    return new Promise((resolve) => {
      setConfirmDialog({
        title: options.title || 'Confirmar',
        message,
        confirmText: options.confirmText || 'Confirmar',
        cancelText: options.cancelText || 'Cancelar',
        variant: options.variant || 'default', // 'default' | 'danger'
        onConfirm: () => {
          setConfirmDialog(null);
          resolve(true);
        },
        onCancel: () => {
          setConfirmDialog(null);
          resolve(false);
        },
      });
    });
  }, []);

  // Register toast emitter so api.js interceptor can use it outside React
  useEffect(() => {
    registerToast(toastApi);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <ToastContext.Provider value={{ toast: toastApi, confirm }}>
      {children}

      {/* Toast container */}
      {toasts.length > 0 && (
        <div className="toast-container">
          {toasts.map((t) => (
            <div
              key={t.id}
              className={`toast toast-${t.type}${t.exiting ? ' toast-exiting' : ''}`}
              style={{ position: 'relative', overflow: 'hidden' }}
            >
              <div className="toast-icon">{ICONS[t.type]}</div>
              <div className="toast-body">
                {t.title && <div className="toast-title">{t.title}</div>}
                <div className="toast-message">{t.message}</div>
              </div>
              <button className="toast-close" onClick={() => removeToast(t.id)}>
                &times;
              </button>
              <div
                className="toast-progress"
                style={{ animationDuration: `${t.duration}ms` }}
              />
            </div>
          ))}
        </div>
      )}

      {/* Confirm dialog */}
      {confirmDialog && (
        <div className="confirm-overlay" onClick={confirmDialog.onCancel}>
          <div className="confirm-dialog" onClick={(e) => e.stopPropagation()}>
            <div className="confirm-dialog-title">{confirmDialog.title}</div>
            <div className="confirm-dialog-message">{confirmDialog.message}</div>
            <div className="confirm-dialog-actions">
              <button
                className="confirm-btn confirm-btn-cancel"
                onClick={confirmDialog.onCancel}
              >
                {confirmDialog.cancelText}
              </button>
              <button
                className={`confirm-btn ${confirmDialog.variant === 'danger' ? 'confirm-btn-danger' : 'confirm-btn-confirm'}`}
                onClick={confirmDialog.onConfirm}
              >
                {confirmDialog.confirmText}
              </button>
            </div>
          </div>
        </div>
      )}
    </ToastContext.Provider>
  );
};

export const useToast = () => {
  const context = useContext(ToastContext);
  if (!context) {
    throw new Error('useToast must be used within a ToastProvider');
  }
  return context;
};
