import React, { useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { enviarImagemDoBilhete, publicUrlFor, TIPOS_DE_IMAGEM } from '../../hooks/useBrandingDoBilhete';
import './Bilhete.css';

/**
 * Campo da imagem do topo do bilhete: mostra a atual, sobe outra, remove.
 * Controlado — guarda só o CAMINHO no bucket (`valor`/`onChange`).
 */
const ImagemDoBilheteCampo = ({ valor, onChange, disabled = false, id = 'bilhete-imagem', vazio }) => {
  const { t } = useTranslation();
  const entrada = useRef(null);
  const [enviando, setEnviando] = useState(false);
  const [erro, setErro] = useState('');

  const escolher = async (e) => {
    const arquivo = e.target.files?.[0];
    e.target.value = '';
    if (!arquivo) return;
    setErro('');
    setEnviando(true);
    try {
      onChange(await enviarImagemDoBilhete(arquivo));
    } catch (err) {
      setErro(t(`ticket.${err.code || 'logoUploadError'}`, 'Não foi possível enviar a imagem.'));
    } finally {
      setEnviando(false);
    }
  };

  return (
    <div className="bt-campo-imagem">
      <div className="bt-campo-miniatura">
        {valor
          ? <img src={publicUrlFor(valor)} alt={t('ticket.logoAlt', 'Imagem do bilhete')} />
          : <span>{vazio || t('ticket.noLogo', 'Sem imagem')}</span>}
      </div>
      <div className="bt-campo-acoes">
        <input
          ref={entrada}
          id={id}
          type="file"
          accept={TIPOS_DE_IMAGEM.join(',')}
          onChange={escolher}
          disabled={disabled || enviando}
          hidden
        />
        <button type="button" className="bt-botao" onClick={() => entrada.current?.click()} disabled={disabled || enviando}>
          {enviando ? t('ticket.uploading', 'Enviando…') : t('ticket.uploadLogo', 'Enviar imagem')}
        </button>
        {valor && (
          <button type="button" className="bt-botao bt-botao--secundario" onClick={() => onChange('')} disabled={disabled || enviando}>
            {t('ticket.removeLogo', 'Remover')}
          </button>
        )}
      </div>
      {erro && <div className="bt-erro" role="alert">{erro}</div>}
    </div>
  );
};

export default ImagemDoBilheteCampo;
