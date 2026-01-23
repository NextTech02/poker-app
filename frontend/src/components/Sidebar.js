import { Link, useLocation } from 'react-router-dom';
import { useAuth } from '../contexts/AuthContext';
import { useStage } from '../contexts/StageContext';
import nextHubLogo from '../assets/next-hub-logo.png';
import './Sidebar.css';

const Sidebar = () => {
  const location = useLocation();
  const { signOut } = useAuth();
  const { selectedStage } = useStage();

  const menuItems = [
    { path: '/etapas', label: 'Etapas', icon: 'calendar' },
    { path: '/periodos', label: 'Períodos', icon: 'clock' },
    { path: '/caixa', label: 'Caixa', icon: 'dollar' },
    { path: '/torneios', label: 'Torneios', icon: 'trophy' },
    { path: '/sit-and-go', label: 'Sit & Go', icon: 'rocket' },
    { path: '/vagas', label: 'Vagas', icon: 'briefcase' },
    { path: '/rankings', label: 'Rankings', icon: 'chart' },
    { path: '/financeiro', label: 'Financeiro', icon: 'wallet' },
    { path: '/jogadores', label: 'Jogadores', icon: 'users' },
    { path: '/imprensa', label: 'Imprensa', icon: 'newspaper' },
    { path: '/templates', label: 'Templates', icon: 'file-text' },
    { path: '/funcionarios', label: 'Funcionários', icon: 'badge' },
    { path: '/relatorios', label: 'Relatórios', icon: 'document' },
  ];

  const handleLogout = async () => {
    await signOut();
  };

  const isPathActive = (path) => {
    return location.pathname === path || location.pathname.startsWith(path + '/');
  };

  return (
    <aside className="sidebar">
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
          >
            <span className="nav-icon">{item.icon}</span>
            <span className="nav-label">{item.label}</span>
          </Link>
        ))}
      </nav>

      <div className="sidebar-footer">
        <button onClick={handleLogout} className="logout-btn">
          <span className="nav-icon">logout</span>
          <span className="nav-label">Sair</span>
        </button>
      </div>
    </aside>
  );
};

export default Sidebar;
