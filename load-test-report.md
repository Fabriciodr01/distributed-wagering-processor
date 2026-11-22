# Relatório do teste de carga

Gerado por `bun run test:load` (`scripts/load-test.ts`).

## Ambiente

- **Data:** 2026-11-22T09:24:08.514Z
- **CPU:** AMD Ryzen 5 5600G with Radeon Graphics × 12 núcleos; memória 15.4 GiB
- **Bun:** 1.4.4; **PostgreSQL:** PostgreSQL 16.16; **MiniStack:** 1.5.43
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
- **(d) hot wallet 2×:** 600 apostas de 0.01 numa única wallet com 96 requisições em voo (o dobro de (a)).

## Resultados

| Métrica | (a) hot wallet | (b) espalhado | (c) 10% duplicatas | (d) hot wallet 2× |
|---|---|---|---|---|
| Requisições em voo (cliente) | 48 | 48 | 48 | 96 |
| Requisições | 600 | 1000 | 1000 | 600 |
| Duração | 6.62 s | 2.58 s | 2.16 s | 4.42 s |
| Throughput | 90.7 req/s | 387.2 req/s | 462.5 req/s | 135.8 req/s |
| p50 | 556.3 ms | 101.2 ms | 99.5 ms | 692.1 ms |
| p95 | 980.9 ms | 267.5 ms | 158.6 ms | 789.0 ms |
| p99 | 1.15 s | 295.3 ms | 183.6 ms | 838.2 ms |
| Taxa de erro (5xx/rede) | 0.00% | 0.00% | 0.00% | 0.00% |
| Status HTTP | 200: 600 | 200: 1000 | 200: 1000 | 200: 600 |
| Resultado | PROCESSED: 600 | PROCESSED: 1000 | PROCESSED: 1000 | PROCESSED: 600 |
| Replays idempotentes | 0 | 0 | 100 | 0 |
| Conflitos de lock (timeout/deadlock) | 0 / 0 | 0 / 0 | 0 / 0 | 0 / 0 |
| Espera do lock: média | 254.1 ms | 16.7 ms | 21.1 ms | 205.2 ms |
| Espera do lock: p95 (bucket) | ≤ 1.00 s | ≤ 100.0 ms | ≤ 100.0 ms | ≤ 500.0 ms |
| Espera do lock: máx (bucket) | ≤ 1.00 s | ≤ 250.0 ms | ≤ 250.0 ms | ≤ 500.0 ms |
| Primeiro 503 | nenhum | nenhum | nenhum | nenhum |
| Lag da outbox (pico) | 6.66 s | 4.56 s | 5.67 s | 5.27 s |
| Tempo para drenar a outbox | 1.71 s | 4.78 s | 6.00 s | 4.75 s |

## Invariantes no fim

- Wallets conferidas: 62
- Saldo ≠ ledger: 0
- Reconciliação inconsistente: 0
- Saldo negativo: 0
- **OK**

## Análise

A hot wallet fez 90.7 req/s, contra 387.2 req/s com as apostas espalhadas em 40 wallets. A diferença é esperada e é escolha de desenho (ARCHITECTURE.md, D-04): toda transação que move saldo começa com `SELECT … FOR UPDATE` na linha da wallet, então as apostas da mesma wallet são serializadas e o throughput dela é limitado pelo tempo de uma transação, não pelo número de instâncias. O histograma de espera mostra isso: média de 254.1 ms de espera pelo lock na hot wallet contra 16.7 ms no cenário espalhado. Os contadores de conflito ficam em zero porque, com lock pessimista, a disputa aparece como espera e não como timeout ou deadlock.

Com wallets diferentes as transações andam em paralelo, e o limite passa a ser a máquina: aqui cliente, três instâncias, Postgres e MiniStack dividem a mesma CPU, então os números servem para comparar cenários, não como capacidade de produção. No cenário de duplicatas, 100 reenvios voltaram como replay (mesmo resultado, sem segundo débito), atendidos pela mesma transação curta do caminho normal.

A outbox é publicada por três publishers concorrentes (lease + `SKIP LOCKED`; ordem por wallet best effort, D-08); o lag sobe durante a rajada e volta a zero logo depois dela, no tempo de drenagem da tabela. Na hot wallet a drenagem levou 1.71 s em (a).

Com o dobro da concorrência do cliente (96 em voo, cenário (d)) **não houve 503**: 0 lock_timeout, espera máxima pelo lock ≤ 500.0 ms (bucket). O throughput foi 135.8 req/s (contra 90.7 em (a)) e o p99 838.2 ms (contra 1.15 s). Essa comparação não isola a concorrência: (a) é o primeiro cenário e roda com as instâncias frias (JIT e pools de conexão ainda aquecendo), e (d) é o último. O que (d) mostra com segurança é que dobrar a concorrência do cliente não gerou 503 nem aumentou a espera pelo lock.

A espera pelo lock não cresce junto com a concorrência do cliente. No máximo 3 instâncias × 10 conexões = 30 transações podem estar na fila do lock da mesma wallet ao mesmo tempo, porque cada uma ocupa uma conexão do pool. As demais requisições esperam por uma conexão dentro da aplicação, sem segurar lock nenhum, e essa espera não conta para o `lock_timeout`. O 503 por lock_timeout só começa quando uma única transação espera mais que 5 s, ou seja, quando (transações na frente dela) × (tempo de cada uma com o lock) > 5 s. Medido aqui, cada transação da hot wallet segura o lock por ≈ 7.4 ms, então seriam precisas ≈ 679 esperas simultâneas, bem acima das 30 que o pool permite. Na prática, o 503 aparece se o pool total crescer muito (mais instâncias × conexões numa wallet só) ou se a transação ficar lenta (Postgres saturado, ou uma sessão segurando o lock).

**Por que 5 s.** É o teto de quanto uma transação aceita esperar pela linha da wallet:
- **folga para a contenção normal:** na hot wallet a espera pelo lock fica em ≤ 1.00 s no p95 e a maior foi ≤ 1.00 s em (a) e ≤ 500.0 ms em (d). Com 5 s, disputa normal nunca vira 503. Um limite apertado (ex.: 500 ms) transformaria fila em erro, e cada 503 volta como reenvio do provedor, aumentando a carga na mesma wallet;
- **teto para o caso anormal:** se uma sessão segura o lock por muito tempo, quem espera desiste em 5 s, devolve a conexão ao pool e recebe 503 com `Retry-After`. Sem esse teto, uma wallet travada prenderia conexões do pool indefinidamente e afetaria as outras wallets da instância;
- **cabe nos outros prazos:** fica bem abaixo do visibility timeout da fila (30 s) e do timeout típico de um cliente HTTP, então a falha é transitória e explícita (retry com backoff) em vez de a mensagem expirar e ser reentregue por baixo. E fica acima do `deadlock_timeout` do Postgres (1 s), então um deadlock real é detectado e repetido (D-04) antes de o lock_timeout disparar.
