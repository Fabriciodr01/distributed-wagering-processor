# Distributed Wagering Processor

Serviço financeiro distribuído que processa transações de apostas recebidas de múltiplos provedores de jogos.

Stack: Bun 1.4.4, TypeScript (strict), NestJS 12, PostgreSQL 16, MikroORM 7, AWS SQS (MiniStack) e Docker Compose.

## Pré-requisitos

- [Bun](https://bun.com) 1.4.4 (versão em `.bun-version`)
- Docker com Docker Compose

## Rodando localmente

```bash
bun install
cp .env.example .env
bun run infra:up        # postgres + ministack
bun run infra:init      # cria as filas FIFO e a DLQ
bun run db:migrate
bun run start:dev       # http://localhost:3000/health/ready
```

Três instâncias contra o mesmo Postgres e MiniStack (portas 3001 a 3003). O `--wait` só volta quando as filas e as migrations terminaram e `app1..app3` estão healthy (`/health/ready`):

```bash
docker compose up -d --build --wait
curl -s localhost:3001/health/ready   # idem 3002 e 3003
docker compose down -v
```

## Testes

Os testes de integração e concorrência usam PostgreSQL e MiniStack reais, em portas próprias (5433 e 4567). Cada suíte cria o próprio banco e as próprias filas.

```bash
bun run infra:test:up
bun run check           # typecheck + unidade + integração + concorrência
bun run infra:test:down
```

| Comando | O que roda |
|---|---|
| `bun run test:unit` | domínio e regras puras |
| `bun run test:integration` | PostgreSQL e MiniStack reais, HTTP real |
| `bun run test:concurrency` | paralelismo real: `Promise.all` contra o Postgres e 3 processos da aplicação ao mesmo tempo, crash após o commit, restart com consistência eventual |
| `bun run test:docker` | a suíte inteira dentro de um container Linux |

No Windows, o SIGTERM não chega ao processo filho, então os testes de encerramento gracioso são pulados no host. `bun run test:docker` roda tudo em Linux.

Toda suíte termina conferindo, para todas as wallets do banco, que o saldo materializado é igual ao saldo reconstruído pelo ledger.

### Cenários obrigatórios ↔ testes

Os 8 cenários de concorrência da seção 13 do enunciado:

| # | Cenário | Teste |
|---|---|---|
| 1 | Mesma aposta 50 vezes em paralelo → um débito | `tests/concurrency/wagering-concurrency.test.ts` — "a mesma aposta 50 vezes em paralelo gera um único débito" |
| 2 | Operações concorrentes disputando o saldo da mesma wallet | `tests/concurrency/wagering-concurrency.test.ts` — "100.00 e duas apostas de 80.00", "hot wallet"; `tests/concurrency/reversal-concurrency.test.ts` |
| 3 | Wallets distintas em paralelo | `tests/concurrency/wagering-concurrency.test.ts` — "wallets distintas…"; `tests/concurrency/multi-instance.test.ts` — "wallets distintas em paralelo, espalhadas pelas instâncias" |
| 4 | Pelo menos 3 processos/instâncias simultâneos | `tests/concurrency/multi-instance.test.ts` (HTTP com a mesma aposta nas 3 instâncias, wallets distintas, fila com redeliveries) |
| 5 | Worker morto depois do commit e antes do ack | `tests/concurrency/crash-after-commit.test.ts` (`FAULT_KILL_AFTER_COMMIT`) |
| 6 | Dois publishers na mesma outbox | `tests/integration/outbox/outbox-publisher.test.ts` — "dois publishers sobre a mesma outbox…"; `tests/concurrency/multi-instance.test.ts` (3 publishers) |
| 7 | ROLLBACK/REFUND antes da referência | `tests/integration/workers/pending-reference.test.ts` — "REFUND chega antes da BET…", "dois workers sobre as mesmas pendências…" |
| 8 | Restart com prova de consistência eventual | `tests/concurrency/restart-eventual-consistency.test.ts`; `tests/integration/sqs/wager-transactions-consumer.test.ts` — "falha transitória (Postgres fora)…" |

## Arquitetura

Decisões e trade-offs, códigos de falha, mapeamento HTTP, interpretações do enunciado e limitações estão em [`ARCHITECTURE.md`](ARCHITECTURE.md).
