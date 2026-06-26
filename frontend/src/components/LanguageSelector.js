import React, { useState, useRef, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import './LanguageSelector.css';

const languages = [
  { code: 'pt-BR', name: 'Português', cc: 'br' },
  { code: 'en-US', name: 'English', cc: 'us' },
  { code: 'es-ES', name: 'Español', cc: 'es' }
];

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
      <button
        className="language-selector-btn"
        onClick={() => setIsOpen(!isOpen)}
        aria-expanded={isOpen}
        aria-haspopup="listbox"
      >
        <Flag cc={currentLanguage.cc} />
        <span className="language-code">{currentLanguage.code.split('-')[0].toUpperCase()}</span>
        <span className={`language-arrow ${isOpen ? 'open' : ''}`}>▼</span>
      </button>

      {isOpen && (
        <ul className={`language-dropdown ${dropDirection === 'up' ? 'language-dropdown--up' : ''}`} role="listbox">
          {languages.map((lang) => (
            <li
              key={lang.code}
              className={`language-option ${lang.code === i18n.language ? 'selected' : ''}`}
              onClick={() => changeLanguage(lang.code)}
              role="option"
              aria-selected={lang.code === i18n.language}
            >
              <Flag cc={lang.cc} />
              <span className="language-name">{lang.name}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
};

export default LanguageSelector;
