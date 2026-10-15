import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';
import Button from './Button';
import { currencySymbol } from '../utils/currencyUtils';
import { novaLinha, removerLinha } from '../utils/entryTypes';
import './EntryTypesEditor.css';

/**
 * Editor da lista de meios de entrada do TORNEIO: uma linha por meio, com nome,
 * valor, rake, fichas e categoria, mais "Adicionar entrada" e "Remover".
 *
 * Controlado: quem usa guarda as linhas (`linhas`, no formato de
 * `utils/entryTypes.novaLinha`) e recebe a lista nova em `onChange`. É o mesmo
 * editor no modal de torneio (criar e editar) e no detalhe do torneio — a lista
 * é UMA por torneio e vale para todos os dias dele.
 *
 * A categoria NÃO é rótulo: é ela que decide o efeito da venda no Caixa (entrada
 * soma jogador novo, recompra devolve alguém à mesa, add-on só entrega fichas,
 * taxa cobra à parte — ex.: Bono Dealer — sem contar como add-on).
 * O NOME é livre justamente para o clube poder ter "Buy-in duplo" e "Rebuy
 * triplo" sem precisar de categoria nova.
 *
 * Erros: `erro` é a mensagem de quem valida ao salvar. A recusa de remover o
 * último meio de Entrada nasce aqui dentro; com `onErro` ela sobe para quem usa
 * (um lugar só guarda a mensagem), sem `onErro` fica em estado local. As duas
 * aparecem no mesmo aviso.
 */
const EntryTypesEditor = ({
  linhas,
  onChange,
  erro = '',
  onErro,
  currency,
  disabled = false,
  idPrefix = 'entry',
  // Torneio por equipes: a Entrada pode ser cobrada POR EQUIPE (o valor é o
  // da equipe inteira, dividido entre os integrantes no "Cobrar equipe").
  porEquipe = false,
}) => {
  const { t } = useTranslation();
  const [erroLocal, setErroLocal] = useState('');

  const avisar = (mensagem) => (onErro ? onErro(mensagem) : setErroLocal(mensagem));
  const mensagem = onErro ? erro : erro || erroLocal;
  const hintId = `${idPrefix}_category_hint`;

  const alterar = (chave, campo, valor) => {
    avisar('');
    onChange(linhas.map((l) => (l.key === chave ? { ...l, [campo]: valor } : l)));
  };

  const adicionar = () => {
    avisar('');
    onChange([...linhas, novaLinha({ category: 'buy_in' })]);
  };

  const remover = (chave) => {
    const { linhas: restantes, erro: recusa } = removerLinha(linhas, chave, t);
    avisar(recusa);
    if (!recusa) onChange(restantes);
  };

  return (
    <div className="entry-types-editor">
      <p className="form-hint entry-methods-intro">
        {t(
          'tournamentDayForm.entryMethodsIntro',
          'Cada meio de entrada tem nome, valor, rake e fichas próprios. A lista é do torneio e vale para todos os dias — inclusive variações como "Buy-in duplo" ou "Rebuy triplo".'
        )}
      </p>

      {mensagem && (
        <div className="entry-methods-error" role="alert">
          {mensagem}
        </div>
      )}

      <div className="entry-methods-list">
        {linhas.map((meio, indice) => (
          <div className="entry-method-row" key={meio.key}>
            <div className="form-group entry-method-name">
              <label htmlFor={`${idPrefix}_name_${meio.key}`}>
                {t('tournamentDayForm.entryMethodName', 'Nome')} *
              </label>
              <input
                id={`${idPrefix}_name_${meio.key}`}
                type="text"
                value={meio.name}
                onChange={(e) => alterar(meio.key, 'name', e.target.value)}
                placeholder={t('tournamentDayForm.entryMethodNamePlaceholder', 'Ex: Buy-in duplo')}
                required
                disabled={disabled}
              />
            </div>
            <div className="form-group">
              <label htmlFor={`${idPrefix}_amount_${meio.key}`}>
                {t('tournamentDayForm.entryMethodAmount', 'Valor')} ({currencySymbol(currency)})
              </label>
              <input
                id={`${idPrefix}_amount_${meio.key}`}
                type="number"
                min="0"
                step="0.01"
                value={meio.amount}
                onChange={(e) => alterar(meio.key, 'amount', e.target.value)}
                placeholder="0,00"
                required
                disabled={disabled}
              />
            </div>
            <div className="form-group">
              <label htmlFor={`${idPrefix}_rake_${meio.key}`}>
                {t('tournamentDayForm.entryMethodRake', 'Rake (%)')}
              </label>
              <input
                id={`${idPrefix}_rake_${meio.key}`}
                type="number"
                min="0"
                max="100"
                step="0.01"
                value={meio.rake_percentage}
                onChange={(e) => alterar(meio.key, 'rake_percentage', e.target.value)}
                disabled={disabled}
              />
            </div>
            <div className="form-group">
              <label htmlFor={`${idPrefix}_chips_${meio.key}`}>
                {t('tournamentDayForm.entryMethodChips', 'Fichas')}
              </label>
              <input
                id={`${idPrefix}_chips_${meio.key}`}
                type="number"
                min="0"
                value={meio.chips}
                onChange={(e) => alterar(meio.key, 'chips', e.target.value)}
                disabled={disabled}
              />
            </div>
            <div className="form-group">
              <label htmlFor={`${idPrefix}_category_${meio.key}`}>
                {t('tournamentDayForm.entryMethodCategory', 'Categoria')}
              </label>
              <select
                id={`${idPrefix}_category_${meio.key}`}
                value={meio.category}
                onChange={(e) => alterar(meio.key, 'category', e.target.value)}
                /* A dica é uma só para a coluna inteira (repeti-la em cada
                   linha viraria ruído); o aria-describedby liga todos os
                   selects a ela. */
                aria-describedby={hintId}
                disabled={disabled}
              >
                <option value="buy_in">{t('tournamentDayForm.categoryBuyIn', 'Entrada')}</option>
                <option value="rebuy">{t('tournamentDayForm.categoryRebuy', 'Recompra')}</option>
                <option value="addon">{t('tournamentDayForm.categoryAddon', 'Add-on')}</option>
                <option value="fee">{t('tournamentDayForm.categoryFee', 'Taxa')}</option>
              </select>
              {porEquipe && meio.category === 'buy_in' && (
                <label className="entry-method-team">
                  <input
                    type="checkbox"
                    checked={!!meio.per_team}
                    onChange={(e) => alterar(meio.key, 'per_team', e.target.checked)}
                    disabled={disabled}
                  />
                  {t('teams.perTeam', 'Por equipe (valor da equipe inteira)')}
                </label>
              )}
              {indice === 0 && (
                <small className="form-hint" id={hintId}>
                  {t(
                    'tournamentDayForm.entryMethodCategoryHint',
                    'A categoria decide o efeito da venda: Entrada soma um jogador novo, Recompra devolve alguém à mesa, Add-on só entrega fichas a quem já joga, Taxa cobra à parte (ex.: Bono Dealer) e não conta como add-on.'
                  )}
                </small>
              )}
            </div>
            <div className="entry-method-actions">
              <Button
                type="button"
                variant="danger"
                size="small"
                onClick={() => remover(meio.key)}
                disabled={disabled}
                aria-label={t('tournamentDayForm.removeEntryMethodOf', 'Remover meio de entrada {{nome}}', {
                  nome: meio.name || t('tournamentDayForm.entryMethodUnnamed', 'sem nome'),
                })}
              >
                {t('tournamentDayForm.removeEntryMethod', 'Remover')}
              </Button>
            </div>
          </div>
        ))}
      </div>

      <Button type="button" variant="secondary" onClick={adicionar} disabled={disabled}>
        {t('tournamentDayForm.addEntryMethod', 'Adicionar entrada')}
      </Button>
    </div>
  );
};

export default EntryTypesEditor;
