/**
 * T21 冒烟③：工具面——一句话要求「先 describe 画布再 render 卡片」，
 * 断言 describe/render 两个工具按序完成（input-available 顺序 +
 * 双方 output-available + 无 output-error），证明 24 个 core tools 在线、
 * system prompt（render/JSX 导向）生效。
 *
 * 前置（与 tool-smoke.mjs 相同）：
 *  - vite dev server 已起（pi 后端为其 spawn 的子进程，1420 端口）
 *  - OPENROUTER_API_KEY 已在环境（set -a; source .dianjing/key-env; set +a）
 *  - 7600 桥需要执行端：若桥不在线，脚本自开一个 headless Chromium 挂着
 *    app 页面当 keeper（跑完关闭）
 * 运行：node spikes/s-pi/backend-smoke/t21/tools-smoke.mjs [baseUrl]
 * 退出码 0 = 全过。
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { chromium } from "@playwright/test";

const base = process.argv[2] ?? "http://localhost:1420";
const sessionId = `t21-tools-${Date.now()}`;

const failures = [];
function check(label, cond, detail) {
  if (cond) console.log(`  PASS ${label}`);
  else {
    console.log(`  FAIL ${label}${detail ? ` — ${detail}` : ""}`);
    failures.push(label);
  }
}

function resolveChromiumExecutable() {
  if (process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH) {
    return process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH;
  }
  const cache = join(homedir(), "AppData", "Local", "ms-playwright");
  const candidates = readdirSync(cache)
    .filter((d) => d.startsWith("chromium_headless_shell-"))
    .sort()
    .reverse();
  for (const dir of candidates) {
    const exe = join(
      cache,
      dir,
      "chrome-headless-shell-win64",
      "chrome-headless-shell.exe",
    );
    if (existsSync(exe)) return exe;
  }
  return undefined;
}

function discoveryPath() {
  if (process.platform === "win32") {
    const local =
      process.env.LOCALAPPDATA?.trim() || join(homedir(), "AppData", "Local");
    return join(local, "OpenPencil", "mcp.json");
  }
  if (process.platform === "darwin") {
    return join(
      homedir(),
      "Library",
      "Application Support",
      "OpenPencil",
      "mcp.json",
    );
  }
  const xdg = process.env.XDG_RUNTIME_DIR?.trim();
  return join(xdg || join(homedir(), ".dianjing"), "mcp.json");
}

async function bridgeHealth() {
  let disco;
  try {
    disco = JSON.parse(readFileSync(discoveryPath(), "utf8"));
  } catch {
    return null;
  }
  if (!disco?.httpPort) return null;
  return fetch(`http://127.0.0.1:${disco.httpPort}/health`)
    .then((r) => r.json())
    .catch(() => null);
}

async function post(text, sid = sessionId) {
  const res = await fetch(`${base}/api/pi-chat`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      sessionId: sid,
      // T100：spec 必填——seed openrouter/free，spike 一致沿用此档位
      model: { providerId: "openrouter", modelId: "openrouter/free" },
      messages: [{ role: "user", parts: [{ type: "text", text }] }],
    }),
  });
  if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
  const raw = await res.text();
  const chunks = [];
  let sawDone = false;
  for (const frame of raw.split("\n\n")) {
    const line = frame.split("\n").find((l) => l.startsWith("data:"));
    if (!line) continue;
    const data = line.slice(5).trimStart();
    if (data === "[DONE]") {
      sawDone = true;
      continue;
    }
    chunks.push(JSON.parse(data));
  }
  return { chunks, sawDone };
}

function textOf(chunks) {
  return chunks
    .filter((c) => c.type === "text-delta")
    .map((c) => c.delta)
    .join("");
}

console.log(`T21 工具面冒烟 → ${base}  session=${sessionId}`);

check("前置：OPENROUTER_API_KEY 在环境", !!process.env.OPENROUTER_API_KEY);

// ── 桥执行端：不在线则自开 headless 浏览器挂着 app 当 keeper
let keeper = null;
if ((await bridgeHealth())?.status !== "ok") {
  const browser = await chromium.launch({
    executablePath: resolveChromiumExecutable(),
    args: ["--enable-unsafe-swiftshader"],
  });
  const page = await browser.newPage();
  await page.goto(base, { waitUntil: "domcontentloaded" });
  let up = false;
  for (let i = 0; i < 60 && !up; i++) {
    await page.waitForTimeout(500);
    up = (await bridgeHealth())?.status === "ok";
  }
  check("桥执行端：自开 keeper 页面后 7600 桥在线", up);
  keeper = { browser };
} else {
  check("桥执行端：7600 桥已在线（复用）", true);
}

try {
  // openrouter/free 工具调用有模型方差：≤3 次换 session 重试
  // （2026-08-24 补跑实证第二种方差：模型在目标工具之外多发畸形调用——
  //  pi-ai validation.js 对未注册 toolCall.name 抛 Tool not found → 多出
  //  tool-output-error 帧。同一重试预算内容忍，末次仍错才 FAIL）
  let round = null;
  for (let attempt = 1; attempt <= 3; attempt++) {
    const sid = attempt === 1 ? sessionId : `${sessionId}-r${attempt}`;
    round = await post(
      "请严格按顺序执行两步：第一步调用 describe 工具描述当前页面；第二步调用 render 工具渲染一个简单卡片（FRAME 内含一个文本「T21」）。两个工具都必须实际调用，不要只描述计划。完成后回复「已完成」。",
      sid,
    );
    const tools = round.chunks
      .filter((c) => c.type === "tool-input-available")
      .map((c) => c.toolName);
    const hasError = round.chunks.some((c) => c.type === "tool-output-error");
    if (tools.includes("describe") && tools.includes("render") && !hasError)
      break;
    console.log(
      `  … 第 ${attempt} 次未达标（工具：${tools.join(",") || "无"}，错误帧：${hasError}），换 session 重试`,
    );
  }

  const types = round.chunks.map((c) => c.type);
  const inputTools = round.chunks
    .filter((c) => c.type === "tool-input-available")
    .map((c) => c.toolName);
  // output 帧不带 toolName（mapping.ts 线格式：type/toolCallId/output），
  // 经 input-available 的 toolCallId → toolName 反查归属
  const nameByCallId = new Map(
    round.chunks
      .filter((c) => c.type === "tool-input-available")
      .map((c) => [c.toolCallId, c.toolName]),
  );
  const outputTools = round.chunks
    .filter((c) => c.type === "tool-output-available")
    .map((c) => nameByCallId.get(c.toolCallId) ?? "?");
  const errors = round.chunks.filter((c) => c.type === "tool-output-error");

  check("帧序列 start 为首帧", types[0] === "start", types.join(","));
  check(
    "describe 先于 render 被调用（工具顺序）",
    inputTools.indexOf("describe") !== -1 &&
      inputTools.indexOf("render") !== -1 &&
      inputTools.indexOf("describe") < inputTools.indexOf("render"),
    inputTools.join(","),
  );
  check(
    "describe/render 均有 output-available",
    outputTools.includes("describe") && outputTools.includes("render"),
    outputTools.join(","),
  );
  check(
    "无 tool-output-error",
    errors.length === 0,
    JSON.stringify(errors[0]?.errorText ?? "").slice(0, 200),
  );
  check(
    "render 产出含节点 id（桥真实执行）",
    (() => {
      const renderCallId = [...nameByCallId.entries()].find(
        ([, name]) => name === "render",
      )?.[0];
      const out = round.chunks.find(
        (c) =>
          c.type === "tool-output-available" && c.toolCallId === renderCallId,
      );
      return typeof out?.output?.id === "string";
    })(),
    JSON.stringify(
      round.chunks
        .filter((c) => c.type === "tool-output-available")
        .map((c) => c.output),
    ).slice(0, 200),
  );
  check(
    "finish(stop) 收尾 + [DONE]",
    round.chunks.at(-1)?.type === "finish" && round.sawDone,
  );
  check("助手有文本回复", textOf(round.chunks).length > 0);
} finally {
  await keeper?.browser.close();
}

if (failures.length) {
  console.error(`\nFAIL ${failures.length} 项：${failures.join(" / ")}`);
  process.exit(1);
}
console.log("\nT21 工具面冒烟全过");
