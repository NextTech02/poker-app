import React, { createContext, useContext, useEffect, useState } from 'react';
import { useAuth } from './AuthContext';
import api from '../config/api';

const PermissionContext = createContext({
  permissions: [],
  isAdmin: false,
  loading: true,
  hasPermission: () => true,
});

export const usePermissions = () => useContext(PermissionContext);

export const PermissionProvider = ({ children }) => {
  const { user } = useAuth();
  const [permissions, setPermissions] = useState([]);
  const [isAdmin, setIsAdmin] = useState(true);
  const [groupName, setGroupName] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!user) {
      setPermissions([]);
      setIsAdmin(true);
      setLoading(false);
      return;
    }

    const loadPermissions = async (retryCount = 0) => {
      try {
        const res = await api.get('/staff/me/permissions', { _silentError: true });
        setPermissions(res.data.permissions || []);
        setIsAdmin(res.data.is_admin);
        setGroupName(res.data.group_name);
      } catch (err) {
        // Retry once after 3s on server errors (503, 500)
        const status = err?.response?.status;
        if (retryCount === 0 && (!status || status >= 500)) {
          setTimeout(() => loadPermissions(1), 3000);
          return; // Don't set loading=false yet, wait for retry
        }
        // If endpoint fails (e.g. table doesn't exist yet), treat as admin
        setPermissions([]);
        setIsAdmin(true);
      } finally {
        setLoading(false);
      }
    };

    loadPermissions();
  }, [user]);

  const hasPermission = (permission) => {
    if (isAdmin) return true;
    if (!permission) return true;
    return permissions.includes(permission);
  };

  return (
    <PermissionContext.Provider value={{ permissions, isAdmin, groupName, loading, hasPermission }}>
      {children}
    </PermissionContext.Provider>
  );
};
