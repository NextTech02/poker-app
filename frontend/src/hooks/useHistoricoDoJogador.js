import { useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { usePermissions } from '../contexts/PermissionContext';

/**
 * O nome do jogador sentado numa mesa leva direto ao histórico dele
 * (`/jogadores/:id`).
 *
 * Devolve props para espalhar no elemento do NOME — e não um `<a>`: no mapa de
 * mesas o assento é arrastável, e arrastar um link puxaria a URL em vez do
 * jogador. Depois de um arraste o navegador não dispara clique, então mover o
 * jogador continua igual. Enter (e espaço) abre pelo teclado.
 *
 * Sem a permissão de Jogadores a rota do histórico recusa a entrada; aí o nome
 * fica como texto, sem prometer um clique que não leva a lugar nenhum.
 *
 * @returns {{ podeVerHistorico: boolean, propsDoHistorico: (playerId) => object }}
 */
export function useHistoricoDoJogador() {
  const navigate = useNavigate();
  const { t } = useTranslation();
  const { hasPermission } = usePermissions();
  const podeVerHistorico = typeof hasPermission === 'function' && hasPermission('players');

  const propsDoHistorico = useCallback((playerId) => {
    if (!podeVerHistorico || !playerId) return {};
    const abrir = (e) => {
      // O nome mora dentro do assento: o clique não pode virar ação do assento.
      e.stopPropagation();
      navigate(`/jogadores/${playerId}`);
    };
    return {
      role: 'link',
      tabIndex: 0,
      title: t('players.viewHistory', 'Ver histórico'),
      onClick: abrir,
      onKeyDown: (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          abrir(e);
        }
      },
    };
  }, [podeVerHistorico, navigate, t]);

  return { podeVerHistorico, propsDoHistorico };
}

export default useHistoricoDoJogador;
