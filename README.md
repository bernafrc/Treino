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

O app está hospedado no GitHub Pages. Para atualizar:

1. Substituir `index.html` no repositório e fazer commit.
2. Se mudou o shell do app, subir `CACHE_VERSION` em `sw.js` (ex: `treino-v1` -> `treino-v2`)
   para que os usuários recebam a versão nova em vez do cache antigo.
3. Aguardar ~1 min. O PWA na tela de início pega a atualização sozinho na próxima abertura.

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
  reps, distribuindo pelos 6 dias e explicando o mapeamento no resumo). Depois do preview e do
  aplicar, o app já cai na aba do dia. Histórico, medidas e recordes não são tocados.

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

- **Modo proxy (recomendado — chave fora do aparelho).** O campo "URL do proxy" aponta para um
  Cloudflare Worker ([`proxy/cloudflare-worker.js`](proxy/cloudflare-worker.js), instruções de
  deploy no topo do arquivo). A chave mora lá como **secret** — o equivalente de `.env` para
  página estática — e o navegador chama o worker sem credencial nenhuma. `ALLOWED_ORIGINS` no
  worker limita quem pode usar (GitHub Pages + localhost).
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
`wo_apikey_v1` (chave da API no modo direto), `wo_aiinst_v1` (instruções pro personal),
`wo_proxy_v1` (URL do proxy).
Há migração de histórico das versões v3/v4. Ao mudar o formato dos dados, subir a versão e
escrever a migração.

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
