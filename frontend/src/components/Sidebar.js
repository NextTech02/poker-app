import { useState, useEffect, useMemo } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useAuth } from '../contexts/AuthContext';
import { useStage } from '../contexts/StageContext';
import { usePermissions } from '../contexts/PermissionContext';
import { useModule, MODULO_TORNEIO, MODULO_CASH, MODULO_BAR } from '../contexts/ModuleContext';
import { MENUS_POR_MODULO, MENU_COMUM } from './menus';
import OrgSwitcher from './OrgSwitcher';
import LanguageSelector from './LanguageSelector';
import TopBar from './TopBar';
import BackButton from './BackButton';
import Icon from './Icon';
import aceblindLogo from '../assets/aceblind-logo-white.png';
import aceblindMark from '../assets/aceblind-icon.png';
import './Sidebar.css';

/* A casca do app tem duas colunas fixas à esquerda:

   - o TRILHO (64px): a marca, um botão por módulo contratado (torneio, cash,
     bar — cada um com a sua tinta), e no rodapé a saída e as iniciais de
     quem está logado. É o que responde "em que módulo estou?" de qualquer
     tela, e troca de módulo num toque, sem perder o lugar;
   - o MENU (228px): os itens do módulo ativo, depois a seção do CLUBE
     (financeiro, jogadores, equipe, segurança), que é a mesma em todos.

   "Recolher" esconde só o menu; o trilho fica — é ele que segura a marca e a
   troca de módulo. A barra do topo (TopBar) é irmã destas colunas: fixa,
   ocupa a largura restante, e é renderizada daqui para que TODA tela ganhe o
   contexto (etapa / dia / turno) sem ter de lembrar de incluí-la. */

const ICONE_DO_MODULO = {
  [MODULO_TORNEIO]: 'trophy-cup',
  [MODULO_CASH]: 'chips',
  [MODULO_BAR]: 'cocktail',
};

const ROTULO_DO_MODULO = {
  [MODULO_TORNEIO]: ['modules.tournamentTitle', 'Torneios'],
  [MODULO_CASH]: ['modules.cashTitle', 'Cash Game'],
  [MODULO_BAR]: ['modules.barTitle', 'Bar'],
};

// Casa de cada módulo. O ModuleContext exporta o mesmo mapa; a cópia local é
// a rede de segurança para quem renderiza a barra com o contexto parcial.
const CASA_DO_MODULO = {
  [MODULO_TORNEIO]: '/home',
  [MODULO_CASH]: '/cash',
  [MODULO_BAR]: '/bar',
};

const iniciais = (user) => {
  const nome = user?.user_metadata?.full_name || user?.user_metadata?.name || '';
  const partes = nome.trim().split(/\s+/).filter(Boolean);
  if (partes.length >= 2) return (partes[0][0] + partes[partes.length - 1][0]).toUpperCase();
  if (partes.length === 1) return partes[0].slice(0, 2).toUpperCase();
  return (user?.email || '?').slice(0, 2).toUpperCase();
};

const Sidebar = () => {
  const location = useLocation();
  const navigate = useNavigate();
  const { t } = useTranslation();
  const { signOut, user } = useAuth();
  const { selectedStage } = useStage();
  const { hasPermission, isPlatformAdmin, organizationName } = usePermissions();
  const { module, homePath, modules, selectModule, casaDoModulo } = useModule();
  const [isOpen, setIsOpen] = useState(false);
  const [isMobile, setIsMobile] = useState(window.innerWidth <= 768);
  const [isCollapsed, setIsCollapsed] = useState(() => {
    return localStorage.getItem('sidebar-collapsed') === 'true';
  });
  const [openGroups, setOpenGroups] = useState(new Set(['caixa', 'torneios', 'cashGestao', 'barGestao']));

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

  // Acessibilidade: o fundo escuro do menu mobile fecha no clique, mas quem usa
  // só o teclado precisa do Esc.
  useEffect(() => {
    if (!isOpen || !isMobile) return undefined;
    const onKeyDown = (ev) => {
      if (ev.key === 'Escape') setIsOpen(false);
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [isOpen, isMobile]);

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

  const menuDoModulo = useMemo(
    () => MENUS_POR_MODULO[module] || MENUS_POR_MODULO[MODULO_TORNEIO],
    [module],
  );

  // Filter menu items based on permissions
  //
  // Memoizado porque a barra lateral re-renderiza a CADA troca de rota, e o
  // filtro percorre o menu inteiro chamando `hasPermission` por item e por
  // filho de grupo. `hasPermission` agora consulta um Set (ver
  // PermissionContext), mas o trabalho de remontar o array continuava.
  const filtrar = (itens) => itens.filter((item) => {
    // Itens exclusivos da plataforma ignoram o RBAC de organização.
    if (item.platformAdminOnly) return isPlatformAdmin;
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
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const itensDoModulo = useMemo(() => filtrar(menuDoModulo), [menuDoModulo, hasPermission, isPlatformAdmin]);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const itensDoClube = useMemo(() => filtrar(MENU_COMUM), [hasPermission, isPlatformAdmin]);

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
    for (const item of [...menuDoModulo, ...MENU_COMUM]) {
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

  // Trilho: um botão por módulo contratado. Com um módulo só, o botão fica lá
  // do mesmo jeito (ativo) — é a âncora visual de "onde estou".
  const modulosDoTrilho = modules && modules.length ? modules : [module];
  const trocarModulo = (proximo) => {
    if (!proximo || proximo === module) return;
    if (typeof selectModule === 'function') selectModule(proximo);
    const destino = typeof casaDoModulo === 'function' ? casaDoModulo(proximo) : CASA_DO_MODULO[proximo];
    navigate(destino || '/', { replace: true });
    if (isMobile) setIsOpen(false);
  };
  const [chaveModulo, reservaModulo] = ROTULO_DO_MODULO[module] || ROTULO_DO_MODULO[MODULO_TORNEIO];

  const renderItem = (item) => {
    if (item.type === 'group') {
      const open = isGroupOpen(item);
      const groupActive = item.children.some(c => isPathActive(c.path));
      return (
        <div className="nav-item-group" key={item.groupKey}>
          <button
            type="button"
            className={`nav-item ${groupActive ? 'active' : ''}`}
            onClick={() => toggleGroup(item.groupKey)}
            aria-expanded={open}
          >
            <span className={`nav-icon ${item.icon}`}><Icon name={item.icon} /></span>
            <span className="nav-label">{t(item.labelKey)}</span>
            <span className={`nav-arrow ${open ? 'expanded' : ''}`}><Icon name="chevron-right" /></span>
          </button>
          {open && (
            <div className="sub-menu">
              {item.children.map((child) => (
                <Link
                  key={child.path}
                  to={child.path}
                  className={`sub-menu-item ${isPathActive(child.path) ? 'active' : ''}`}
                  onClick={() => isMobile && setIsOpen(false)}
                >
                  <span className={`nav-icon ${child.icon}`}><i className="nav-dot" /></span>
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
        <span className={`nav-icon ${item.icon}`}><Icon name={item.icon} /></span>
        <span className="nav-label">{t(item.labelKey)}</span>
      </Link>
    );
  };

  return (
    <>
      {/* Mobile Header Bar */}
      {isMobile && (
        <header className="mobile-header">
          <button type="button"
            className={`hamburger-btn ${isOpen ? 'active' : ''}`}
            onClick={toggleSidebar}
            aria-label={t('sidebar.toggleMenu')}
          >
            <span className="hamburger-line"></span>
            <span className="hamburger-line"></span>
            <span className="hamburger-line"></span>
          </button>
          {/* "Voltar" também no celular (a barra do topo não existe aqui). */}
          <BackButton className="back-btn--mobile" />
          {/* A casa do MÓDULO ATIVO, não `/home` fixo. Apontado para o
              torneio, o logo era o caminho mais curto para cair no Dashboard
              de torneios estando no cash — que é como o problema apareceu. */}
          <Link to={homePath} className="mobile-logo-link" aria-label={t('sidebar.goHome', 'Ir para o início')} onClick={() => setIsOpen(false)}>
            <img src={aceblindLogo} alt="AceBlind" className="mobile-logo" />
          </Link>
          {selectedStage && (
            <div className="mobile-stage-badge">
              {selectedStage.name}
            </div>
          )}
        </header>
      )}

      {/* Overlay for mobile */}
      {isMobile && isOpen && (
        <div className="sidebar-overlay" role="presentation" onClick={() => setIsOpen(false)} />
      )}

      {/* Sidebar */}
      <aside className={`sidebar ${isMobile ? 'mobile' : ''} ${isOpen ? 'open' : ''} ${!isMobile && isCollapsed ? 'collapsed' : ''}`}>
        <div className="rail">
          <Link
            to={homePath}
            className="rail-mark"
            aria-label={t('sidebar.goHome', 'Ir para o início')}
            onClick={() => isMobile && setIsOpen(false)}
          >
            <img src={aceblindMark} alt="AceBlind" />
          </Link>

          <div className="rail-modules">
            {modulosDoTrilho.map((m) => {
              const [chave, reserva] = ROTULO_DO_MODULO[m] || [null, m];
              const rotulo = chave ? t(chave, reserva) : reserva;
              return (
                <button
                  key={m}
                  type="button"
                  className={`rail-btn mod-${m} ${m === module ? 'active' : ''}`}
                  onClick={() => trocarModulo(m)}
                  aria-pressed={m === module}
                  title={rotulo}
                >
                  <Icon name={ICONE_DO_MODULO[m] || 'grid'} />
                  <span className="rail-lbl">{rotulo}</span>
                </button>
              );
            })}
          </div>

          <div className="rail-spacer" />

          {/* Collapse toggle button (desktop only) */}
          {!isMobile && (
            <button type="button"
              className="sidebar-collapse-btn"
              onClick={toggleCollapse}
              title={isCollapsed ? t('sidebar.expand', 'Expandir') : t('sidebar.collapse', 'Recolher')}
              aria-label={isCollapsed ? t('sidebar.expand', 'Expandir') : t('sidebar.collapse', 'Recolher')}
            >
              <span className={`collapse-arrow ${isCollapsed ? 'rotated' : ''}`}><Icon name="chevron-left" /></span>
            </button>
          )}

          <button type="button" onClick={handleLogout} className="logout-btn" title={t('sidebar.logout')} aria-label={t('sidebar.logout')}>
            <Icon name="logout" />
          </button>
          <div className="rail-avatar" title={user?.email || ''}>{iniciais(user)}</div>
        </div>

        <div className="side-panel">
          <div className="sidebar-header">
            <div className={`side-mod mod-${module}`}>
              <i className="side-mod-dot" />
              <span>{t(chaveModulo, reservaModulo)}</span>
            </div>
            {organizationName && <div className="side-org">{organizationName}</div>}
            {selectedStage && !isCollapsed && (
              <div className="selected-stage-sidebar">
                {selectedStage.name}
              </div>
            )}
          </div>

          {/* Só aparece para quem pertence a mais de uma organização. */}
          <OrgSwitcher collapsed={false} />

          <nav className="sidebar-nav">
            {itensDoModulo.map(renderItem)}
            {itensDoClube.length > 0 && (
              <div className="side-sec">{t('sidebar.clubSection', 'Clube')}</div>
            )}
            {itensDoClube.map(renderItem)}
          </nav>

          <div className="sidebar-footer">
            <LanguageSelector dropDirection="up" />
          </div>
        </div>
      </aside>

      {!isMobile && <TopBar />}
    </>
  );
};

export default Sidebar;
