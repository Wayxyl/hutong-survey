/**
 * Cloudflare Worker: 问卷数据收集代理
 * 前端 POST /record → 本 Worker 用 GitHub token 把答卷写入仓库 data/ 目录
 * 管理端 GET /stats → 查看已收集答卷数(需输入管理口令)
 */

const GITHUB_OWNER = "Wayxyl";
const GITHUB_REPO = "hutong-survey";
const DATA_DIR = "data";

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // CORS 预检
    if (request.method === "OPTIONS") {
      return cors(new Response(null, { status: 204 }));
    }

    // 提交答卷
    if (url.pathname === "/record" && request.method === "POST") {
      return handleRecord(request, env);
    }

    // 查看统计(简单口令保护)
    if (url.pathname === "/stats" && request.method === "GET") {
      return handleStats(request, env);
    }

    // 读取全部答卷(供 shuju.html 后台统计)
    if (url.pathname === "/data" && request.method === "GET") {
      return handleAllData(request, env);
    }

    return cors(new Response("Not found", { status: 404 }));
  },
};

async function handleRecord(request, env) {
  try {
    const payload = await request.json();
    // 基本校验:必须含 answers 数组
    if (!payload || !Array.isArray(payload.answers) || payload.answers.length === 0) {
      return cors(json({ ok: false, error: "invalid payload" }, 400));
    }

    const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const path = `${DATA_DIR}/response-${id}.json`;
    const content = btoa(unescape(encodeURIComponent(JSON.stringify(payload, null, 2))));

    const res = await fetch(
      `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/contents/${path}`,
      {
        method: "PUT",
        headers: {
          Authorization: `Bearer ${env.GH_TOKEN}`,
          Accept: "application/vnd.github+json",
          "Content-Type": "application/json",
          "User-Agent": "survey-worker",
        },
        body: JSON.stringify({
          message: `问卷提交 ${id}`,
          content,
        }),
      }
    );

    if (res.status === 201) {
      return cors(json({ ok: true, id }));
    }
    const errText = await res.text();
    return cors(json({ ok: false, error: `github ${res.status}`, detail: errText.slice(0, 200) }, 502));
  } catch (e) {
    return cors(json({ ok: false, error: String(e) }, 400));
  }
}

async function handleStats(request, env) {
  const url = new URL(request.url);
  if (url.searchParams.get("key") !== env.ADMIN_KEY) {
    return cors(json({ ok: false, error: "unauthorized" }, 401));
  }
  const res = await fetch(
    `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/contents/${DATA_DIR}`,
    {
      headers: {
        Authorization: `Bearer ${env.GH_TOKEN}`,
        Accept: "application/vnd.github+json",
        "User-Agent": "survey-worker",
      },
    }
  );
  if (!res.ok) return cors(json({ ok: false, error: `github ${res.status}` }, 502));
  const files = await res.json();
  const responses = files.filter(f => f.name.startsWith("response-") && f.name.endsWith(".json"));
  return cors(json({ ok: true, count: responses.length, files: responses.map(f => f.name) }));
}

/**
 * 读取全部答卷(供后台 shuju.html 做图表统计)
 * GET /data?key=ADMIN_KEY
 * 逐份拉取 GitHub raw 内容,返回 { ok, count, responses: [{submittedAt, answers}] }
 */
async function handleAllData(request, env) {
  const url = new URL(request.url);
  if (url.searchParams.get("key") !== env.ADMIN_KEY) {
    return cors(json({ ok: false, error: "unauthorized" }, 401));
  }
  const listRes = await fetch(
    `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/contents/${DATA_DIR}`,
    {
      headers: {
        Authorization: `Bearer ${env.GH_TOKEN}`,
        Accept: "application/vnd.github+json",
        "User-Agent": "survey-worker",
      },
    }
  );
  if (!listRes.ok) return cors(json({ ok: false, error: `github ${listRes.status}` }, 502));
  const files = await listRes.json();
  const targets = files.filter(f => f.name.startsWith("response-") && f.name.endsWith(".json"));

  // 并发拉取所有答卷
  const responses = await Promise.all(
    targets.map(async f => {
      try {
        const r = await fetch(f.download_url, { headers: { "User-Agent": "survey-worker" } });
        if (!r.ok) return null;
        return await r.json();
      } catch (e) {
        return null;
      }
    })
  );

  const valid = responses.filter(Boolean);
  // 按提交时间排序(早→晚)
  valid.sort((a, b) => String(a.submittedAt || "").localeCompare(String(b.submittedAt || "")));
  return cors(json({ ok: true, count: valid.length, responses: valid }));
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });
}

function cors(res) {
  res.headers.set("Access-Control-Allow-Origin", "*");
  res.headers.set("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.headers.set("Access-Control-Allow-Headers", "Content-Type");
  return res;
}
