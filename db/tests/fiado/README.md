# Testes dos triggers do fiado (banco descartável)

Os testes do backend usam o FakeSupabase, que **não executa trigger nem CHECK**. As regras de
dinheiro do fiado moram no banco, então são testadas aqui, num Postgres 17 local e descartável
(nunca no servidor do dia a dia, nunca em prod).

```powershell
$bin = "C:\Program Files\PostgreSQL\17\bin"; $d = "$env:TEMP\pgfiado"
& "$bin\initdb.exe" -D $d -U postgres --auth=trust -E UTF8 --locale=C
& "$bin\pg_ctl.exe" -D $d -o "-p 55432" -l "$d\pg.log" start
& "$bin\psql.exe" -U postgres -p 55432 -c "CREATE DATABASE fiado"
& "$bin\psql.exe" -U postgres -p 55432 -d fiado -v ON_ERROR_STOP=1 -f db\tests\fiado\00_stub.sql
& "$bin\psql.exe" -U postgres -p 55432 -d fiado -v ON_ERROR_STOP=1 -f db\migrations\database_migration_fiado_fase0.sql
& "$bin\psql.exe" -U postgres -p 55432 -d fiado -v ON_ERROR_STOP=1 -f db\migrations\database_migration_fiado_fase0b_check.sql
& "$bin\psql.exe" -U postgres -p 55432 -d fiado -v ON_ERROR_STOP=1 -f db\migrations\database_migration_fiado_fase3_premio.sql
& "$bin\psql.exe" -U postgres -p 55432 -d fiado -v ON_ERROR_STOP=1 -f db\tests\fiado\02_cenarios.sql   # termina em "TODOS OS TESTES PASSARAM"
& "$bin\psql.exe" -U postgres -p 55432 -d fiado -v ON_ERROR_STOP=1 -f db\tests\fiado\04_premio.sql     # "FASE 3: TODOS OS TESTES PASSARAM"
```

- `04_premio.sql` — prêmio de torneio desconta o fiado: transação bruta + `prize_offset` no mesmo
  INSERT, abatimento acima da dívida recusa o prêmio inteiro, `prize_offset` solto recusado, prêmio
  com abatimento imutável e não estornável.

- `00_stub.sql` — recorte fiel do schema de prod (colunas, triggers e políticas vigentes em 2026-10-22).
- `02_cenarios.sql` — limite, abatimento líquido na gaveta, estornos, vencido (FIFO), ataques diretos
  com JWT de funcionário, isolamento entre orgs, conferência saldo = Σ extrato e gaveta = Σ ledger.
- `03_*` — corrida: rodar `03_setup_corrida.sql` depois dos cenários e `03_corrida.sql` em dois psql
  ao mesmo tempo (`-v quem=A -v espera=3` e, logo depois, `-v quem=B -v espera=0`): a segunda venda
  espera a trava da conta e é recusada por limite; só uma fica gravada.
