import React, { useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useModule, HOME_DO_MODULO, MODULO_TORNEIO, MODULO_CASH, MODULO_BAR } from '../contexts/ModuleContext';
import LanguageSelector from '../components/LanguageSelector';
import aceblindLogo from '../assets/aceblind-logo-white.png';
import './Login.css';
import './SelectOrg.css';
import './SelectModule.css';
import Icon from '../components/Icon';

/**
 * Escolha do módulo logo após o login, para o clube que contratou mais de um.
 *
 * Quem contratou UM só nunca vê esta tela: o efeito abaixo entra direto na
 * operação. Isso é deliberado — todo clube que já usa o sistema tem só o
 * módulo de torneio, e nenhum deles pode ganhar um passo a mais no login por
 * causa de uma funcionalidade que não comprou.
 */
const MODULOS = [
  {
    key: MODULO_TORNEIO,
    icon: 'trophy-cup',
    titleKey: 'modules.tournamentTitle',
    titleFallback: 'Torneios',
    hintKey: 'modules.tournamentHint',
    hintFallback: 'Etapas, blinds, premiação, ranking e caixa do torneio.',
  },
  {
    key: MODULO_CASH,
    icon: 'chips',
    titleKey: 'modules.cashTitle',
    titleFallback: 'Cash Game',
    hintKey: 'modules.cashHint',
    hintFallback: 'Mesas abertas, fila de espera, buy-in e cash-out, faturamento por dia.',
  },
  {
    key: MODULO_BAR,
    icon: 'cocktail',
    titleKey: 'modules.barTitle',
    titleFallback: 'Bar',
    hintKey: 'modules.barHint',
    hintFallback: 'Produtos, comandas por jogador, pedidos, estoque e caixa do bar.',
  },
];

const SelectModule = () => {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { modules, module, selectModule, hasMultipleModules, loading, casaDoModulo } = useModule();

  useEffect(() => {
    if (loading || hasMultipleModules) return;
    navigate((casaDoModulo ? casaDoModulo(module) : HOME_DO_MODULO[module]) || '/', { replace: true });
  }, [loading, hasMultipleModules, module, navigate, casaDoModulo]);

  const entrar = (key) => {
    selectModule(key);
    navigate((casaDoModulo ? casaDoModulo(key) : HOME_DO_MODULO[key]) || '/', { replace: true });
  };

  const disponiveis = MODULOS.filter((m) => modules.includes(m.key));

  return (
    <div className="login-container login-centered">
      <div className="login-language-selector">
        <LanguageSelector />
      </div>

      <div className="login-card so-card sm-wide">
        <div className="login-header">
          <img src={aceblindLogo} alt="AceBlind" className="login-logo" />
        </div>

        <h2 className="so-title">{t('modules.selectTitle', 'Escolha o módulo')}</h2>
        <p className="so-hint">
          {t('modules.selectSubtitle', 'Seu clube opera mais de um módulo. Selecione onde quer trabalhar agora — dá para trocar a qualquer momento pelo menu.')}
        </p>

        {loading ? (
          <p className="so-loading">{t('common.loading', 'Carregando...')}</p>
        ) : (
          <ul className="so-list sm-grid">
            {disponiveis.map((m) => (
              <li key={m.key}>
                <button
                  type="button"
                  className={`sm-card mod-${m.key}`}
                  onClick={() => entrar(m.key)}
                >
                  <span className="sm-ico" aria-hidden="true"><Icon name={m.icon} /></span>
                  <span className="so-name">{t(m.titleKey, m.titleFallback)}</span>
                  <span className="so-meta">{t(m.hintKey, m.hintFallback)}</span>
                  <span className="sm-enter">{t('modules.enter', 'Entrar')} <Icon name="chevron-right" /></span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
};

export default SelectModule;
