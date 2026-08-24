import React, { useState, useRef, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { IDIOMAS as languages, marcarEscolhaDoUsuario } from '../utils/idiomaDoUsuario';
import './LanguageSelector.css';

// Real flag images (emoji flags don't render on Windows).
const Flag = ({ cc }) => (
  <img
    className="language-flag-img"
    src={`https://flagcdn.com/h20/${cc}.png`}
    srcSet={`https://flagcdn.com/h40/${cc}.png 2x`}
    alt={cc.toUpperCase()}
    width="27"
    height="20"
    loading="lazy"
  />
);

const LanguageSelector = ({ dropDirection = 'down' }) => {
  const { i18n } = useTranslation();
  const [isOpen, setIsOpen] = useState(false);
  const dropdownRef = useRef(null);

  const currentLanguage = languages.find(lang => lang.code === i18n.language) || languages[0];

  const changeLanguage = (langCode) => {
    // Este é o ÚNICO lugar onde a escolha é da pessoa. A partir daqui ela passa
    // a valer mais que o idioma padrão do clube, inclusive nas próximas visitas.
    marcarEscolhaDoUsuario(langCode);
    i18n.changeLanguage(langCode);
    setIsOpen(false);
  };

  // Close dropdown when clicking outside
  useEffect(() => {
    const handleClickOutside = (event) => {
      if (dropdownRef.current && !dropdownRef.current.contains(event.target)) {
        setIsOpen(false);
      }
    };

    document.addEventListener('mousedown', handleClickOutside);
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
    };
  }, []);

  return (
    <div className="language-selector" ref={dropdownRef}>
      <button type="button"
        className="language-selector-btn"
        onClick={() => setIsOpen(!isOpen)}
        aria-expanded={isOpen}
        aria-haspopup="true"
      >
        <Flag cc={currentLanguage.cc} />
        <span className="language-code">{currentLanguage.code.split('-')[0].toUpperCase()}</span>
        <span className={`language-arrow ${isOpen ? 'open' : ''}`}>▼</span>
      </button>

      {isOpen && (
        <ul className={`language-dropdown ${dropDirection === 'up' ? 'language-dropdown--up' : ''}`}>
          {languages.map((lang) => (
            <li key={lang.code}>
              <button
                type="button"
                className={`language-option ${lang.code === i18n.language ? 'selected' : ''}`}
                onClick={() => changeLanguage(lang.code)}
                aria-current={lang.code === i18n.language}
              >
                <Flag cc={lang.cc} />
                <span className="language-name">{lang.name}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
};

export default LanguageSelector;
