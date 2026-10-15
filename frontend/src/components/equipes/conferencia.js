/**
 * Folha de conferência da Fase 1: cada equipe com os pontos de cada
 * integrante (mesa e posição) e a linha para o capitão assinar. As bases do
 * clube pedem que os capitães confiram a soma antes de a direção oficializar.
 */
import { formatarPontos } from '../../utils/equipes';

const escapar = (texto) => String(texto ?? '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** HTML da folha (separado da impressão para poder testar). `t` traduz. */
export const htmlDaConferencia = ({ torneio, ranking = [], t }) => {
  const blocos = ranking.map((equipe) => `
<section class="cf-equipe">
  <h2>${equipe.rank ?? '—'}º · ${escapar(equipe.name)} — ${escapar(formatarPontos(equipe.points))} ${escapar(t('teams.pointsShort', 'pts'))}</h2>
  <table>
    <thead><tr>
      <th>${escapar(t('teams.player', 'Jogador'))}</th>
      <th>${escapar(t('teams.table', 'Mesa'))}</th>
      <th>${escapar(t('teams.position', 'Posição'))}</th>
      <th>${escapar(t('teams.points', 'Pontos'))}</th>
    </tr></thead>
    <tbody>
      ${(equipe.members || []).map((m) => `<tr>
        <td>${escapar(m.name)}${m.is_captain ? ` (${escapar(t('teams.captain', 'Capitão'))})` : ''}</td>
        <td>${escapar(m.table_number ?? '—')}</td>
        <td>${escapar(m.position ?? '—')}</td>
        <td>${escapar(formatarPontos(m.points))}</td>
      </tr>`).join('')}
    </tbody>
  </table>
  <p class="cf-assinatura">${escapar(t('teams.captainSignature', 'Assinatura do capitão'))}: ______________________________</p>
</section>`).join('');
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><title>${escapar(t('teams.verificationSheet', 'Conferência da Fase 1'))}</title>
<style>
body { font-family: Arial, sans-serif; margin: 12mm; color: #111; }
h1 { font-size: 18px; margin: 0 0 12px; }
.cf-equipe { page-break-inside: avoid; margin-bottom: 14px; }
h2 { font-size: 14px; margin: 0 0 6px; }
table { width: 100%; border-collapse: collapse; font-size: 12px; }
th, td { border: 1px solid #999; padding: 4px 6px; text-align: left; }
.cf-assinatura { font-size: 12px; margin: 10px 0 0; }
</style></head><body>
<h1>${escapar(t('teams.verificationSheet', 'Conferência da Fase 1'))} — ${escapar(torneio)}</h1>
${blocos}
<script>window.onload=function(){window.print();};</script></body></html>`;
};

export const imprimirConferencia = (dados) => {
  const janela = window.open('', '_blank');
  if (!janela) return false;
  janela.document.write(htmlDaConferencia(dados));
  janela.document.close();
  return true;
};
