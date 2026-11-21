# Relatório do teste de carga

Gerado por `bun run test:load` (`scripts/load-test.ts`).

## Ambiente

- **Data:** 2026-11-21T21:19:30.567Z
- **CPU:** Intel(R) Xeon(R) Processor @ 2.30GHz × 2 núcleos; memória 7.8 GiB
- **Bun:** 1.4.4; **PostgreSQL:** PostgreSQL 16.15 (Ubuntu 16.15-0ubuntu0.24.04.1); **MiniStack:** 1.5.43
- **Instâncias:** 3 processos (HTTP + publisher da outbox + worker), pool de 10 conexões cada
- **Concorrência do cliente:** 48 requisições em voo, distribuídas em rodízio entre as instâncias
- Cliente, aplicação, Postgres e MiniStack na mesma máquina (o cliente disputa CPU com o servidor).

## Metodologia

- Banco e filas exclusivos, criados na infraestrutura de teste (`bun run infra:test:up`), com todas as migrations.
- 3 instâncias reais em processos separados (`bun src/main.ts`), todas sobre o mesmo Postgres e MiniStack.
- Cada cenário roda com um pool de 48 requisições em voo; cada requisição é um `POST /wagering/transactions` com `Idempotency-Key`.
- Latência medida no cliente, da requisição à resposta completa. Erro = 5xx ou falha de rede.
- Conflitos de lock e espera do lock vêm de `/metrics` das três instâncias (diferença antes/depois do cenário).
- O lag da outbox é amostrado a cada 250 ms durante o cenário; o tempo de drenagem conta do fim das requisições até não haver evento não publicado.
- No fim: saldo = ledger para todas as wallets (no banco) e `POST /wallets/:id/reconciliation` para cada uma.

- **(a) hot wallet:** 600 apostas de 0.01 numa única wallet, 3 instâncias.
- **(b) espalhado:** 40 wallets × 25 apostas de 1.00, ordem aleatória.
- **(c) 10% duplicatas:** 1000 requisições em 20 wallets; 10% reenviam uma anterior.

## Resultados

| Métrica | (a) hot wallet | (b) espalhado | (c) 10% duplicatas |
|---|---|---|---|
| Requisições | 600 | 1000 | 1000 |
| Duração | 6.21 s | 3.85 s | 3.57 s |
| Throughput | 96.7 req/s | 259.9 req/s | 280.3 req/s |
| p50 | 406.3 ms | 174.4 ms | 169.1 ms |
| p95 | 1.09 s | 323.2 ms | 274.5 ms |
| p99 | 1.57 s | 390.8 ms | 331.3 ms |
| Taxa de erro (5xx/rede) | 0.00% | 0.00% | 0.00% |
| Status HTTP | 200: 600 | 200: 1000 | 200: 1000 |
| Resultado | PROCESSED: 600 | PROCESSED: 1000 | PROCESSED: 1000 |
| Replays idempotentes | 0 | 0 | 100 |
| Conflitos de lock (timeout/deadlock) | 0 / 0 | 0 / 0 | 0 / 0 |
| Espera do lock: média | 260.0 ms | 28.8 ms | 37.6 ms |
| Espera do lock: p95 (bucket) | ≤ 1.00 s | ≤ 250.0 ms | ≤ 250.0 ms |
| Lag da outbox (pico) | 3.69 s | 3.58 s | 3.60 s |
| Tempo para drenar a outbox | 341.5 ms | 3.25 s | 3.43 s |

## Invariantes no fim

- Wallets conferidas: 61
- Saldo ≠ ledger: 0
- Reconciliação inconsistente: 0
- Saldo negativo: 0
- **OK**

## Análise

A hot wallet fez 96.7 req/s, contra 259.9 req/s com as apostas espalhadas em 40 wallets. A diferença é esperada e é escolha de desenho (ARCHITECTURE.md, D-05): toda transação que move saldo começa com `SELECT … FOR UPDATE` na linha da wallet, então as apostas da mesma wallet são serializadas e o throughput dela é limitado pelo tempo de uma transação, não pelo número de instâncias. O histograma de espera mostra isso: média de 260.0 ms de espera pelo lock na hot wallet contra 28.8 ms no cenário espalhado. Os contadores de conflito ficam em zero porque, com lock pessimista, a disputa aparece como espera e não como timeout ou deadlock.

Com wallets diferentes as transações andam em paralelo, e o limite passa a ser a máquina: aqui cliente, três instâncias, Postgres e MiniStack dividem a mesma CPU, então os números servem para comparar cenários, não como capacidade de produção. No cenário de duplicatas, 100 reenvios voltaram como replay (mesmo resultado, sem segundo débito), atendidos pela mesma transação curta do caminho normal.

A outbox é publicada por três publishers concorrentes (lease + `SKIP LOCKED`); o lag sobe durante a rajada e volta a zero logo depois dela, no tempo de drenagem da tabela.
