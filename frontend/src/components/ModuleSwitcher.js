import React from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useModule, HOME_DO_MODULO, MODULO_TORNEIO, MODULO_CASH, MODULO_BAR } from '../contexts/ModuleContext';
import './OrgSwitcher.css';
import './ModuleSwitcher.css';

/**
 * Seletor de módulo (torneio × cash game × bar) no topo do menu lateral.
 *
 * Diferença deliberada para o `OrgSwitcher` ao lado: trocar de organização
 * exige `refreshSession()` + reload, porque o RLS decide pelo claim assinado e
 * o token velho continuaria devolvendo os dados do clube anterior. Módulo não
 * é claim — quem decide o que pode ser aberto é o servidor, pela organização.
 * Então aqui a troca é estado + cache + navegação: instantânea, sem recarregar
 * a página e sem novo login.
 *
 * Só aparece com 2+ módulos contratados.
 */
const ROTULOS = {
  [MODULO_TORNEIO]: ['modules.tournamentTitle', 'Torneios'],
  [MODULO_CASH]: ['modules.cashTitle', 'Cash Game'],
  [MODULO_BAR]: ['modules.barTitle', 'Bar'],
};

const ModuleSwitcher = ({ collapsed }) => {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { module, modules, hasMultipleModules, selectModule } = useModule();

  if (!hasMultipleModules) return null;

  const trocar = (proximo) => {
    if (!proximo || proximo === module) return;
    selectModule(proximo);
    // Sai da tela atual antes de a sidebar trocar de menu: a rota aberta
    // pertence ao módulo anterior e deixaria o usuário numa página que o menu
    // novo nem lista.
    navigate(HOME_DO_MODULO[proximo] || '/', { replace: true });
  };

  return (
    <div className={`org-switcher module-switcher ${collapsed ? 'collapsed' : ''}`}>
      {!collapsed && (
        <span className="org-switcher-label">{t('modules.current', 'Módulo')}</span>
      )}
      <select
        className="org-switcher-select"
        value={module}
        onChange={(e) => trocar(e.target.value)}
        aria-label={t('modules.current', 'Módulo')}
      >
        {modules.map((m) => {
          const [chave, reserva] = ROTULOS[m] || [null, m];
          return <option key={m} value={m}>{chave ? t(chave, reserva) : reserva}</option>;
        })}
      </select>
    </div>
  );
};

export default ModuleSwitcher;
