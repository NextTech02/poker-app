import { useState, useEffect } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useAuth } from '../contexts/AuthContext';
import { useStage } from '../contexts/StageContext';
import { usePermissions } from '../contexts/PermissionContext';
import LanguageSelector from './LanguageSelector';
import nextHubLogo from '../assets/next-hub-logo.png';
import './Sidebar.css';

const Sidebar = () => {
  const location = useLocation();
  const { t } = useTranslation();
  const { signOut } = useAuth();
  const { selectedStage } = useStage();
  const { hasPermission } = usePermissions();
  const [isOpen, setIsOpen] = useState(false);
  const [isMobile, setIsMobile] = useState(window.innerWidth <= 768);
  const [isCollapsed, setIsCollapsed] = useState(() => {
    return localStorage.getItem('sidebar-collapsed') === 'true';
  });
  const [openGroups, setOpenGroups] = useState(new Set(['caixa', 'torneios']));

  // Handle window resize
  useEffect(() => {
    const handleResize = () => {
      const mobile = window.innerWidth <= 768;
      setIsMobile(mobile);
      if (!mobile) {
        setIsOpen(false); // Reset when switching to desktop
      }
    };

    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, []);

  // Close sidebar when route changes on mobile
  useEffect(() => {
    if (isMobile) {
      setIsOpen(false);
    }
  }, [location.pathname, isMobile]);

  // Sync collapsed state to document for main-content margin
  useEffect(() => {
    if (!isMobile) {
      document.documentElement.setAttribute('data-sidebar-collapsed', isCollapsed);
    } else {
      document.documentElement.removeAttribute('data-sidebar-collapsed');
    }
  }, [isCollapsed, isMobile]);

  // Prevent body scroll when mobile menu is open
  useEffect(() => {
    if (isOpen && isMobile) {
      document.body.style.overflow = 'hidden';
    } else {
      document.body.style.overflow = '';
    }
    return () => {
      document.body.style.overflow = '';
    };
  }, [isOpen, isMobile]);

  const allMenuItems = [
    { path: '/home', labelKey: 'sidebar.periods', icon: 'clock', permission: 'dashboard' },
    { path: '/etapas', labelKey: 'sidebar.stages', icon: 'calendar', permission: 'stages' },
    {
      type: 'group',
      groupKey: 'caixa',
      labelKey: 'sidebar.cashRegister',
      icon: 'dollar',
      permission: 'cashier',
      children: [
        { path: '/caixa', labelKey: 'sidebar.sales', icon: 'dollar', permission: 'cashier' },
        { path: '/caixa/jogadores', labelKey: 'sidebar.playerLimit', icon: 'users', permission: 'cashier_players' },
        { path: '/caixa/tickets', labelKey: 'sidebar.tournamentTickets', icon: 'ticket', permission: 'cashier_tickets' },
        { path: '/sangi', labelKey: 'sidebar.sangi', icon: 'briefcase', permission: 'cashier' },
      ],
    },
    // Restricted entry for the pure sangi role: their only screen. Hidden for
    // anyone who already sees Sangi nested under the Caixa group (has `cashier`),
    // so admins/cashiers don't get a duplicate top-level item.
    { path: '/sangi', labelKey: 'sidebar.sangi', icon: 'briefcase', permission: 'sangi', hideIfPermission: 'cashier' },
    {
      type: 'group',
      groupKey: 'torneios',
      labelKey: 'sidebar.tournaments',
      icon: 'trophy',
      permission: 'tournaments',
      children: [
        { path: '/torneios', labelKey: 'sidebar.tournamentsList', icon: 'trophy', permission: 'tournaments' },
        { path: '/premiacao', labelKey: 'sidebar.registerPrize', icon: 'award', permission: 'prizes' },
      ],
    },
    { path: '/financeiro', labelKey: 'sidebar.financial', icon: 'wallet', permission: 'financial' },
    { path: '/jogadores', labelKey: 'sidebar.registerPlayer', icon: 'users', permission: 'players' },
    { path: '/funcionarios', labelKey: 'sidebar.staff', icon: 'id-badge', permission: 'employees' },
    { path: '/relatorios', labelKey: 'sidebar.reports', icon: 'document', permission: 'reports' },
  ];

  // Filter menu items based on permissions
  const menuItems = allMenuItems.filter((item) => {
    if (item.type === 'group') {
      // Show group if user has permission for at least one child
      const visibleChildren = item.children.filter((c) => hasPermission(c.permission));
      return visibleChildren.length > 0;
    }
    // Suppress an item that would otherwise duplicate one already reachable
    // through a group (e.g. the standalone Sangi entry for cashier/admin users).
    if (item.hideIfPermission && hasPermission(item.hideIfPermission)) return false;
    return hasPermission(item.permission);
  }).map((item) => {
    if (item.type === 'group') {
      return {
        ...item,
        children: item.children.filter((c) => hasPermission(c.permission)),
      };
    }
    return item;
  });

  const toggleGroup = (groupKey) => {
    setOpenGroups(prev => {
      const next = new Set(prev);
      if (next.has(groupKey)) next.delete(groupKey);
      else next.add(groupKey);
      return next;
    });
  };

  const isGroupOpen = (item) => {
    // Auto-open if any child path is active
    const childActive = item.children.some(c => isPathActive(c.path));
    return openGroups.has(item.groupKey) || childActive;
  };

  const handleLogout = async () => {
    await signOut();
  };

  // Collect every menu path so we can detect when one path is a prefix of
  // another (e.g. "/caixa" vs "/caixa/jogadores"). The shorter, less-specific
  // path must NOT match when the user is actually inside the longer one.
  const allMenuPaths = (() => {
    const paths = [];
    for (const item of allMenuItems) {
      if (item.type === 'group') {
        for (const c of item.children) paths.push(c.path);
      } else {
        paths.push(item.path);
      }
    }
    return paths;
  })();

  const isPathActive = (path) => {
    // A6.3: home item (/home) também ativa quando estamos em /
    if (path === '/home' && location.pathname === '/') return true;
    if (location.pathname === path) return true;
    // Only treat the current location as a sub-route of `path` when no other
    // menu item is a more specific prefix match. Without this check, "/caixa"
    // would light up while we're on "/caixa/jogadores" or "/caixa/tickets".
    if (location.pathname.startsWith(path + '/')) {
      const moreSpecific = allMenuPaths.some(
        (p) => p !== path && p.startsWith(path + '/') &&
               (location.pathname === p || location.pathname.startsWith(p + '/'))
      );
      return !moreSpecific;
    }
    return false;
  };

  const toggleSidebar = () => {
    setIsOpen(!isOpen);
  };

  const toggleCollapse = () => {
    const next = !isCollapsed;
    setIsCollapsed(next);
    localStorage.setItem('sidebar-collapsed', String(next));
  };

  return (
    <>
      {/* Mobile Header Bar */}
      {isMobile && (
        <header className="mobile-header">
          <button
            className={`hamburger-btn ${isOpen ? 'active' : ''}`}
            onClick={toggleSidebar}
            aria-label="Toggle menu"
          >
            <span className="hamburger-line"></span>
            <span className="hamburger-line"></span>
            <span className="hamburger-line"></span>
          </button>
          <img src={nextHubLogo} alt="Next Hub" className="mobile-logo" />
          {selectedStage && (
            <div className="mobile-stage-badge">
              {selectedStage.name}
            </div>
          )}
        </header>
      )}

      {/* Overlay for mobile */}
      {isMobile && isOpen && (
        <div className="sidebar-overlay" onClick={() => setIsOpen(false)} />
      )}

      {/* Sidebar */}
      <aside className={`sidebar ${isMobile ? 'mobile' : ''} ${isOpen ? 'open' : ''} ${!isMobile && isCollapsed ? 'collapsed' : ''}`}>
        <div className="sidebar-header">
          <img src={nextHubLogo} alt="Next Hub" className="sidebar-logo" />
          {selectedStage && !isCollapsed && (
            <div className="selected-stage-sidebar">
              {selectedStage.name}
            </div>
          )}
        </div>

        {/* Collapse toggle button (desktop only) */}
        {!isMobile && (
          <button
            className="sidebar-collapse-btn"
            onClick={toggleCollapse}
            title={isCollapsed ? t('sidebar.expand', 'Expandir') : t('sidebar.collapse', 'Recolher')}
          >
            <span className={`collapse-arrow ${isCollapsed ? 'rotated' : ''}`}>«</span>
          </button>
        )}

        <nav className="sidebar-nav">
          {menuItems.map((item) => {
            if (item.type === 'group') {
              const open = isGroupOpen(item);
              const groupActive = item.children.some(c => isPathActive(c.path));
              return (
                <div className="nav-item-group" key={item.groupKey}>
                  <div
                    className={`nav-item ${groupActive ? 'active' : ''}`}
                    onClick={() => toggleGroup(item.groupKey)}
                    style={{ cursor: 'pointer' }}
                  >
                    <span className={`nav-icon ${item.icon}`}></span>
                    <span className="nav-label">{t(item.labelKey)}</span>
                    <span className={`nav-arrow ${open ? 'expanded' : ''}`}>▼</span>
                  </div>
                  {open && (
                    <div className="sub-menu">
                      {item.children.map((child) => (
                        <Link
                          key={child.path}
                          to={child.path}
                          className={`sub-menu-item ${isPathActive(child.path) ? 'active' : ''}`}
                          onClick={() => isMobile && setIsOpen(false)}
                        >
                          <span className={`nav-icon ${child.icon}`}></span>
                          <span className="nav-label">{t(child.labelKey)}</span>
                        </Link>
                      ))}
                    </div>
                  )}
                </div>
              );
            }
            return (
              <Link
                key={item.path}
                to={item.path}
                className={`nav-item ${isPathActive(item.path) ? 'active' : ''}`}
                onClick={() => isMobile && setIsOpen(false)}
              >
                <span className={`nav-icon ${item.icon}`}></span>
                <span className="nav-label">{t(item.labelKey)}</span>
              </Link>
            );
          })}
        </nav>

        <div className="sidebar-footer">
          <LanguageSelector dropDirection="up" />
          <button onClick={handleLogout} className="logout-btn">
            <span className="nav-icon">logout</span>
            <span className="nav-label">{t('sidebar.logout')}</span>
          </button>
        </div>
      </aside>
    </>
  );
};

export default Sidebar;
