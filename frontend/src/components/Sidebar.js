import React from 'react';
import { Link, useLocation } from 'react-router-dom';
import { useAuth } from '../contexts/AuthContext';
import nextHubLogo from '../assets/next-hub-logo.png';
import './Sidebar.css';

const Sidebar = () => {
  const location = useLocation();
  const { signOut } = useAuth();

  const menuItems = [
    { path: '/', label: 'Dashboard', icon: 'dashboard' },
    { path: '/etapas', label: 'Etapas', icon: 'layers' },
    { path: '/jogadores', label: 'Jogadores', icon: 'users' },
    { path: '/caixa', label: 'Caixa', icon: 'dollar' },
    { path: '/caixa-geral', label: 'Caixa Geral & Rake', icon: 'wallet' },
    { path: '/relatorios', label: 'Relatórios', icon: 'chart' },
  ];

  const handleLogout = async () => {
    await signOut();
  };

  return (
    <aside className="sidebar">
      <div className="sidebar-header">
        <img src={nextHubLogo} alt="Next Hub" className="sidebar-logo" />
      </div>

      <nav className="sidebar-nav">
        {menuItems.map((item) => (
          <Link
            key={item.path}
            to={item.path}
            className={`nav-item ${location.pathname === item.path ? 'active' : ''}`}
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
