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

Três instâncias contra o mesmo Postgres e MiniStack (portas 3001 a 3003):

```bash
docker compose up -d --build
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
| `bun run test:concurrency` | paralelismo real, múltiplos processos |
| `bun run test:docker` | a suíte inteira dentro de um container Linux |

No Windows, o SIGTERM não chega ao processo filho, então os testes de encerramento gracioso são pulados no host. `bun run test:docker` roda tudo em Linux.
