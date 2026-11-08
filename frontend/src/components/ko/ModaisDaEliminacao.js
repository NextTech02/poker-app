import React from 'react';
import EliminadorModal from './EliminadorModal';
import KoResultadoModal from './KoResultadoModal';

/**
 * Os modais do `useEliminacaoNoAssento`: "Quem eliminou?" e o quadro do KO com
 * o pagamento. Ficam aqui para toda tela do floor perguntar e pagar igual.
 */
const ModaisDaEliminacao = ({ eliminacao, ko, tournamentId, torneioNome, assentoPorJogador, onPago }) => {
  const {
    eliminando, setEliminando, enviando, candidatos, eliminar, resultadoKo, setResultadoKo,
  } = eliminacao;
  return (
    <>
      {eliminando && (
        <EliminadorModal
          vitima={eliminando.nome}
          formato={ko.formato}
          candidatos={candidatos}
          mesaDaVitima={eliminando.mesa}
          enviando={enviando}
          onFechar={() => { if (!enviando) setEliminando(null); }}
          onConfirmar={(quem) => eliminar(eliminando.inscrito, eliminando.nome, eliminando.mesa, quem)}
        />
      )}

      {resultadoKo && (
        <KoResultadoModal
          tournamentId={tournamentId}
          knockout={resultadoKo}
          torneioNome={torneioNome}
          assentoDoJogador={(playerId) => assentoPorJogador.get(playerId) || null}
          onFechar={() => setResultadoKo(null)}
          onPago={onPago}
        />
      )}
    </>
  );
};

export default ModaisDaEliminacao;
