import api from '../config/api';
import { textoDoDetalhe } from './textoDoErro';

// Mesa fechada/quebrada não recebe jogador: o servidor só aloca em mesa
// 'active', então contar as outras daria falso "está tudo certo".
export const soMesasAtivas = (mesas) => (Array.isArray(mesas) ? mesas : []).filter(
  (m) => (m.status || 'active') === 'active'
);

// Falha de consulta não é "não tem mesa": calar é melhor que mentir.
const diaSemMesaAtiva = async (dayId) => {
  try {
    const res = await api.get(`/tables/day/${dayId}`);
    return soMesasAtivas(res.data).length === 0;
  } catch (erro) {
    console.warn('[assento] falha ao conferir as mesas:', erro);
    return false;
  }
};

// A recusa vem como `{code, message}` (backend/app/utils/erros.py), e a frase do
// allocation_service é o que separa mesa cheia de nenhuma mesa. Tratar o detalhe
// como texto quebrava aqui dentro: a venda já paga aparecia como erro, sem bilhete.
const fraseDoServidor = (detalhe) => (typeof detalhe === 'string' ? detalhe : detalhe?.message || '');

/* Assento de quem acabou de ENTRAR: buy-in, reentrada ou resgate de ticket. A
   entrada já está paga, então nada aqui rejeita: sempre há bilhete a entregar.

   - alocação manual: o staff senta o jogador → `{ sem_assento: true }`;
   - mesas travadas: `{ is_alternate: true, motivo_alternate }`, 'sem-mesas' se
     nenhuma foi cadastrada, 'travadas' se é fila de alternados de verdade;
   - alocação automática: `{ alocacao }` com o assento; sem lugar livre vira
     alternado ('lotadas' ou 'sem-mesas'); outro erro devolve
     `{ sem_assento: true, falhou: true, motivo }` para avisar quem opera.

   `semMesas`: quem já conferiu as mesas informa; sem isso, o dia é consultado. */
export const pedirAssento = async ({
  playerId, tournamentId, dayId, allocationType, tablesLocked = false, semMesas,
}) => {
  if (allocationType !== 'automatic') return { sem_assento: true };

  if (tablesLocked) {
    const nenhumaMesa = semMesas ?? await diaSemMesaAtiva(dayId);
    return { is_alternate: true, motivo_alternate: nenhumaMesa ? 'sem-mesas' : 'travadas' };
  }

  try {
    const { data } = await api.post(dayId
      ? `/allocations/day/${dayId}/auto?player_id=${playerId}`
      : `/allocations/tournament/${tournamentId}/auto?player_id=${playerId}`);
    return { alocacao: data };
  } catch (erro) {
    console.error('Erro ao alocar jogador:', erro);
    const detalhe = erro.response?.data?.detail;
    const frase = fraseDoServidor(detalhe).toLowerCase();
    const semMesaAtiva = frase.includes('no active tables');
    if (semMesaAtiva || frase.includes('tables are full')) {
      // O motivo muda a ação: mesa cheia é fila de alternados; nenhuma mesa
      // ativa é configuração faltando, e o staff tem de cadastrar as mesas.
      return { is_alternate: true, motivo_alternate: semMesaAtiva ? 'sem-mesas' : 'lotadas' };
    }
    return { sem_assento: true, falhou: true, motivo: textoDoDetalhe(detalhe) || '' };
  }
};
