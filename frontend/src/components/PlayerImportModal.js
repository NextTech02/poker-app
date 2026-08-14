import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import api from '../config/api';
import { useToast } from '../contexts/ToastContext';
import './PlayerImportModal.css';

/**
 * Importação da base de jogadores vinda de outro sistema (Poker Web).
 *
 * O concorrente não expõe API — o clube exporta a planilha e traz o arquivo.
 * O que o "xls" do Poker Web realmente é: uma TABELA HTML com BOM UTF-8 e
 * extensão trocada. Por isso o formato é detectado pelo conteúdo, não pelo
 * nome: HTML vai pelo DOMParser; .xlsx/.xls de verdade vão pelo SheetJS
 * (carregado sob demanda, para não pesar o acesso de quem nunca importa).
 *
 * O navegador só LÊ e nomeia colunas. Quem decide o que é válido, o que já
 * existe e o que cabe no plano é o servidor.
 */

/** Sinônimos de cabeçalho — o export muda de idioma conforme a instalação. */
const COLUNAS = {
  source_id: ['id', 'codigo', 'código', 'code'],
  name: ['jogador', 'nome', 'nombre', 'name', 'player'],
  nickname: ['nick', 'apelido', 'apodo', 'nickname'],
  email: ['e-mail', 'email', 'correo'],
  phone: ['telefone', 'telefono', 'teléfono', 'phone', 'fone'],
  mobile: ['celular', 'movil', 'móvil', 'mobile', 'whatsapp'],
  doc_country: ['doc. pais', 'doc. país', 'doc pais', 'documento pais', 'doc. country'],
  document_type: ['doc. tipo', 'doc tipo', 'tipo doc', 'tipo de documento', 'doc. type'],
  document_number: ['doc. numero', 'doc. número', 'doc numero', 'documento', 'doc. number'],
  birth_date: ['nascimento', 'nacimiento', 'data de nascimento', 'birth', 'birth_date'],
  nationality: ['pais', 'país', 'country', 'nacionalidade'],
};

const semAcento = (s) =>
  String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim().toLowerCase();

/** Casa os cabeçalhos lidos com os nossos campos. */
function mapearColunas(cabecalho) {
  const mapa = {};
  cabecalho.forEach((titulo, i) => {
    const t = semAcento(titulo);
    if (!t) return;
    for (const [campo, nomes] of Object.entries(COLUNAS)) {
      if (mapa[campo] !== undefined) continue;
      if (nomes.some((n) => semAcento(n) === t)) { mapa[campo] = i; return; }
    }
  });
  return mapa;
}

/** Acha a linha de cabeçalho: o export tem título e data antes dela. */
function acharCabecalho(matriz) {
  for (let i = 0; i < Math.min(matriz.length, 15); i++) {
    const mapa = mapearColunas(matriz[i]);
    if (mapa.name !== undefined) return { indice: i, mapa };
  }
  return { indice: -1, mapa: {} };
}

async function lerArquivo(file) {
  const buffer = await file.arrayBuffer();
  const inicio = new TextDecoder('utf-8').decode(buffer.slice(0, 1024)).toLowerCase();

  let matriz;
  if (inicio.includes('<table') || inicio.includes('<html') || inicio.includes('<tr')) {
    // Caso do Poker Web: HTML com extensão .xls.
    const texto = new TextDecoder('utf-8').decode(buffer).replace(/^\ufeff/, '');
    const doc = new DOMParser().parseFromString(texto, 'text/html');
    matriz = Array.from(doc.querySelectorAll('tr')).map((tr) =>
      Array.from(tr.querySelectorAll('td,th')).map((td) => (td.textContent || '').trim())
    );
  } else {
    const XLSX = await import('xlsx');
    const wb = XLSX.read(buffer, { type: 'array', cellDates: false, raw: false });
    const aba = wb.Sheets[wb.SheetNames[0]];
    matriz = XLSX.utils.sheet_to_json(aba, { header: 1, defval: '', raw: false });
  }

  const { indice, mapa } = acharCabecalho(matriz);
  if (indice === -1) {
    throw new Error('SEM_CABECALHO');
  }

  const pega = (linha, campo) => {
    const i = mapa[campo];
    return i === undefined || i >= linha.length ? '' : String(linha[i] ?? '').trim();
  };

  const linhas = [];
  for (let i = indice + 1; i < matriz.length; i++) {
    const l = matriz[i];
    if (!l || !l.some((c) => String(c ?? '').trim())) continue;
    linhas.push({
      source_id: pega(l, 'source_id'),
      name: pega(l, 'name'),
      nickname: pega(l, 'nickname'),
      email: pega(l, 'email'),
      phone: pega(l, 'phone'),
      mobile: pega(l, 'mobile'),
      nationality: pega(l, 'nationality'),
      doc_country: pega(l, 'doc_country'),
      document_type: pega(l, 'document_type'),
      document_number: pega(l, 'document_number'),
      birth_date: pega(l, 'birth_date'),
    });
  }
  return linhas;
}

/** Baixa a lista de pendências para o clube corrigir na origem. */
function baixarPendencias(itens, t) {
  const cab = [
    t('playerImport.csvId', 'ID no sistema antigo'),
    t('playerImport.csvName', 'Jogador'),
    t('playerImport.csvReason', 'O que falta'),
  ];
  const esc = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const csv = [cab.map(esc).join(';')]
    .concat(itens.map((i) => [i.source_id, i.name, i.reason].map(esc).join(';')))
    .join('\r\n');
  // BOM: sem ele o Excel abre os acentos errados.
  const blob = new Blob(['\ufeff' + csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'jogadores-pendentes.csv';
  a.click();
  URL.revokeObjectURL(url);
}

const PlayerImportModal = ({ onClose, onImported }) => {
  const { t } = useTranslation();
  const { toast } = useToast();
  const inputRef = useRef(null);

  const [etapa, setEtapa] = useState('arquivo');   // arquivo | previa | fim
  const [ocupado, setOcupado] = useState(false);
  const [nomeArquivo, setNomeArquivo] = useState('');
  const [linhas, setLinhas] = useState([]);
  const [previa, setPrevia] = useState(null);
  const [resultado, setResultado] = useState(null);
  const [erro, setErro] = useState('');

  // Acessibilidade: o fundo escuro fecha no clique, mas quem usa só o teclado
  // precisa do Esc para sair do modal.
  useEffect(() => {
    const onKeyDown = (ev) => {
      if (ev.key === 'Escape' && !ocupado) onClose();
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [ocupado, onClose]);

  const escolher = useCallback(async (file) => {
    if (!file) return;
    setErro('');
    setOcupado(true);
    setNomeArquivo(file.name);
    try {
      const lidas = await lerArquivo(file);
      if (!lidas.length) {
        setErro(t('playerImport.emptyFile', 'Não encontramos jogadores neste arquivo.'));
        setOcupado(false);
        return;
      }
      setLinhas(lidas);
      const res = await api.post('/players/import/preview', { rows: lidas });
      setPrevia(res.data);
      setEtapa('previa');
    } catch (err) {
      setErro(
        err.message === 'SEM_CABECALHO'
          ? t('playerImport.noHeader', 'Não achamos a coluna de nome do jogador. Confira se este é o arquivo exportado pelo sistema antigo.')
          : err.userMessage || t('playerImport.readError', 'Não foi possível ler este arquivo.')
      );
    } finally {
      setOcupado(false);
    }
  }, [t]);

  const importar = useCallback(async () => {
    setOcupado(true);
    setErro('');
    try {
      const res = await api.post('/players/import', { rows: linhas });
      setResultado(res.data);
      setEtapa('fim');
      if (res.data.importados > 0) {
        toast.success(t('playerImport.done', '{{n}} jogadores importados.', { n: res.data.importados }));
        onImported?.();
      }
    } catch (err) {
      setErro(err.userMessage || t('playerImport.importError', 'Não foi possível concluir a importação.'));
    } finally {
      setOcupado(false);
    }
  }, [linhas, t, toast, onImported]);

  const pendencias = (previa?.lista_rejeitados || []).concat(resultado?.lista_rejeitados || []);

  return (
    <div
      className="pim-overlay"
      role="presentation"
      onClick={(e) => { if (e.target === e.currentTarget && !ocupado) onClose(); }}
    >
      <div className="pim-modal" role="dialog" aria-modal="true" aria-label={t('playerImport.title', 'Importar jogadores')}>

        <div className="pim-head">
          <h2>{t('playerImport.title', 'Importar jogadores')}</h2>
          <button className="pim-x" onClick={onClose} disabled={ocupado}
                  aria-label={t('common.close', 'Fechar')}>×</button>
        </div>

        {/* ── 1. Escolher arquivo ── */}
        {etapa === 'arquivo' && (
          <>
            <p className="pim-hint">
              {t('playerImport.hint', 'Envie a planilha de jogadores exportada do seu sistema atual. Aceita .xls e .xlsx.')}
            </p>
            <button
              type="button"
              className="pim-drop"
              onClick={() => inputRef.current?.click()}
              disabled={ocupado}
            >
              <span className="pim-drop-icon" aria-hidden="true">↑</span>
              <span className="pim-drop-main">
                {ocupado
                  ? t('playerImport.reading', 'Conferindo o arquivo...')
                  : t('playerImport.choose', 'Escolher arquivo')}
              </span>
              {nomeArquivo && !ocupado && <span className="pim-drop-file">{nomeArquivo}</span>}
            </button>
            <input
              ref={inputRef}
              type="file"
              accept=".xls,.xlsx,.htm,.html,application/vnd.ms-excel,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
              hidden
              onChange={(e) => escolher(e.target.files?.[0])}
            />
          </>
        )}

        {/* ── 2. Prévia ── */}
        {etapa === 'previa' && previa && (
          <>
            <p className="pim-hint">
              {t('playerImport.previewHint', 'Confira antes de gravar. Nada foi salvo ainda.')}
            </p>

            <div className="pim-nums">
              <div className="pim-num ok">
                <strong>{previa.novos}</strong>
                <span>{t('playerImport.willImport', 'serão importados')}</span>
              </div>
              <div className="pim-num">
                <strong>{previa.ja_cadastrados}</strong>
                <span>{t('playerImport.already', 'já cadastrados')}</span>
              </div>
              <div className="pim-num warn">
                <strong>{previa.rejeitados}</strong>
                <span>{t('playerImport.pending', 'incompletos')}</span>
              </div>
            </div>

            {previa.rejeitados > 0 && (
              <div className="pim-box">
                <p>
                  {t('playerImport.pendingExplain',
                     'Os incompletos não têm e-mail, telefone ou documento — campos que o sistema exige. Baixe a lista, complete no sistema antigo e importe de novo: quem já entrou não será duplicado.')}
                </p>
                <button type="button" className="pim-link"
                        onClick={() => baixarPendencias(previa.lista_rejeitados, t)}>
                  {t('playerImport.downloadPending', 'Baixar lista de pendentes')}
                </button>
              </div>
            )}

            {!previa.cabe_no_plano && (
              <div className="pim-box danger">
                {t('playerImport.overLimit',
                   'O plano permite {{limite}} jogadores. A organização já tem {{atual}} e a importação traria {{novos}}.',
                   { limite: previa.limite_plano, atual: previa.jogadores_atuais, novos: previa.novos })}
              </div>
            )}

            {previa.amostra?.length > 0 && (
              <>
                <p className="pim-sub">{t('playerImport.sample', 'Amostra do que será criado')}</p>
                <div className="pim-table-wrap">
                  <table className="pim-table">
                    <thead>
                      <tr>
                        <th>{t('players.name', 'Nome')}</th>
                        <th>{t('players.email', 'E-mail')}</th>
                        <th>{t('players.phone', 'Telefone')}</th>
                        <th>{t('players.nationality', 'País')}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {previa.amostra.map((p, i) => (
                        <tr key={i}>
                          <td>{p.name}</td>
                          <td>{p.email}</td>
                          <td>{p.phone}</td>
                          <td>{p.nationality}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </>
            )}
          </>
        )}

        {/* ── 3. Resultado ── */}
        {etapa === 'fim' && resultado && (
          <>
            <div className="pim-nums">
              <div className="pim-num ok">
                <strong>{resultado.importados}</strong>
                <span>{t('playerImport.imported', 'importados')}</span>
              </div>
              <div className="pim-num">
                <strong>{resultado.ja_cadastrados}</strong>
                <span>{t('playerImport.already', 'já cadastrados')}</span>
              </div>
              <div className="pim-num warn">
                <strong>{resultado.rejeitados}</strong>
                <span>{t('playerImport.pending', 'incompletos')}</span>
              </div>
            </div>
            {pendencias.length > 0 && (
              <div className="pim-box">
                <p>{t('playerImport.pendingAfter',
                      'Complete os pendentes no sistema antigo e importe o arquivo de novo — os já criados serão ignorados.')}</p>
                <button type="button" className="pim-link"
                        onClick={() => baixarPendencias(pendencias, t)}>
                  {t('playerImport.downloadPending', 'Baixar lista de pendentes')}
                </button>
              </div>
            )}
          </>
        )}

        {erro && <div className="pim-erro">{erro}</div>}

        <div className="pim-acoes">
          {etapa === 'previa' ? (
            <>
              <button type="button" className="pim-btn ghost" onClick={onClose} disabled={ocupado}>
                {t('common.cancel', 'Cancelar')}
              </button>
              <button
                type="button"
                className="pim-btn"
                onClick={importar}
                disabled={ocupado || previa.novos === 0 || !previa.cabe_no_plano}
              >
                {ocupado
                  ? t('playerImport.importing', 'Importando...')
                  : t('playerImport.confirm', 'Importar {{n}} jogadores', { n: previa.novos })}
              </button>
            </>
          ) : (
            <button type="button" className="pim-btn" onClick={onClose} disabled={ocupado}>
              {etapa === 'fim' ? t('common.close', 'Fechar') : t('common.cancel', 'Cancelar')}
            </button>
          )}
        </div>

      </div>
    </div>
  );
};

export default PlayerImportModal;
