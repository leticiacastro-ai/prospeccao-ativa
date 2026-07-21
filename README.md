# Prospecção Ativa

Dashboard de funil de prospecção outbound (Instagram) integrado ao CRM **Datacrazy**.
Mostra, por SDR e por período, quantos leads foram prospectados, responderam, agendaram,
compareceram e viraram cliente.

Rodava na Vercel; hoje roda numa VPS com PM2 (`ecosystem.config.js`), processo contínuo via `server.js`.

## Como funciona

### Fluxo de dados

1. `server.js` sobe um servidor HTTP puro (sem framework) que serve o `index.html` e expõe as rotas em `api/*.js`. Cada arquivo em `api/` tem assinatura `(req, res)` igual função serverless da Vercel — o mesmo código roda local e (se algum dia voltar) na Vercel, sem duplicar lógica.
2. `api/dados.js` é a peça central: busca leads na API do Datacrazy, filtra e agrega por SDR.
3. Só conta lead que:
   - tem `attendant`/`atendente` cujo nome está cadastrado na aba "Cadastro de SDR" (`api/sdrs.js`, lista em `data/sdrs.json`);
   - tem a tag `ig-outbound`.
4. A etapa do funil de cada lead é a **maior** tag batida no mapa `RANK` (`dados.js:31`):
   `ig-outbound`(1) → `respondeu outbound`(2) → `status-agendado/no-show/cancelado/reagendado/excluida`(3) → `status-compareceu`(4) → `cliente ativo`(5).
   Ou seja, agendamento cancelado/no-show/reagendado ainda conta como "agendou", só não avança pra "compareceu".
5. Front-end (`index.html`) só faz `fetch` nas rotas e renderiza — toda regra de negócio fica no servidor.

### Rotas (`api/`)

| Rota | Faz o quê |
|---|---|
| `GET /api/dados?periodo=...` | dados agregados por SDR pro período pedido |
| `GET /api/export?periodo=...` | mesmo resultado, em CSV |
| `GET /api/resumo` | média dos últimos 100 dias (painel separado, só lê cache) |
| `GET /api/progresso` | status de uma busca em andamento (barra de progresso) |
| `GET/POST/PUT/DELETE /api/sdrs` | cadastro de quem conta como SDR |
| `GET /api/cron-aquecer`, `/api/cron-hoje` | **vestígio da era Vercel** — não usados mais na VPS (ver abaixo) |

### Contagem trava no atendente/cadastro daquele dia

Dia fechado guarda, junto com os leads brutos, uma **foto de quem estava cadastrado como SDR
naquele momento** (`data/sdrs-cadastro-dia/AAAA-MM-DD.json`, `api/armazenamento.js`). A
agregação (`agregar` em `dados.js`) usa essa foto pra decidir quem conta em cada dia fechado —
não o cadastro atual. Isso evita que cadastrar um SDR novo hoje mude retroativamente o total
("Leads prospectados") de um dia que já fechou. A foto é atualizada de novo a cada revalidação
(últimos 14 dias, ver acima); depois disso trava de vez, junto com o resto do dia. Dia de hoje
(ainda não fechou) e dia fechado sem foto salva (cache de antes dessa trava existir) continuam
usando o cadastro atual, igual era antes.

### Cache por dia — o motor de tudo

Buscar o histórico inteiro no Datacrazy a cada troca de filtro seria lento e estouraria o
rate limit (120 req/min). Por isso `dados.js` separa por **dia fechado** vs **hoje**:

- **Dia fechado (ontem pra trás):** buscado uma vez, salvo em `data/leads-dia/AAAA-MM-DD.json`
  (`api/armazenamento.js`) e nunca mais re-buscado — exceto os últimos 14 dias, que são
  **revalidados toda madrugada** (`revalidarDiasRecentes`, `DIAS_GRACA_REVALIDACAO=14`), porque
  um lead pode avançar no funil (ex.: reunião marcada hoje só acontece amanhã) depois do dia em
  que foi criado. Passado esse prazo de 14 dias o dia fica travado de vez.
- **Hoje:** guardado em memória (`cacheHoje`), atualizado no máximo 1x a cada 5 min
  (`TTL_HOJE`), tanto por request quanto por um `setInterval` em background
  (`server.js` chama `agendarAtualizacaoHoje()` no boot).
- **Histórico não tem teto:** `DIAS_HISTORICO_MINIMO = 100` é só o **piso** — profundidade do
  backfill inicial (`aquecerDiasFechados`) e a janela fixa do painel de média
  (`/api/resumo`, sempre olha os últimos 100 dias fechados). Nada é apagado: a partir do deploy,
  cada dia fechado novo só se soma aos que já existem (101, 102, 103 dias de histórico e assim
  por diante, pra sempre). Isso foi uma mudança deliberada — antes existia uma limpeza
  (`limparDiasAntigos`) que apagava dia mais velho que 100, foi removida.
- **Aquecimento:** `agendarAquecimentoDiario` roda `rodarManutencaoDoCache` (busca dias fechados
  faltando + revalida os 14 recentes) uma vez no boot e todo dia às 5h — assim quem abre o
  dashboard de manhã já acha os números prontos.

**Resposta à pergunta "pega os últimos X dias corretamente e mantém esses X dias":** sim, o
filtro "Últimos N dias" (`faixaDeData` em `dados.js:103-133`) calcula `hoje - (N-1)` dias, ou
seja N dias incluindo hoje (esse off-by-one já foi corrigido, ver commit `6faade4`). O histórico
guardado na base é pelo menos 100 dias (garantido no deploy) e só cresce depois disso, nunca
encolhe.

### Proteções contra rate limit / timeout

- Fila única (`comFila`) — só uma busca no Datacrazy por vez, mesmo com vários requests
  simultâneos.
- `buscarComPaciencia` — em 429, espera o `Retry-After` (ou backoff) e tenta de novo, até 8
  tentativas.
- Devolve resultado **parcial** (com header `X-Dados-Parcial`) em vez de travar, se rate limit ou
  timeout cortar a busca no meio.
- `EM_SERVERLESS` ajusta pausas e orçamento de tempo — mais paciente rodando local/VPS
  (processo contínuo) do que rodaria na Vercel Hobby (10s por function).

## Estrutura

```
server.js              servidor HTTP local, roteia pra api/*.js, agenda os jobs
api/dados.js            busca+cache+agregação (peça central)
api/armazenamento.js    onde o cache de cada dia é salvo (arquivo local / KV / memória)
api/sdrs.js              cadastro de quem conta como SDR
api/export.js            mesmo resultado de /api/dados, em CSV
api/resumo.js             média histórica (100 dias)
api/progresso.js          status de busca em andamento
api/cron-aquecer.js       [não usado na VPS] endpoint pro Vercel Cron
api/cron-hoje.js          [não usado na VPS] endpoint pro Vercel Cron
index.html                front-end (dashboard, comparação de períodos, cadastro de SDR)
data/leads-dia/*.json     cache por dia fechado
data/sdrs-cadastro-dia/*.json  foto do cadastro de SDR no dia em que cada dia fechou (trava a contagem)
data/sdrs.json             lista de SDRs cadastrados (a atual, "ao vivo")
ecosystem.config.js        config do PM2 (mantém server.js sempre no ar na VPS)
```

## Rodando

```
npm install
cp .env.example .env   # preencher DATACRAZY_API_KEY
npm start                # ou: pm2 start ecosystem.config.js
```

Variáveis de ambiente (`.env`):

- `DATACRAZY_API_KEY` — token do Datacrazy (obrigatório, sem ele `/api/dados` responde erro).
- `DATACRAZY_API_URL` — default `https://api.g1.datacrazy.io`.
- `PORT` — default `3000`.
- `KV_REST_API_URL` / `KV_REST_API_TOKEN` — só relevante se algum dia voltar pra Vercel com KV;
  na VPS o cache é sempre em arquivo (`data/leads-dia/`).
- `CRON_SECRET` — só usado pelas rotas `cron-*`, hoje inertes na VPS.

Na VPS, quem mantém o cache do dia atualizado e faz o aquecimento de madrugada é o próprio
`server.js` (via `agendarAquecimentoDiario`/`agendarAtualizacaoHoje`, chamados no boot), **não**
um cron externo — por isso o processo precisa ficar de pé continuamente (PM2 com
`autorestart: true` cuida disso).

## O que verifiquei sobre a lógica

- **Filtro de período**: cálculo de "últimos N dias", "hoje", "ontem", "este mês" e
  "intervalo" está correto e sem off-by-one (`dados.js:103-133`).
- **Cache por dia**: dia fechado só é buscado uma vez; hoje é refrescado a cada 5 min; últimos
  14 dias são revalidados toda madrugada pra pegar avanço tardio no funil. Lógica consistente
  entre boot, agendamento diário e o próprio filtro do usuário.
- **Histórico**: piso de 100 dias garantido a partir do deploy, sem teto — nada é apagado, a base
  só cresce (101, 102, 103... dias). Painel de média continua com janela fixa de 100 dias, à parte
  do tamanho real do histórico guardado.
- **Agregação por SDR**: só conta lead com SDR cadastrado + tag `ig-outbound`; etapa é a maior
  tag batida. Taxa de conversão dado por `cliente/prospectou`.
- **Trava por dia (corrigido)**: encontramos e corrigimos um caso em que "Leads prospectados"
  de um dia fechado (ex.: "ontem") crescia sozinho depois de cadastrar um SDR novo na aba
  "Cadastro de SDR" — porque o filtro de quem conta lia o cadastro atual, não o de quando o dia
  fechou. Agora cada dia fechado trava numa foto do cadastro daquele momento (ver seção acima).
  Testado: cadastrar um SDR novo hoje não muda mais o total de um dia já fechado.
- **Pontos de atenção (não são bugs, mas vale saber):**
  - `api/cron-aquecer.js` e `api/cron-hoje.js` não têm mais função na VPS (não existe
    `vercel.json` no projeto) — só fariam algo se algum dia voltar pra Vercel com Cron
    configurado. Podem ficar como estão (documentam a era anterior) ou ser removidos.
  - Comentário de `api/resumo.js` fala em "últimos 60 dias", mas o código (`DIAS_RETENCAO`) e a
    UI usam 100 dias — comentário desatualizado, sem efeito no comportamento real.
  - Sem suíte de teste automatizada — `test-dropdown.js` é um script manual de Playwright pra
    conferir o dropdown de período, não roda em CI.
