# Plano de Treino - App pessoal

App web de página única (single-file) para registrar treinos, volume e composição corporal.
Roda como PWA no iPhone (adicionado à tela de início pelo Safari), funciona offline e guarda
tudo localmente no aparelho via `localStorage`.

---

## Arquivos

| Arquivo | O que é |
| --- | --- |
| `index.html` | O app inteiro: HTML, CSS e JS num arquivo só. Sem build, sem dependências. |
| `manifest.json` | Metadados do PWA (nome, ícone, cores, modo standalone). |
| `sw.js` | Service worker. Network-first no HTML, cache-first no resto. |
| `icon-192.png` / `icon-512.png` | Ícones do app. |
| `proxy/cloudflare-worker.js` | Proxy opcional que guarda a chave da API como secret (não é servido pelo Pages; deploy manual na Cloudflare). |

Não há build step, bundler, npm ou framework. Abrir o `index.html` já é o app.

---

## Como publicar / atualizar

Repositório: `github.com/bernafrc/Treino`. Duas hospedagens possíveis a partir dele:

- **Cloudflare Pages (recomendado)**: conectado ao repo via git, faz deploy sozinho a cada
  push. Vantagem decisiva: serve `functions/api/messages.js` como Pages Function — o proxy
  da chave da IA no mesmo domínio do app (o app detecta sozinho; secret `ANTHROPIC_API_KEY`
  em Settings → Variables and Secrets do projeto).
- **GitHub Pages** (`bernafrc.github.io/Treino`): serve os arquivos estáticos, mas NÃO roda a
  pasta `functions/` — nele o motor IA precisa de chave no aparelho ou do worker avulso.

Para atualizar:

1. Commit + push no repositório (as duas hospedagens atualizam sozinhas).
2. Se mudou o shell do app, subir `CACHE_VERSION` em `sw.js` (ex: `treino-v2` -> `treino-v3`)
   para que os usuários recebam a versão nova em vez do cache antigo.
3. Aguardar ~1 min. O PWA na tela de início pega a atualização sozinho na próxima abertura.

**Migração de aparelho/domínio**: `localStorage` é por domínio. Ao trocar de hospedagem
(github.io → pages.dev), levar os dados pelo próprio app: HIST → BACKUP → copiar no antigo,
HIST → IMPORTAR → colar no novo, e adicionar o PWA novo à tela de início.

Rodar localmente:

```bash
python3 -m http.server 8000
# abrir http://localhost:8000
```

Precisa ser servido por http para o service worker registrar. Via `file://` o app funciona,
mas sem offline (o registro é ignorado de propósito).

---

## O plano de treino

Programa de 22/08/2026, remontado a partir da análise de 36 sessões (mai-ago): 7 dias,
quarta virou Pernas A, dois dias de perna de verdade, braço concentrado na quinta.
Abdômen 2x (seg/qui), panturrilha 2x (qua/dom).

| Dia | Treino |
| --- | --- |
| Segunda | Peito + Tríceps + Abdômen |
| Terça | Costas + Bíceps |
| Quarta | Pernas A (quadríceps) + Panturrilha |
| Quinta | Braços + Abdômen |
| Sexta | Ombros (dia curto) |
| Sábado | Peito + Costas (2ª frequência) + pesagem em jejum |
| Domingo | Pernas B (posterior/glúteo) + Panturrilha |

Objetivo: hipertrofia, recomposição corporal, estética. Treinos úteis até ~45 min
(sábado e domingo podem ser mais longos). Cardio pós-treino: 15-20 min de caminhada inclinada.
Progressão dupla: dentro da faixa busca reps; fechou o topo em todas as séries, sobe 2-2,5kg
e volta pro piso. Evitar falha absoluta em toda série.

Regra anti-buraco (semana ruim): inegociáveis são SEG, TER, SEX e os dois dias de perna.
QUI e SÁB caem primeiro. Meta da barra fixa: escada de ajuda 18→15→12→9→6→3→livre, um degrau
a cada 1-2 semanas.

O app suporta plano de 6 ou 7 dias: a aba QUA só aparece se o plano ativo tiver treino na
quarta (`PLAN_DAYS` com QUA opcional em `validatePlanShape`/`normalizePlan`/schema da IA).

---

## Funcionalidades

- **Registro por série**: cada série guarda peso e repetições individualmente. O app pré-preenche
  com a série anterior ou com o mesmo exercício da última sessão.
- **Volume**: `peso × reps` somado por exercício e por sessão. O histórico compara cada sessão
  com a sessão anterior *do mesmo dia de treino* e mostra a variação percentual.
- **Gráficos por exercício**: toque no nome do exercício abre a evolução (volume ou peso máximo).
- **Descanso baseado em relógio**: ao salvar uma série, mostra tempo restante + horário de início
  e fim. Ver "Decisões técnicas" abaixo.
- **Aba CORPO**: peso, % gordura, % massa magra, cintura e gordura visceral. Massa magra e massa
  gorda em kg são derivadas. Gráfico com seletor de métrica. Lembrete de bioimpedância na sexta.
- **Histórico**: sessões com volume, notas e detalhamento por exercício.
- **Backup**: exportar/importar via texto JSON (copiar e colar).
- **Exportar PDF**: gera um relatório e chama a impressão nativa (no iOS: Compartilhar > Salvar em PDF).
- **Troca de treino entre dias (⇆ no topo do dia)**: em qualquer dia dá pra fazer outro treino
  da semana — os dois dias trocam de lugar (nada some). Modo "só esta semana" usa `wo_daymap_v1`
  (permutação aba→dia do plano, expira na segunda seguinte, local ao aparelho); modo
  "permanente" regrava o plano (clonando `DEFAULT_WORKOUTS` antes de mutar) e sincroniza.
  Avisa se a troca colar perna com perna (heurística /PERNA/ no título, incluindo DOM→SEG).
  O histórico grava o `workoutId` do treino FEITO (dia do plano), não o dia da semana — os
  deltas de volume continuam comparando treino com treino.
- **ⓘ por exercício**: campo `info` explica por que o exercício está naquele dia e o que o
  diferencia dos parecidos. Planos da IA vêm com `info` gerado.
- **Peso da barra**: exercícios de barra livre têm `bar` (20 olímpica, 10 W); o registro da
  série mostra a conta "barra + anilhas (X/lado)" a partir do total digitado. O histórico
  segue guardando o total. Na troca por alternativa, a dica some (a alt pode não ser barra).
- **Resumo pós-treino**: ao finalizar, abre um resumo copiável (exercício, marcação de
  halter-por-lado / total-com-barra / graviton-ajuda, séries, volume, duração) pra colar no
  Google Health ou onde quiser.
- **Abdômen e panturrilha**: abdômen como finisher em TODO dia sem perna (SEG/TER/QUI/SEX/SAB,
  tipos rotacionados), panturrilha nos dias de perna (QUA em pé/gastrocnêmio, DOM sentado/sóleo).
- **Troca de exercício na hora (⇄)**: cada exercício tem 4-6 alternativas similares (`alts`),
  incluindo variações de equipamento (barra/halter/máquina/polia). A troca vale só para o dia
  (vive em `current.swaps`, morre ao finalizar/zerar) e o histórico grava o nome do exercício
  realmente feito. O plano fixo continua sendo o padrão de cada dia novo.
- **Motor IA (aba GUIA)**: regenera o plano inteiro com a API da Anthropic usando o plano atual,
  o histórico recente, as medidas e as notas de sessão. Mostra preview antes de aplicar, com
  opção de voltar ao plano original a qualquer momento.
- **Importar treino colado (aba GUIA)**: cola um treino em qualquer formato — texto do personal,
  treino gerado em outro chat, ou JSON do próprio app. JSON válido aplica direto (sem API);
  texto livre é convertido pela IA para o formato do plano (preservando exercícios, séries e
  reps, distribuindo pelos dias e explicando o mapeamento no resumo). Depois do preview e do
  aplicar, o app já cai na aba do dia. Histórico, medidas e recordes não são tocados.
- **Análise do personal IA (aba HIST)**: escolhe "a partir de quando" (atalhos 30/60/90 dias
  ou tudo) e a IA analisa as sessões do período série a série: progressos com números,
  estagnação, desequilíbrios de volume, consistência, dores citadas nas notas. Resultado em
  veredito/progressos/problemas/recomendações, salvo em `wo_analysis_v1` (reabre sem gastar).
  A próxima geração de plano lê a última análise automaticamente.
- **Fitbit (aba GUIA)**: OAuth guardado no servidor (Durable Object) — nenhum token no
  aparelho. Rotas do worker: `/api/fitbit/authurl` (com cookie de state), `/callback`
  (troca o code e salva), `/status`, `/weight` (peso+%gordura dos últimos ≤31 dias, unidades
  métricas via `Accept-Language: pt_BR`), `/activity` (registra musculação com
  `activityName`+`manualCalories`≈6kcal/min), `/unlink`. Todas menos o callback exigem o
  `x-sync-token`. Refresh token do Fitbit é de uso único — renovação acontece dentro do DO
  (single-thread, sem corrida). Secrets: `FITBIT_CLIENT_ID`/`FITBIT_CLIENT_SECRET`
  (app pessoal em dev.fitbit.com, redirect `<origem>/api/fitbit/callback`). No app: puxar
  peso pro CORPO (dias já registrados localmente vencem) e envio automático do treino
  finalizado como atividade.
- **Histórico na nuvem (aba GUIA)**: treinos, medidas, plano e análise sincronizados entre
  aparelhos via `POST /api/sync` no worker (Durable Object SQLite, instância única "main").
  Autenticação por código: secret `SYNC_TOKEN` no worker + o mesmo código colado em cada
  aparelho. Sincroniza no boot, ao voltar pro app e após cada mudança (debounce 1,5s); offline
  não perde nada, converge na próxima. Só ativo quando o app roda no domínio do worker.

---

## Decisões técnicas (contexto importante)

**Descanso calculado pelo relógio, não por contagem.**
O iOS congela o JavaScript quando o PWA vai para segundo plano, então um `setInterval` contando
90, 89, 88... volta errado. O app guarda `restEndTs` (timestamp de término) e recalcula a
diferença contra `Date.now()` a cada tick e no evento `visibilitychange`. Sair do app e voltar
mostra o tempo correto. **Não trocar por contagem regressiva simples.**
Limitação aceita: sem notificação/vibração com o app fechado (PWA no iOS não permite).

**Tempos de descanso** (`restSecondsFor`): compostos pesados 120s, compostos médios 90s,
isoladores 60s, finishers (abdômen/panturrilha) 45s. Definidos por nome de exercício em
`REST_120` / `REST_90` / `REST_45_FIN`, com 60s como padrão. Exercícios podem trazer `rest`
próprio (planos gerados pela IA trazem), que vence as tabelas. Numa troca de exercício, o
descanso continua sendo o do slot planejado (mesmo papel no treino).

**Steppers (+/-) sem roubar o scroll.**
No iOS, o botão +/- tirava o foco do input, fechava o teclado e o Safari jogava a página para
baixo. Três proteções: `touch-action: manipulation` em todo botão (mata o double-tap zoom),
`preventDefault` no `mousedown` de `.stepper` (não rouba foco do input) e as sheets salvam
`window.scrollY` ao abrir e restauram ao fechar (`openSheetById`/`closeAllSheets`).
**Não abrir sheet com `classList.add` direto; usar `openSheetById`.**

**Motor IA — dois modos de credencial.**
`aiGenerate()`/`importPlanText()` chamam a Messages API via `fetch` com streaming SSE, modelo
`claude-opus-5`, structured outputs (`output_config.format` com JSON Schema do plano) e fallback
de recusa habilitado (`fallbacks: "default"` + beta `server-side-fallback-2026-07-01`; se der
400, refaz sem o beta). A resposta é validada/clampada em `normalizePlan` antes do preview;
nada é aplicado sem confirmação. `WORKOUTS` é `let`: plano salvo em `wo_plan_v1` vence o
`DEFAULT_WORKOUTS` no boot (com `validatePlanShape` de guarda).

- **Modo proxy do site (recomendado — zero configuração).** Hospedado no Cloudflare Pages,
  `functions/api/messages.js` vira a rota `POST /api/messages` no mesmo domínio. O app sonda
  essa rota no boot (GET → 405 = existe; pulado em `*.github.io`) e usa sozinho. A chave mora
  como **secret** do projeto Pages — o equivalente de `.env` — e nenhum aparelho guarda nada.
- **Modo proxy manual.** O campo "URL do proxy" aponta para um Cloudflare Worker avulso
  ([`proxy/cloudflare-worker.js`](proxy/cloudflare-worker.js), instruções no topo do arquivo).
  Para quando o app está em hospedagem sem functions (GitHub Pages). URL manual vence a
  detecção automática.
- **Modo direto (fallback).** Sem proxy, a chave vai em `localStorage` (`wo_apikey_v1`) e a
  chamada sai direto do navegador com `anthropic-dangerous-direct-browser-access: true` (o que
  libera CORS). Aceitável por ser chave do próprio usuário, mas o proxy é melhor.
- **Não colocar a chave em `.env` com build/injeção**: numa página estática publicada, qualquer
  valor injetado no JS fica público. `.env` de verdade = secret do worker.

**Confirmação própria, sem `confirm()` nativo.**
Alguns navegadores embutidos (Documents by Readdle, previews em sandbox) bloqueiam
`window.confirm()`, o que fazia o botão de apagar não funcionar. Todas as confirmações usam
`askConfirm(msg, callback, label)`, que abre uma bottom sheet do próprio app.
**Não reintroduzir `confirm()` nativo.**

**Backup sem download.**
O botão de baixar arquivo disparava aviso de "link externo" em navegadores embutidos. O backup
é texto selecionável + botão copiar. **Não voltar a usar `URL.createObjectURL` + `<a download>`.**

**Graviton (barra fixa assistida).**
Nesses exercícios o peso lançado é a *assistência da máquina*, então menos peso = mais forte.
A lógica de recorde é invertida (`minWeightForExercise`), o rótulo do input vira "AJUDA" e o
gráfico tem a métrica de assistência. Marcados com `graviton: true` no objeto do exercício.

**Persistência.**
Chaves em `localStorage`: `wo_current_v5` (treino em andamento, incl. `swaps` do dia),
`wo_history_v5` (sessões finalizadas), `wo_bodyweight_v5` (medidas), `wo_active_v5` (aba ativa),
`wo_plan_v1` (plano gerado/importado), `wo_plan_meta_v1` (data + resumo da geração),
`wo_planstamp_v1` (quando o plano mudou, pro LWW do sync), `wo_apikey_v1` (chave no modo
direto), `wo_aiinst_v1` (instruções pro personal), `wo_proxy_v1` (URL do proxy manual),
`wo_analysis_v1` (última análise), `wo_synctoken_v1` (código de sincronização),
`wo_tombs_v1` (deleções pendentes de subir), `wo_lastsync_v1`.
Há migração de histórico das versões v3/v4 e carimbo de `id` em itens antigos sem id (o sync
exige). Ao mudar o formato dos dados, subir a versão e escrever a migração.

**Regras do merge de sincronização (worker.js, `TreinoStore`).**
União por id para treinos/medidas — um aparelho com cópia velha nunca apaga nada do servidor.
Deleções viram lápides (`t:<id>`) que impedem o item de ressuscitar. Plano usa `planStamp`
(mais novo vence; `plan: null` com stamp novo = voltou ao original). Análise usa `generatedAt`.
O cliente substitui o estado local pela resposta consolidada e zera as lápides locais.
**Não trocar por "última escrita vence" no blob inteiro — perde dados de aparelho atrasado.**

**Sem localStorage em ambiente de artifact.**
O app foi feito para rodar hospedado. Em previews que bloqueiam storage ele degrada, mas o alvo
é o PWA no Safari.

---

## Estrutura do código (`index.html`)

Ordem dentro da tag `<script>`:

1. `WORKOUTS` - o plano inteiro como objeto. Editar aqui muda os treinos.
2. `TABS`, `GRAVITON_NAMES`, tabelas de descanso.
3. Chaves de storage, carregamento de estado, migração.
4. Helpers (volume, formatação de data/peso, buscas no histórico).
5. Render: `render()` despacha para `renderWorkout` / `renderHistory` / `renderBody` / `renderGuide`.
6. Gráficos: `lineChartSVG` desenha SVG inline (sem biblioteca).
7. Sheets/modais: registro de série, progresso, corpo, backup, confirmação.
8. Ações: salvar série, finalizar treino, medidas, backup, `exportPDF`.
9. Motor de descanso.
10. Registro do service worker.

Tudo é renderizado via template string e `innerHTML`. Não há framework, estado reativo ou
virtual DOM: qualquer mudança de dado chama `saveAll()` e depois `render()`.

---

## Ideias não implementadas

- Notificação quando o descanso acaba (bloqueado pelo iOS em PWA).
- Sincronização entre dispositivos (hoje o backup é manual, por texto).
- Deload / periodização automática.
- Gráfico de volume semanal agregado por grupo muscular.
