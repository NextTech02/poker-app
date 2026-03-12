import { useState, useEffect } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useAuth } from '../contexts/AuthContext';
import { useStage } from '../contexts/StageContext';
import LanguageSelector from './LanguageSelector';
import nextHubLogo from '../assets/next-hub-logo.png';
import './Sidebar.css';

const Sidebar = () => {
  const location = useLocation();
  const { t } = useTranslation();
  const { signOut } = useAuth();
  const { selectedStage } = useStage();
  const [isOpen, setIsOpen] = useState(false);
  const [isMobile, setIsMobile] = useState(window.innerWidth <= 768);
  const [isCollapsed, setIsCollapsed] = useState(() => {
    return localStorage.getItem('sidebar-collapsed') === 'true';
  });
  const [openGroups, setOpenGroups] = useState(new Set(['caixa']));

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

  const menuItems = [
    { path: '/home', labelKey: 'sidebar.periods', icon: 'clock' },
    { path: '/etapas', labelKey: 'sidebar.stages', icon: 'calendar' },
    {
      type: 'group',
      groupKey: 'caixa',
      labelKey: 'sidebar.cashRegister',
      icon: 'dollar',
      children: [
        { path: '/caixa', labelKey: 'sidebar.registerPlayers', icon: 'users' },
        { path: '/premiacao', labelKey: 'sidebar.registerPrize', icon: 'award' },
      ],
    },
    { path: '/torneios', labelKey: 'sidebar.tournaments', icon: 'trophy' },
    { path: '/sit-and-go', labelKey: 'sidebar.sitAndGo', icon: 'rocket' },
    { path: '/vagas', labelKey: 'sidebar.seats', icon: 'briefcase' },
    { path: '/rankings', labelKey: 'sidebar.rankings', icon: 'chart' },
    { path: '/financeiro', labelKey: 'sidebar.financial', icon: 'wallet' },
    { path: '/jogadores', labelKey: 'sidebar.players', icon: 'users' },
    { path: '/imprensa', labelKey: 'sidebar.press', icon: 'newspaper' },
    { path: '/templates', labelKey: 'sidebar.templates', icon: 'file-text' },
    { path: '/funcionarios', labelKey: 'sidebar.staff', icon: 'id-badge' },
    { path: '/relatorios', labelKey: 'sidebar.reports', icon: 'document' },
  ];

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

  const isPathActive = (path) => {
    // A6.3: home item (/home) também ativa quando estamos em /
    if (path === '/home' && location.pathname === '/') return true;
    return location.pathname === path || location.pathname.startsWith(path + '/');
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
          {menuItems.map((item, index) => {
            if (item.type === 'group') {
              const open = isGroupOpen(item);
              const groupActive = item.children.some(c => isPathActive(c.path));
              return (
                <div className="nav-item-group" key={index}>
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
                      {item.children.map((child, ci) => (
                        <Link
                          key={ci}
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
                key={index}
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
