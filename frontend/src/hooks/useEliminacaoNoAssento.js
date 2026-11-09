import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useToast } from '../contexts/ToastContext';
import { offlineWrite } from '../offline/apiOffline';
import { applyEliminate, applyUneliminate } from '../offline/domainRules';
import { uuid } from '../offline/db';
import { candidatosAEliminador, codigoDaRecusa, corpoDaEliminacao } from '../utils/ko';

/**
 * Eliminar no assento (modo "por mesa"): o mesmo caminho em toda tela do floor,
 * a Gestão de Mesas e o Painel de Mesas.
 *
 * Elimina, libera a cadeira e soma no contador que a TV lê, tudo no servidor,
 * numa chamada só. Pela fila offline, como as outras operações do salão: sem
 * rede a eliminação entra na fila e a tela já reflete.
 *
 * Torneio KO: pedir a eliminação abre "Quem eliminou?" (que já é a confirmação)
 * e, online, o quadro do KO com o pagamento na hora. Offline o KO nasce no sync
 * e o pagamento fica pendente na aba KO da Premiação. As telas desenham os
 * modais com `ModaisDaEliminacao`.
 *
 * @param {object}   opts
 * @param {object}   opts.ko                O `useTorneioKo` do torneio do dia.
 * @param {Array}    opts.inscritos         Inscritos do dia.
 * @param {Function} opts.setInscritos      Para a tela já mostrar a eliminação.
 * @param {Map}      opts.assentoPorJogador player_id → { mesa, assento }.
 * @param {Function} opts.aoMudar           Relê a tela depois de gravar online.
 */
export function useEliminacaoNoAssento({ ko, inscritos, setInscritos, assentoPorJogador, aoMudar }) {
  const { t } = useTranslation();
  const { toast, confirm } = useToast();
  const [eliminando, setEliminando] = useState(null); // { inscrito, nome, mesa }
  const [enviando, setEnviando] = useState(false);
  const [resultadoKo, setResultadoKo] = useState(null);

  const inscritoPorJogador = useMemo(
    () => new Map(inscritos.map((i) => [i.player_id, i])),
    [inscritos]
  );
  // A mesma mesa da vítima primeiro no "Quem eliminou?".
  const candidatos = useMemo(() => {
    if (!eliminando) return [];
    const mesas = new Map(inscritos.map((i) => [i.id, assentoPorJogador.get(i.player_id)?.mesa ?? null]));
    return candidatosAEliminador(
      inscritos.map((i) => ({ ...i, nome: i.player_name })),
      eliminando.inscrito.id, mesas, eliminando.mesa,
    );
  }, [eliminando, inscritos, assentoPorJogador]);

  const eliminar = async (inscrito, nome, mesa, quem = null) => {
    const cmid = uuid();
    const body = corpoDaEliminacao(inscrito.id, cmid, quem);
    setEnviando(true);
    try {
      const r = await offlineWrite({
        kind: 'eliminate', method: 'post',
        url: `/tournament-players/${inscrito.id}/eliminate`,
        body, clientMutationId: cmid, meta: { kind: 'eliminate', name: nome },
        synthetic: { ok: true }, applyLocal: () => applyEliminate(body),
      });
      setEliminando(null);
      setInscritos((prev) => prev.map((i) => (
        i.id === inscrito.id ? { ...i, status: 'eliminated', eliminated_at: new Date().toISOString() } : i
      )));
      toast.success(t('tableManagement.eliminatedSuccess', { name: nome }));
      if (r?.offline) {
        if (quem) {
          toast.info(ko.formato === 'mystery'
            ? t('ko.offlinePendingMystery', 'Sem conexão: o envelope será sorteado ao sincronizar e o pagamento fica pendente na aba Mystery da Premiação.')
            : t('ko.offlinePending', 'Sem conexão: o KO será registrado ao sincronizar e o pagamento fica pendente na aba KO da Premiação.'));
        }
      } else {
        if (r?.data?.knockout) setResultadoKo(r.data.knockout);
        await aoMudar();
      }
    } catch (err) {
      // A fase Mystery pode ter começado depois que a tela abriu: o servidor
      // pede o eliminador e a tela pergunta, em vez de só recusar.
      if (!quem && codigoDaRecusa(err) === 'eliminador_obrigatorio') {
        await ko.recarregar();
        setEliminando({ inscrito, nome, mesa });
        return;
      }
      toast.error(err.userMessage || t('tableManagement.errorEliminate', { detail: err.response?.data?.detail || err.message }));
    } finally {
      setEnviando(false);
    }
  };

  const pedirEliminacao = async ({ playerId, nome }) => {
    const nomeVisivel = nome || t('tableManagement.defaultPlayer');
    const inscrito = inscritoPorJogador.get(playerId);
    if (!inscrito) {
      toast.error(t('tableManagement.errorEliminate', { detail: t('tableManagement.playerNotInDay') }));
      return;
    }
    const mesa = assentoPorJogador.get(playerId)?.mesa ?? null;
    if (ko.exige) {
      setEliminando({ inscrito, nome: nomeVisivel, mesa });
      return;
    }
    const ok = await confirm(
      t('tableManagement.confirmEliminate', { name: nomeVisivel }),
      { variant: 'danger', confirmText: t('tableManagement.eliminatePlayer') }
    );
    if (!ok) return;
    await eliminar(inscrito, nomeVisivel, mesa);
  };

  // Desfazer: eliminação lançada no jogador errado. Não é reentrada (não há
  // venda); o jogador volta à lista de "sem mesa" para ser sentado de novo.
  const desfazerEliminacao = async (inscrito) => {
    const nome = inscrito.player_name || t('tableManagement.defaultPlayer');
    const body = { tournament_player_id: inscrito.id };
    try {
      const r = await offlineWrite({
        kind: 'restore', method: 'post',
        url: `/tournament-players/${inscrito.id}/uneliminate`,
        body, clientMutationId: uuid(), meta: { kind: 'restore', name: nome },
        synthetic: { ok: true }, applyLocal: () => applyUneliminate(body),
      });
      setInscritos((prev) => prev.map((i) => (
        i.id === inscrito.id ? { ...i, status: 'active', eliminated_at: null } : i
      )));
      toast.success(t('tableManagement.uneliminatedSuccess', { name: nome }));
      if (!r?.offline) await aoMudar();
    } catch (err) {
      toast.error(err.userMessage || t('tableManagement.errorUneliminate', { detail: err.response?.data?.detail || err.message }));
    }
  };

  return {
    pedirEliminacao,
    desfazerEliminacao,
    eliminar,
    eliminando,
    setEliminando,
    enviando,
    candidatos,
    resultadoKo,
    setResultadoKo,
  };
}
