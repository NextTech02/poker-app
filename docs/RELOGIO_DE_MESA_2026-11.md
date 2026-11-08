# Relógio de mesa e time bank (2026-11)

Relógio de ação que o dealer opera num tablet na mesa, com time bank em cartões por jogador.

## Como funciona na mesa

O dealer abre **Relógio de Mesa** no menu, escolhe o dia e a mesa, e deixa o tablet ali.

A tela mostra a mesa vista de cima, como o clube pediu no piloto de 07/11. O dealer fica embaixo;
o assento 1 é o primeiro à esquerda dele e a numeração segue no sentido horário. Cada assento
mostra o jogador e os cartões que restam; lugar vazio diz "Livre" e o bloqueado pelo floor, "Bloqueado".
Com o relógio parado, o centro mostra o tempo do nível e os blinds, contados pelo relógio do servidor.
Quando o relógio de ação corre, a contagem toma o centro.

Na eliminação em massa a lista da mesa não vem, porque estaria velha: os assentos mostram só o número.

| Toque | Quando |
|---|---|
| Nova mão | Depois de dar as cartas. Conta o tempo do pré-flop. |
| Próxima ação | A cada ação. Zera e conta de novo. |
| Flop | Quando abre o flop. Daí até o fim da mão vale o tempo do pós-flop. |
| Time bank | O jogador pede o cartão antes de o tempo acabar. |
| Relógio chamado | Alguém pediu o relógio. Funciona mesmo com o relógio desligado no dia. |

Quando o tempo acaba, os assentos que podem usar cartão acendem e o dealer toca no de quem vai usar.
Fora dessa hora, ou do botão Time bank, tocar no assento não faz nada: a mão do dealer passa pela tela
o tempo todo. O dealer só usa cartão; eliminar e trocar jogador de mesa são do floor. O sistema não acompanha a
mão nem sabe quem está agindo: é isso que mantém o trabalho do dealer em um toque por ação. Sem
cartão, a tela manda chamar o floor. Mão morta é decisão do floor, nunca do sistema.

Intervalo e pausa do relógio de blinds param o relógio da mesa.

## Regras

- **Configuração por dia**, em Relógio de Mesa, por quem tem `tables`, `tournaments` ou `employees`.
  Padrões: 20 s no pré-flop, 30 s no pós-flop, 30 s por cartão, 2 cartões iniciais, +1 por intervalo,
  até 6 por decisão. Pode mudar com o torneio rodando.
- **"Começa no nível"** usa o número que a TV mostra, sem contar os intervalos.
- **Saldo é calculado, não gravado:** iniciais + bônus dos intervalos já começados + eventos. Não há
  rotina de crédito. Quem entra tarde recebe o mesmo que os demais.
- **Reentrada recomeça os cartões.** Cada evento guarda o `rebuy_count` do momento e o saldo só soma
  os da entrada atual. Estornar a reentrada traz o saldo anterior de volta.
- **Cartões não passam de um dia para o outro.**
- **Time bank exige eliminação por mesa.** Na eliminação em massa o sistema não sabe quem saiu, e a
  lista da mesa mostraria quem já foi embora. Esses torneios têm só o relógio.

## Técnica

- **O relógio roda no tablet** (`utils/relogioDeAcao.js`). O toque responde na hora e a rede do salão
  não para a contagem. O servidor guarda só a configuração e o uso dos cartões.
- **Cartão usado fica no aparelho até o servidor confirmar** (`hooks/useFilaDeCartoes.js`). O id nasce
  no tablet, e `time_bank_events.client_event_id` é único: reenviar não desconta de novo.
- **Lista da mesa ao vivo** por Realtime, com leitura de segurança a cada 30 s e uma releitura quando
  o nível acaba, porque a virada de nível não muda nada no banco.
- **Mesas com relógio aberto** vêm do Presence do Realtime: nada vai ao banco.
- **Acesso:** a chave `table_clock` abre só o tablet. Crie um grupo "Dealer" com ela em Funcionários e
  entre com esse login nos tablets. Ajustar saldo e configurar é de `tables`, `tournaments` ou
  `employees`.

## Publicar

A migração é `db/migrations/database_migration_relogio_de_mesa.sql`. Ela só cria tabelas novas: se o
deploy vier antes dela, só a tela do relógio fica fora. Antes de usar no clube, teste num tablet real:
tela sempre acesa, som e toque só dá para conferir no aparelho.
