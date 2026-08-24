// Worker do site (Cloudflare, fluxo Workers + assets).
// Os arquivos do app são servidos como assets estáticos automaticamente;
// este script só atende o que NÃO é arquivo — na prática, a rota do proxy:
//
//   POST /api/messages  →  repassa para a API da Anthropic com a chave
//                          guardada como SECRET do worker.
//
// A chave: painel do worker → Settings → Variables and Secrets →
//   Add → tipo Secret → nome ANTHROPIC_API_KEY → valor sk-ant-…
// O app detecta a rota sozinho (GET /api/messages responde 405).

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === '/api/messages') return proxyAnthropic(request, env);
    if (url.pathname === '/api/sync') return handleSync(request, env);
    if (url.pathname.startsWith('/api/fitbit/')) return handleFitbitRoute(request, env, url);
    if (env.ASSETS) return env.ASSETS.fetch(request);
    return new Response('not found', { status: 404 });
  },
};

// ---- Google Health (ex-Fitbit): OAuth + ponte de dados ----
// A plataforma de desenvolvedores do Fitbit foi absorvida pelo Google:
// cadastro no Google Cloud Console (API health.googleapis.com), OAuth do
// Google, dados em https://health.googleapis.com/v4. Tokens ficam no
// Durable Object (servidor), nunca no aparelho.
// Secrets no worker: GOOGLE_CLIENT_ID e GOOGLE_CLIENT_SECRET
// (OAuth client "Web application" com redirect = /api/fitbit/callback).
const GH_SCOPES = 'https://www.googleapis.com/auth/googlehealth.health_metrics_and_measurements.readonly'
  + ' https://www.googleapis.com/auth/googlehealth.activity_and_fitness.writeonly';

async function handleFitbitRoute(request, env, url) {
  const path = url.pathname;

  // callback é navegação do browser vindo do accounts.google.com (GET)
  if (path === '/api/fitbit/callback') return fitbitCallback(request, env, url);

  if (request.method !== 'POST') return new Response('method not allowed', { status: 405 });
  const origin = request.headers.get('Origin');
  if (origin && origin !== url.origin) return new Response('origin not allowed', { status: 403 });
  if (!env.SYNC_TOKEN || (request.headers.get('x-sync-token') || '') !== env.SYNC_TOKEN) {
    return new Response('unauthorized', { status: 401 });
  }

  if (path === '/api/fitbit/authurl') {
    if (!env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET) {
      return jsonResp({ error: { message: 'Configure os secrets GOOGLE_CLIENT_ID e GOOGLE_CLIENT_SECRET no worker (OAuth client no Google Cloud Console).' } }, 500);
    }
    const state = crypto.randomUUID();
    const redirect = url.origin + '/api/fitbit/callback';
    // access_type=offline + prompt=consent garantem refresh_token
    const auth = 'https://accounts.google.com/o/oauth2/v2/auth?response_type=code'
      + '&client_id=' + encodeURIComponent(env.GOOGLE_CLIENT_ID)
      + '&redirect_uri=' + encodeURIComponent(redirect)
      + '&scope=' + encodeURIComponent(GH_SCOPES)
      + '&access_type=offline&prompt=consent'
      + '&state=' + state;
    return new Response(JSON.stringify({ url: auth }), {
      status: 200,
      headers: {
        'content-type': 'application/json',
        // cookie de state: só quem passou pelo authurl (com o código de sync) valida o callback
        'set-cookie': 'fb_state=' + state + '; Max-Age=600; Path=/api/fitbit; HttpOnly; Secure; SameSite=Lax',
      },
    });
  }

  // demais rotas (status/weight/activity/unlink) vivem no Durable Object
  const id = env.STORE.idFromName('main');
  return env.STORE.get(id).fetch(request);
}

async function fitbitCallback(request, env, url) {
  const back = (flag) => new Response(null, {
    status: 302,
    headers: {
      location: url.origin + '/#fitbit=' + flag,
      'set-cookie': 'fb_state=; Max-Age=0; Path=/api/fitbit; HttpOnly; Secure; SameSite=Lax',
    },
  });
  const code = url.searchParams.get('code');
  const state = url.searchParams.get('state');
  const m = (request.headers.get('Cookie') || '').match(/fb_state=([^;]+)/);
  if (!code || !state || !m || m[1] !== state) return back('err');
  if (!env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET) return back('err');

  const resp = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: 'grant_type=authorization_code'
      + '&code=' + encodeURIComponent(code)
      + '&client_id=' + encodeURIComponent(env.GOOGLE_CLIENT_ID)
      + '&client_secret=' + encodeURIComponent(env.GOOGLE_CLIENT_SECRET)
      + '&redirect_uri=' + encodeURIComponent(url.origin + '/api/fitbit/callback'),
  });
  if (!resp.ok) return back('err');
  const j = await resp.json();
  if (!j.refresh_token) return back('err'); // sem refresh não dá pra manter a conexão
  const tok = {
    access_token: j.access_token,
    refresh_token: j.refresh_token,
    expires_at: Date.now() + (j.expires_in || 3600) * 1000,
    linked_at: new Date().toISOString(),
  };
  const id = env.STORE.idFromName('main');
  await env.STORE.get(id).fetch(new Request(url.origin + '/api/fitbit/save', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(tok),
  }));
  return back('ok');
}

// ---- Sincronização: histórico único e permanente ----
// Os dados moram num Durable Object (SQLite) — instância única "main".
// Autenticação: secret SYNC_TOKEN no worker; o app manda o mesmo valor no
// header x-sync-token. Sem o código, ninguém lê nem escreve.
async function handleSync(request, env) {
  if (request.method !== 'POST') return new Response('method not allowed', { status: 405 });

  const origin = request.headers.get('Origin');
  if (origin && origin !== new URL(request.url).origin) {
    return new Response('origin not allowed', { status: 403 });
  }

  if (!env.SYNC_TOKEN) {
    return jsonResp({ error: { message: 'SYNC_TOKEN não configurado: painel do worker → Settings → Variables and Secrets → Add Secret SYNC_TOKEN.' } }, 500);
  }
  if ((request.headers.get('x-sync-token') || '') !== env.SYNC_TOKEN) {
    return new Response('unauthorized', { status: 401 });
  }

  const id = env.STORE.idFromName('main');
  return env.STORE.get(id).fetch(request);
}

function jsonResp(obj, status) {
  return new Response(JSON.stringify(obj), { status: status || 200, headers: { 'content-type': 'application/json' } });
}

// Regras de merge (a fonte da verdade é a união):
// - treinos e medidas: união por id — um aparelho atrasado nunca apaga nada;
// - deleções: lápides (tombstones) por id, pra apagado não ressuscitar;
// - plano e análise: timestamp mais novo vence (planStamp / generatedAt).
export class TreinoStore {
  constructor(state, env) { this.storage = state.storage; this.env = env || {}; }

  async fetch(request) {
    const path = new URL(request.url).pathname;
    if (path.startsWith('/api/fitbit/')) return this.fitbit(request, path);
    return this.handleSync(request);
  }

  // ---- Fitbit (tokens e chamadas ficam todos no servidor) ----
  async fitbit(request, path) {
    let body = {};
    try { body = await request.json(); } catch (e) {}
    const st = this.storage;

    if (path === '/api/fitbit/save') { await st.put('fitbit', body); return jsonResp({ ok: true }); }
    if (path === '/api/fitbit/unlink') { await st.delete('fitbit'); return jsonResp({ ok: true }); }
    if (path === '/api/fitbit/status') {
      const t = await st.get('fitbit');
      return jsonResp({ linked: !!t, since: t ? t.linked_at : null });
    }

    const at = await this.fbAccessToken();
    if (!at) return jsonResp({ error: { message: 'Google Health não conectado (ou a autorização expirou). Use CONECTAR de novo.' } }, 409);
    const h = { authorization: 'Bearer ' + at };
    const GH = 'https://health.googleapis.com/v4/users/me/dataTypes/';

    // lista dataPoints com filtro de tempo; se o filtro der 400, refaz sem filtro
    const listPoints = async (dataType, filterField, sinceIso) => {
      const base = GH + dataType + '/dataPoints?pageSize=1000';
      let r = await fetch(base + '&filter=' + encodeURIComponent(filterField + ' >= "' + sinceIso + '"'), { headers: h });
      if (r.status === 400) r = await fetch(base, { headers: h });
      if (!r.ok) return { error: r.status };
      const j = await r.json();
      return { points: j.dataPoints || [] };
    };
    const sampleDate = (s) => {
      if (!s) return null;
      const c = s.civilTime;
      if (c && c.year) return String(c.year) + '-' + String(c.month || 1).padStart(2, '0') + '-' + String(c.day || 1).padStart(2, '0');
      return s.physicalTime ? String(s.physicalTime).slice(0, 10) : null;
    };

    if (path === '/api/fitbit/weight') {
      const days = Math.min(90, Math.max(1, Math.round(body.days || 30)));
      const sinceIso = new Date(Date.now() - days * 86400000).toISOString();
      const [wres, fres] = await Promise.all([
        listPoints('weight', 'weight.sample_time.physical_time', sinceIso),
        listPoints('body-fat', 'body_fat.sample_time.physical_time', sinceIso),
      ]);
      if (wres.error) return jsonResp({ error: { message: 'Google Health respondeu HTTP ' + wres.error + ' no peso' } }, 502);
      const byDate = {};
      wres.points.forEach((p) => {
        const w = p.weight; if (!w || typeof w.weightGrams !== 'number') return;
        const d = sampleDate(w.sampleTime); if (!d || d < sinceIso.slice(0, 10)) return;
        byDate[d] = { date: d, weight: Math.round(w.weightGrams / 100) / 10 }; // g → kg com 1 casa
      });
      (fres.points || []).forEach((p) => {
        const f = p.bodyFat; if (!f || typeof f.percentage !== 'number') return;
        const d = sampleDate(f.sampleTime);
        if (d && byDate[d]) byDate[d].bf = Math.round(f.percentage * 10) / 10;
      });
      return jsonResp({ entries: Object.values(byDate).sort((a, b) => a.date.localeCompare(b.date)) });
    }

    if (path === '/api/fitbit/activity') {
      const durationMin = Math.max(1, Math.round(body.durationMin || 45));
      const cal = Math.round(durationMin * 6); // estimativa: ~6 kcal/min de musculação
      const id = 'treino-' + Date.now(); // id próprio: minúsculas/números/hífen
      const payload = {
        exercise: {
          interval: {
            startTime: String(body.startIso || new Date(Date.now() - durationMin * 60000).toISOString()),
            endTime: String(body.endIso || new Date().toISOString()),
          },
          exerciseType: 'STRENGTH_TRAINING',
          displayName: String(body.name || 'Musculação').slice(0, 60),
          activeDuration: (durationMin * 60) + 's',
          metricsSummary: { caloriesKcal: cal },
        },
      };
      const ar = await fetch(GH + 'exercise/dataPoints/' + id, {
        method: 'PATCH',
        headers: { ...h, 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      });
      if (!ar.ok) {
        let msg = 'Google Health respondeu HTTP ' + ar.status + ' na atividade';
        try { const ej = await ar.json(); if (ej.error && ej.error.message) msg += ': ' + String(ej.error.message).slice(0, 200); } catch (e) {}
        return jsonResp({ error: { message: msg } }, 502);
      }
      return jsonResp({ ok: true, calories: cal });
    }

    return jsonResp({ error: { message: 'rota desconhecida' } }, 404);
  }

  // Access token válido, renovando no Google se preciso. O DO é single-thread,
  // então não há corrida ao renovar. O Google mantém o mesmo refresh_token
  // (só substitui se mandar um novo).
  async fbAccessToken() {
    const st = this.storage;
    let t = await st.get('fitbit');
    if (!t) return null;
    if (Date.now() < (t.expires_at || 0) - 60000) return t.access_token;
    if (!this.env.GOOGLE_CLIENT_ID || !this.env.GOOGLE_CLIENT_SECRET) return null;
    const resp = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: 'grant_type=refresh_token'
        + '&refresh_token=' + encodeURIComponent(t.refresh_token)
        + '&client_id=' + encodeURIComponent(this.env.GOOGLE_CLIENT_ID)
        + '&client_secret=' + encodeURIComponent(this.env.GOOGLE_CLIENT_SECRET),
    });
    if (!resp.ok) {
      if (resp.status === 400 || resp.status === 401) await st.delete('fitbit'); // autorização morreu: reconectar
      return null;
    }
    const j = await resp.json();
    t = {
      access_token: j.access_token,
      refresh_token: j.refresh_token || t.refresh_token,
      expires_at: Date.now() + (j.expires_in || 3600) * 1000,
      linked_at: t.linked_at,
    };
    await st.put('fitbit', t);
    return t.access_token;
  }

  async handleSync(request) {
    let body;
    try { body = await request.json(); } catch (e) { return jsonResp({ error: { message: 'json inválido' } }, 400); }
    body = body || {};
    const st = this.storage;

    // 1. lápides novas: registra e apaga o item correspondente
    const tombMap = await st.list({ prefix: 't:' });
    const incomingTombs = body.tomb || {};
    for (const id in incomingTombs) {
      if (typeof id !== 'string' || id.length > 80) continue;
      if (!tombMap.has('t:' + id)) await st.put('t:' + id, String(incomingTombs[id]).slice(0, 40));
      tombMap.set('t:' + id, true);
      await st.delete('h:' + id);
      await st.delete('b:' + id);
    }

    // 2. união por id (só adiciona o que o servidor não tem e não foi apagado)
    const addAll = async (items, prefix, idOk) => {
      for (const it of Array.isArray(items) ? items : []) {
        if (!it || typeof it.id !== 'string' || !idOk(it)) continue;
        if (tombMap.has('t:' + it.id)) continue;
        if ((await st.get(prefix + it.id)) === undefined) await st.put(prefix + it.id, it);
      }
    };
    await addAll(body.history, 'h:', (s) => Array.isArray(s.exercises) && s.completedAt);
    await addAll(body.bodyweight, 'b:', (b) => typeof b.weight === 'number' && b.date);

    // 3. plano: stamp mais novo vence (plan null = plano original restaurado)
    const storedStamp = (await st.get('planStamp')) || '';
    const inStamp = String(body.planStamp || '');
    if (inStamp && inStamp > storedStamp) {
      await st.put('planStamp', inStamp);
      if (body.plan) await st.put('plan', { plan: body.plan, meta: body.planMeta || null });
      else await st.delete('plan');
    }

    // 4. análise: generatedAt mais novo vence
    const storedAn = await st.get('analysis');
    if (body.analysis && body.analysis.generatedAt
      && (!storedAn || String(body.analysis.generatedAt) > String(storedAn.generatedAt || ''))) {
      await st.put('analysis', body.analysis);
    }

    // 5. devolve o estado consolidado
    const hist = [...(await st.list({ prefix: 'h:' })).values()]
      .sort((a, b) => String(a.completedAt).localeCompare(String(b.completedAt)));
    const bw = [...(await st.list({ prefix: 'b:' })).values()]
      .sort((a, b) => String(a.date).localeCompare(String(b.date)));
    const planRec = await st.get('plan');
    return jsonResp({
      history: hist,
      bodyweight: bw,
      planStamp: (await st.get('planStamp')) || '',
      plan: planRec ? planRec.plan : null,
      planMeta: planRec ? planRec.meta : null,
      analysis: (await st.get('analysis')) || null,
    });
  }
}

async function proxyAnthropic(request, env) {
  // GET serve de sonda para o app detectar que o proxy existe.
  if (request.method !== 'POST') return new Response('method not allowed', { status: 405 });

  // Mesma origem: bloqueia outros sites tentando usar o endpoint via navegador.
  const origin = request.headers.get('Origin');
  if (origin && origin !== new URL(request.url).origin) {
    return new Response('origin not allowed', { status: 403 });
  }

  if (!env.ANTHROPIC_API_KEY) {
    return new Response(JSON.stringify({ error: { message: 'ANTHROPIC_API_KEY não configurada: painel do worker → Settings → Variables and Secrets → Add Secret.' } }), {
      status: 500, headers: { 'content-type': 'application/json' },
    });
  }

  const headers = {
    'content-type': 'application/json',
    'x-api-key': env.ANTHROPIC_API_KEY,
    'anthropic-version': '2023-06-01',
  };
  const beta = request.headers.get('anthropic-beta');
  if (beta) headers['anthropic-beta'] = beta;

  const upstream = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers,
    body: request.body,
  });

  // Repassa corpo (inclusive streaming SSE) e status.
  return new Response(upstream.body, {
    status: upstream.status,
    headers: { 'content-type': upstream.headers.get('content-type') || 'application/json' },
  });
}
