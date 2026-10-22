/**
 * FIADO DA CASA — o que as telas compartilham.
 *
 * Fiado não é o crédito de patrocinador (Caixa → Jogadores): lá o saldo é a
 * favor do jogador; aqui é o quanto ele DEVE ao clube. Por isso o código de
 * origem é outro (`house_credit`, nunca `credit`).
 */
import api from '../config/api';
import { escapar } from './bilhete';

export const FIADO = 'house_credit';

/** A conta do jogador, ou null se não deu para ler (a tela segue sem fiado). */
export const buscarContaFiado = async (playerId) => {
  if (!playerId) return null;
  try {
    const { data } = await api.get(`/house-credit/players/${playerId}`, { _silentError: true });
    return data;
  } catch {
    return null;
  }
};

/** `detail` estruturado da recusa (`{code, message, ...}`), ou {}. */
export const detalheDoErro = (err) => {
  const d = err?.response?.data?.detail;
  return d && typeof d === 'object' ? d : {};
};

/** Dívidas de vários jogadores numa consulta só: `{player_id: saldo}`. */
export const buscarDividas = async (playerIds) => {
  const ids = [...new Set((playerIds || []).filter(Boolean))];
  if (!ids.length) return {};
  try {
    const { data } = await api.get('/house-credit/balances', {
      params: { player_ids: ids.join(',') }, _silentError: true,
    });
    return Object.fromEntries((data || []).map((b) => [b.player_id, Number(b.balance || 0)]));
  } catch {
    return {};
  }
};

/**
 * Abatimento de cada pagamento de prêmio (`{payout_id: valor}`), na ORDEM em
 * que serão pagos: o mesmo jogador com dois KOs abate a dívida uma vez só —
 * o segundo vê o que sobrou dela. Só entra quem deve.
 */
export const abatimentosDePremios = (pagamentos, dividas) => {
  const resta = { ...(dividas || {}) };
  const saida = {};
  (pagamentos || []).forEach((p) => {
    const jogador = p.eliminator_player_id;
    const deve = Number(resta[jogador] || 0);
    if (deve <= 0) return;
    const abate = Math.round(Math.min(deve, Number(p.cash_amount || 0)) * 100) / 100;
    saida[p.id] = abate;
    resta[jogador] = deve - abate;
  });
  return saida;
};

export const novoIdDeOperacao = () =>
  (window.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(16).slice(2)}`);

/**
 * Cupom de 80 mm: o VALE (venda no fiado, com assinatura do jogador) ou o
 * COMPROVANTE de recebimento. Abre na hora do clique — fora de um clique o
 * navegador bloqueia a janela.
 *
 * Os textos vêm traduzidos de quem chama; nomes vão escapados (o nome do
 * jogador é digitado por gente e entra no HTML).
 */
export const imprimirCupomDeFiado = ({
  titulo, clube, jogador, documento, linhas = [], valor, rodape, assinatura, atendente, quando,
}) => {
  const janela = window.open('', '_blank');
  if (!janela) return false;
  const tabela = linhas
    .filter((l) => l && l.valor !== undefined && l.valor !== null && l.valor !== '')
    .map((l) => `<tr><td class="lbl">${escapar(l.rotulo)}</td><td class="val">${escapar(l.valor)}</td></tr>`)
    .join('');
  janela.document.write(`<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>${escapar(titulo)}</title>
<style>
  @media print { @page { size: 80mm auto; margin: 0; } body { margin: 0; } }
  * { box-sizing: border-box; }
  body { font-family: 'Courier New', Courier, monospace; font-size: 12px; width: 80mm;
         margin: 0 auto; padding: 8mm 6mm; color: #111; background: #fff; }
  .c { text-align: center; } .b { font-weight: bold; }
  hr.h { border: none; border-top: 2px solid #111; margin: 8px 0; }
  hr.l { border: none; border-top: 1px dashed #555; margin: 6px 0; }
  table { width: 100%; border-collapse: collapse; } td { padding: 2px 0; vertical-align: top; }
  td.lbl { color: #444; } td.val { font-weight: bold; text-align: right; }
  .valor { font-size: 22px; font-weight: bold; text-align: center; margin: 8px 0; }
  .nome { font-size: 14px; font-weight: bold; }
  .assin { border-bottom: 1px solid #111; margin: 22px 0 4px; }
  .peq { font-size: 10px; color: #444; }
</style></head><body>
  <hr class="h"><div class="c b">${escapar(clube || '')}</div><div class="c b">${escapar(titulo)}</div><hr class="h">
  <table>
    <tr><td class="lbl">${escapar(quando?.rotulo || '')}</td><td class="val">${escapar(quando?.valor || '')}</td></tr>
    ${atendente ? `<tr><td class="lbl">${escapar(atendente.rotulo)}</td><td class="val">${escapar(atendente.valor)}</td></tr>` : ''}
  </table>
  <hr class="l">
  <div class="nome">${escapar(jogador)}</div>
  ${documento ? `<div class="peq">${escapar(documento)}</div>` : ''}
  <hr class="h">
  <div class="valor">${escapar(valor)}</div>
  <table>${tabela}</table>
  ${assinatura ? `<div class="assin"></div><div class="c peq">${escapar(assinatura)}</div>` : ''}
  ${rodape ? `<hr class="l"><div class="c peq">${escapar(rodape)}</div>` : ''}
  <script>window.onload = function () { window.print(); setTimeout(function () { window.close(); }, 300); };</script>
</body></html>`);
  janela.document.close();
  return true;
};
