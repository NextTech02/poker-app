/**
 * O buy-in de referência padrão do ranking (350) está em soles. Enquanto o
 * clube de outra moeda não salva as próprias regras, o fator de buy-in sai
 * errado: em pesos colombianos todo torneio bate no teto, em dólar quase todo
 * torneio fica no piso. E os pontos congelam ao oficializar.
 */
export const MOEDA_DAS_REGRAS_PADRAO = 'PEN';

export const referenciaEmOutraMoeda = (personalizadas, moeda) => (
  !personalizadas && Boolean(moeda) && moeda !== MOEDA_DAS_REGRAS_PADRAO
);
