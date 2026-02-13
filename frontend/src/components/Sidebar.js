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
    { path: '/caixa', labelKey: 'sidebar.cashRegister', icon: 'dollar' },
    { path: '/torneios', labelKey: 'sidebar.tournaments', icon: 'trophy' },
    { path: '/sit-and-go', labelKey: 'sidebar.sitAndGo', icon: 'rocket' },
    { path: '/vagas', labelKey: 'sidebar.seats', icon: 'briefcase' },
    { path: '/rankings', labelKey: 'sidebar.rankings', icon: 'chart' },
    { path: '/financeiro', labelKey: 'sidebar.financial', icon: 'wallet' },
    { path: '/jogadores', labelKey: 'sidebar.players', icon: 'users' },
    { path: '/imprensa', labelKey: 'sidebar.press', icon: 'newspaper' },
    { path: '/templates', labelKey: 'sidebar.templates', icon: 'file-text' },
    { path: '/funcionarios', labelKey: 'sidebar.staff', icon: 'badge' },
    { path: '/relatorios', labelKey: 'sidebar.reports', icon: 'document' },
  ];

  const handleLogout = async () => {
    await signOut();
  };

  const isPathActive = (path) => {
    return location.pathname === path || location.pathname.startsWith(path + '/');
  };

  const toggleSidebar = () => {
    setIsOpen(!isOpen);
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
      <aside className={`sidebar ${isMobile ? 'mobile' : ''} ${isOpen ? 'open' : ''}`}>
        <div className="sidebar-header">
          <img src={nextHubLogo} alt="Next Hub" className="sidebar-logo" />
          {selectedStage && (
            <div className="selected-stage-sidebar">
              {selectedStage.name}
            </div>
          )}
        </div>

        <nav className="sidebar-nav">
          {menuItems.map((item, index) => (
            <Link
              key={index}
              to={item.path}
              className={`nav-item ${isPathActive(item.path) ? 'active' : ''}`}
              onClick={() => isMobile && setIsOpen(false)}
            >
              <span className="nav-icon">{item.icon}</span>
              <span className="nav-label">{t(item.labelKey)}</span>
            </Link>
          ))}
        </nav>

        <div className="sidebar-footer">
          <LanguageSelector />
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
