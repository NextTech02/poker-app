import { useMemo } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useModule, MODULO_TORNEIO, MODULO_CASH, MODULO_BAR } from '../contexts/ModuleContext';
import { useStage } from '../contexts/StageContext';
import { useCashDay } from '../contexts/CashDayContext';
import { useBarShift } from '../contexts/BarShiftContext';
import { useConnectivity } from '../contexts/ConnectivityContext';
import { MENUS_POR_MODULO, MENU_COMUM } from './menus';
import Icon from './Icon';
import './TopBar.css';

/* Barra fixa no topo de toda tela (desktop). Responde duas perguntas sem que a
   pessoa precise procurar: ONDE estou (módulo › tela, lido do mesmo menu que
   a barra lateral desenha) e EM QUE CONTEXTO estou operando — a etapa
   selecionada no torneio, o dia de operação no cash, o turno no bar. Cada
   chip leva para a tela onde esse contexto se escolhe ou se abre.

   No celular não aparece: o cabeçalho móvel já mostra a etapa e o menu. */

const ROTULO_DO_MODULO = {
  [MODULO_TORNEIO]: ['modules.tournamentTitle', 'Torneios'],
  [MODULO_CASH]: ['modules.cashTitle', 'Cash Game'],
  [MODULO_BAR]: ['modules.barTitle', 'Bar'],
};

// "2026-09-17" -> "17/09". A data de negócio é a da NOITE, sem fuso: por isso
// não passa por `new Date` (que a empurraria para o dia anterior em UTC-3).
const diaMes = (iso) => (typeof iso === 'string' && iso.length >= 10 ? `${iso.slice(8, 10)}/${iso.slice(5, 7)}` : '');

/** Item de menu que corresponde ao caminho atual: [grupo?, item]. */
export function localizarNoMenu(pathname, module) {
  const itens = [...(MENUS_POR_MODULO[module] || MENUS_POR_MODULO[MODULO_TORNEIO]), ...MENU_COMUM];
  let melhor = null;
  const considerar = (item, grupo) => {
    const p = item.path;
    const bate = pathname === p || (p === '/home' && pathname === '/') || pathname.startsWith(p + '/');
    if (!bate) return;
    if (!melhor || p.length > melhor.item.path.length) melhor = { item, grupo };
  };
  for (const item of itens) {
    if (item.type === 'group') item.children.forEach((c) => considerar(c, item));
    else considerar(item, null);
  }
  return melhor;
}

const TopBar = () => {
  const { t } = useTranslation();
  const location = useLocation();
  const { module } = useModule();
  const { selectedStage } = useStage();
  const { day } = useCashDay();
  const { shift } = useBarShift();
  const { isOnline, pendingCount } = useConnectivity();

  const moduloAtual = module || MODULO_TORNEIO;
  const [chaveModulo, reservaModulo] = ROTULO_DO_MODULO[moduloAtual] || ROTULO_DO_MODULO[MODULO_TORNEIO];
  const alvo = useMemo(() => localizarNoMenu(location.pathname, moduloAtual), [location.pathname, moduloAtual]);

  const migalhas = [t(chaveModulo, reservaModulo)];
  if (alvo?.grupo) migalhas.push(t(alvo.grupo.labelKey));
  if (alvo?.item) migalhas.push(t(alvo.item.labelKey));

  let contexto = null;
  if (moduloAtual === MODULO_TORNEIO) {
    contexto = selectedStage
      ? { to: '/etapas', icon: 'calendar', label: t('topbar.stage', 'Etapa'), value: selectedStage.name, tone: 'mod' }
      : { to: '/etapas', icon: 'calendar', label: t('topbar.stage', 'Etapa'), value: t('topbar.noStage', 'Selecione uma etapa'), tone: 'warn' };
  } else if (moduloAtual === MODULO_CASH) {
    contexto = day
      ? { to: '/cash/dias', icon: 'calendar', label: t('topbar.day', 'Dia'), value: `${diaMes(day.business_date)} · ${day.status === 'open' ? t('topbar.open', 'aberto') : t('topbar.closed', 'encerrado')}`, tone: day.status === 'open' ? 'ok' : 'neutral' }
      : { to: '/cash', icon: 'calendar', label: t('topbar.day', 'Dia'), value: t('topbar.noDay', 'Nenhum dia aberto'), tone: 'warn' };
  } else if (moduloAtual === MODULO_BAR) {
    contexto = shift
      ? { to: '/bar/turnos', icon: 'clock', label: t('topbar.shift', 'Turno'), value: `${diaMes(shift.business_date)} · ${shift.status === 'open' ? t('topbar.open', 'aberto') : t('topbar.closed', 'fechado')}`, tone: shift.status === 'open' ? 'ok' : 'neutral' }
      : { to: '/bar/turnos', icon: 'clock', label: t('topbar.shift', 'Turno'), value: t('topbar.noShift', 'Nenhum turno aberto'), tone: 'warn' };
  }

  return (
    <div className="topbar" data-testid="topbar">
      <nav className="topbar-crumbs" aria-label={t('topbar.breadcrumb', 'Você está em')}>
        {migalhas.map((m, i) => (
          <span key={`${i}-${m}`} className="topbar-crumb">
            {i > 0 && <Icon name="chevron-right" className="topbar-sep" />}
            <span className={i === migalhas.length - 1 ? 'topbar-crumb-current' : ''}>{m}</span>
          </span>
        ))}
      </nav>
      <div className="topbar-ctx">
        {!isOnline && (
          <span className="topbar-chip tone-danger">
            <span className="topbar-dot" />
            <span>{t('topbar.offline', 'Offline')}</span>
            {pendingCount > 0 && <b>{t('topbar.pending', '{{count}} na fila', { count: pendingCount })}</b>}
          </span>
        )}
        {contexto && (
          <Link to={contexto.to} className={`topbar-chip tone-${contexto.tone}`}>
            <Icon name={contexto.icon} />
            <span>{contexto.label}</span>
            <b>{contexto.value}</b>
          </Link>
        )}
      </div>
    </div>
  );
};

export default TopBar;
