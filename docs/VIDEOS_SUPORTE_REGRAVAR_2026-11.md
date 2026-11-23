# Vídeos de suporte a regravar (nov/2026)

Os 195 arquivos publicados tocam, saltam e têm legenda (conferido no Chrome em
23/11/2026, um a um). O que está errado é o **conteúdo**: foram gravados em 09/11,
e o app mudou depois (PR #58 em 10/11 e as correções do pagamento dividido).

Os roteiros abaixo já estão corrigidos nesta branch. Falta gravar e publicar, o
que precisa das chaves (`VIDEOS_ENV`: Azure Speech e a service key do projeto de
São Paulo).

## 1. A narração diz algo que não é mais verdade (regravar primeiro)

| Vídeo | Idiomas | O que estava errado |
|---|---|---|
| `caixa-abrir-fechar-caixa` | pt, en, es | "Cada venda soma no saldo, qualquer que seja a forma de pagamento". Desde 10/11 o esperado da gaveta conta só dinheiro. |
| `caixa-pagamento-dividido` | pt, en, es | Ensina a clicar em "Outra forma". Com a branch `pagamento-dividido-correcoes`, a divisão já abre com as duas formas. Gravar depois do deploy dela. |
| `torneios-telao-tv` | es | Manda escolher "Ciegas"; o botão diz "Blinds". |
| `torneios-templates-blinds` | es | Manda abrir "Plantillas de Ciegas"; o menu diz "Plantillas de Blinds". |
| `torneios-telao`, `cash-modalidades` | es | "ciegas" no lugar de "blinds", como o app. |
| `jogadores-importar` | es | "planilla", que no Peru é folha de pagamento. |

Só as falas mudadas gastam cota do Azure (cerca de 2 mil caracteres).

## 2. A tela aparece em português nos vídeos en/es (áudio em cache)

Os textos foram corrigidos no app pelo PR #58. Regravar não gasta cota:

- todos os `torneios-*` ("jogadores" na lista de torneios);
- `bar-produtos-estoque`, `bar-turnos`, `bar-relatorios`, `bar-receber-comanda`
  (categorias e meios de pagamento);
- `financeiro-despesas` (categorias), `caixa-limite-jogador` (patrocinador),
  `equipe-convidar`, `equipe-grupos-permissoes`, `equipe-acessos-pagamentos`.

## 3. Formulários

Todo vídeo que mostra um formulário aparece com os campos colados, defeito
corrigido na branch `formularios-formatacao`. Se for regravar tudo, faça depois do
deploy dela.

## Como

```bash
cd scripts/videos
python produzir.py roteiros/caixa-abrir-fechar-caixa.yaml
python revisar.py caixa-abrir-fechar-caixa --idioma es-ES
python treinamento.py            # o treinamento é montado com os curtos
python publicar.py               # mostra o que subiria
python publicar.py --enviar
```
