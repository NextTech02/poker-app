import { useLocation, useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useModule, MODULO_TORNEIO, MODULO_CASH, MODULO_BAR } from '../contexts/ModuleContext';
import Icon from './Icon';
import './BackButton.css';

/* "Voltar" em TODA tela, num lugar só: a barra do topo (desktop) e o
   cabeçalho móvel. Pedido do cliente (2026-10): o diretor abria o controle
   do torneio e não tinha como voltar sem a seta do navegador; dezenas de
   telas estavam na mesma situação.

   Com histórico dentro do app (React Router guarda `idx` em
   history.state), volta UMA tela, como a seta do navegador. Sem histórico —
   link aberto direto, guia nova — vai para a casa do módulo. Na casa, sem
   histórico, não há para onde voltar: o botão some. */

const CASA_DO_MODULO = {
  [MODULO_TORNEIO]: '/home',
  [MODULO_CASH]: '/cash',
  [MODULO_BAR]: '/bar',
};

export const temHistoricoNoApp = () => {
  try {
    const idx = Number(window.history?.state?.idx);
    return Number.isFinite(idx) && idx > 0;
  } catch (e) {
    return false;
  }
};

const BackButton = ({ className = '' }) => {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const { module } = useModule();

  const casa = CASA_DO_MODULO[module] || CASA_DO_MODULO[MODULO_TORNEIO];
  const comHistorico = temHistoricoNoApp();
  const naCasa = pathname === casa || pathname === '/';
  if (!comHistorico && naCasa) return null;

  const voltar = () => {
    if (comHistorico) navigate(-1);
    else navigate(casa);
  };

  const rotulo = t('common.back', 'Voltar');
  return (
    <button
      type="button"
      className={`back-btn ${className}`.trim()}
      onClick={voltar}
      aria-label={rotulo}
      title={rotulo}
      data-testid="back-btn"
    >
      <Icon name="chevron-left" />
      <span className="back-btn-label">{rotulo}</span>
    </button>
  );
};

export default BackButton;
