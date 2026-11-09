# Painel de mesas (2026-11)

Todas as mesas do dia desenhadas numa tela, para o floor e o diretor verem e agirem pelo tablet ou
pelo celular. Pedido da Fenix depois do piloto de 07/11 ("el manejo de las mesas debe ser más amplio
y práctico para la visualización y manejo del floor y director").

Rota: `/painel-mesas/:dayId`, com a permissão `tables` (a mesma da Gestão de Mesas). Atalhos na
Gestão de Mesas e no Relógio de Mesa.

## O que mostra

- **Cada mesa ativa** desenhada como no tablet do dealer: o assento 1 é o primeiro à esquerda do
  dealer e a numeração segue no sentido horário. O assento mostra o primeiro nome e a inicial do
  sobrenome, e os cartões de time bank quando o dia usa time bank.
- **Ocupação** de cada mesa (sentados / lugares que recebem jogador) e as mesas com o relógio aberto
  num tablet.
- **Equilíbrio:** sugere passar um jogador da mesa mais cheia para a mais vazia quando a diferença
  chega a dois, e quebrar a mesa com menos gente quando todos cabem nas outras. Só sugere: quem move
  é o floor (`utils/equilibrioDasMesas.js`).
- **Sem mesa:** quem entrou e ainda não foi sentado.
- **Eliminados agora há pouco**, com desfazer para o engano.

## Ações

Tocar no assento abre as ações daquele jogador:

- **Eliminar** (só na eliminação por mesa). Usa o mesmo caminho da Gestão de Mesas, o hook
  `useEliminacaoNoAssento`: fila sem rede, "Quem eliminou?" no KO, quadro do KO com o pagamento.
- **Trocar de mesa:** escolhe a mesa (a sugerida pelo equilíbrio vem marcada) e o assento livre.
  Entrega o bilhete do lugar novo.

Tocar num assento livre senta alguém da lista "sem mesa". Montar mesas, travar, bloquear assento e
distribuir em lote continuam na Gestão de Mesas.

Na eliminação em massa o painel não elimina nem lista eliminados: o sistema não sabe quem saiu, e
quem elimina é o contador do Controle.
