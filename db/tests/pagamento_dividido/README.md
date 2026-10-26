# Testes do pagamento dividido (banco descartável)

O FakeSupabase dos testes do backend **não executa CHECK nem função SQL**. A coerência das partes
(`payment_split` somando o valor, `payment_method = 'split'`) e a soma por meio da RPC moram no
banco, então são testadas aqui, num Postgres 17 local e descartável (nunca em prod).

```powershell
$bin = "C:\Program Files\PostgreSQL\17\bin"; $d = "$env:TEMP\pgsplit"
& "$bin\initdb.exe" -D $d -U postgres --auth=trust -E UTF8 --locale=C
& "$bin\pg_ctl.exe" -D $d -o "-p 55433" -l "$d\pg.log" start
& "$bin\psql.exe" -U postgres -p 55433 -c "CREATE DATABASE split"
& "$bin\psql.exe" -U postgres -p 55433 -d split -v ON_ERROR_STOP=1 -f db\tests\pagamento_dividido\00_stub.sql
& "$bin\psql.exe" -U postgres -p 55433 -d split -v ON_ERROR_STOP=1 -f db\migrations\database_migration_pagamento_dividido.sql
& "$bin\psql.exe" -U postgres -p 55433 -d split -v ON_ERROR_STOP=1 -f db\migrations\database_migration_pagamento_dividido.sql   # reaplicável
& "$bin\psql.exe" -U postgres -p 55433 -d split -v ON_ERROR_STOP=1 -f db\tests\pagamento_dividido\01_cenarios.sql   # "TODOS OS TESTES PASSARAM"
& "$bin\pg_ctl.exe" -D $d stop; Remove-Item -Recurse -Force $d
```

- `00_stub.sql` — recorte de `transactions`, `cash_transactions`, `payment_methods` e `tournaments`
  (colunas e CHECKs vigentes em 2026-10-26), com linhas antigas sem divisão.
- `01_cenarios.sql` — a função de validação (soma, centavos, texto, repetido, `split`, zero), os
  CHECKs do torneio e do cash (prêmio, crédito, fiado e cash-out nunca dividem; valor não muda sem
  as partes), o código reservado e a RPC por meio (partes somadas, `split` nunca aparece, venda
  cancelada sai, total por meio = total das vendas).
