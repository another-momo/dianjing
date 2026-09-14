/**
 * T21 冒烟②b（A2 浏览器实证）：设置 UI 改向全链——
 * 打开 app → AI 聊天页 → 设置齿轮 → ModelsPanel 在 pi 模式渲染
 * PiModelsPanel → provider 目录来自后端 catalog → UI 存 key →
 * auth.json 落盘 → 状态灯翻 configured → design 模型指派保存 →
 * 聊天输入框标签显示所指派模型 → 清理（清除 key）。
 *
 * key 卫生：脚本 env 读取、只经页面输入框传输，不打印；断言输出不含 key。
 *
 * 前置：vite dev server 已起（T25 D3 后门退役）。
 * 运行：node spikes/s-pi/backend-smoke/t21/settings-smoke.mjs [baseUrl]
 * 退出码 0 = 全过。
 */

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { chromium } from "@playwright/test";

const base = process.argv[2] ?? "http://localhost:1420";
const root = process.cwd();
const KEY = process.env.OPENROUTER_API_KEY ?? "";
const authPath = join(root, ".dianjing", "pi-agent", "auth.json");

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

const failures = [];
function check(label, cond, detail) {
  if (cond) console.log(`  PASS ${label}`);
  else {
    console.log(`  FAIL ${label}${detail ? ` — ${detail}` : ""}`);
    failures.push(label);
  }
}

console.log(`T21 设置 UI 冒烟 → ${base}`);

check(
  "前置：OPENROUTER_API_KEY 在脚本环境（只经页面输入框传输）",
  KEY.length > 0,
);
if (KEY.length === 0) process.exit(1);

const browser = await chromium.launch({
  executablePath: resolveChromiumExecutable(),
  args: ["--enable-unsafe-swiftshader"],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
const consoleErrors = [];
page.on("console", (msg) => {
  if (msg.type() === "error") consoleErrors.push(msg.text().slice(0, 200));
});
page.on("pageerror", (err) =>
  consoleErrors.push(`pageerror: ${String(err).slice(0, 200)}`),
);

// 冒烟开始前确保 openrouter 无存量 stored key（前序运行可能残留）。
// 注意：dev server 环境有 OPENROUTER_API_KEY 时 pi 解析顺序 auth.json→env
// 会让状态灯恒为 configured——存储态只能以 auth.json 文件为准。
// T28：后端全端点鉴权后直连 7700 无 token 会 401——改走 1420 proxy（自动补头）。
if (existsSync(authPath)) {
  const doc = JSON.parse(readFileSync(authPath, "utf8"));
  if (doc?.openrouter) {
    await fetch(`${base}/api/pi/credentials`, {
      method: "DELETE",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ providerId: "openrouter" }),
    }).catch(() => null);
  }
}
check(
  "初始存储态：auth.json 无 openrouter 条目",
  (() => {
    if (!existsSync(authPath)) return true;
    return JSON.parse(readFileSync(authPath, "utf8"))?.openrouter === undefined;
  })(),
);

try {
  await page.goto(base, { waitUntil: "domcontentloaded" });
  await page.getByRole("tab", { name: "设计" }).waitFor({ timeout: 20000 });

  // AI 聊天页 → 设置齿轮（openSettingsDialog('ai')）
  await page.getByRole("tab", { name: "AI" }).click();
  await page.locator('[data-test-id="provider-settings-trigger"]').click();
  await page
    .locator('[data-test-id="app-settings-dialog"]')
    .waitFor({ timeout: 10000 });

  // pi 模式分支：渲染 PiModelsPanel 而非旧 profile 列表
  const panel = page.locator('[data-test-id="pi-providers-panel"]');
  check("设置页渲染 PiModelsPanel（pi 分支）", await panel.isVisible());
  check(
    "旧 profile 列表不再渲染",
    (await page.locator('[data-test-id="settings-model-list"]').count()) === 0,
  );

  // provider 目录来自后端 catalog
  const routerRow = page.locator(
    '[data-test-id="pi-provider-row"][data-provider-id="openrouter"]',
  );
  await routerRow.waitFor({ timeout: 10000 });
  check("catalog 目录：openrouter 行渲染", await routerRow.isVisible());

  // UI 存 key → auth.json 落盘 → 状态灯 configured
  // （env key 在时状态灯恒 configured，存储态断言以 auth.json 为准；
  //  落盘断言必须等 save POST 回包——env key 让状态灯提前为真，
  //  只等灯会抢在 POST 在途时读盘，2026-08-24 补跑实证此竞态）
  await routerRow.click();
  const keyInput = page.locator('[data-test-id="pi-key-input"]');
  await keyInput.waitFor({ timeout: 5000 });
  await keyInput.fill(KEY);
  const saveResponse = page.waitForResponse(
    (res) =>
      res.url().includes("/api/pi/credentials") &&
      res.request().method() === "POST",
    { timeout: 15000 },
  );
  await page.locator('[data-test-id="pi-key-save"]').click();
  await saveResponse;
  await page.waitForFunction(
    () =>
      document
        .querySelector('[data-provider-id="openrouter"] [data-state]')
        ?.getAttribute("data-state") === "configured",
    { timeout: 15000 },
  );
  check("UI 存 key 后状态灯 configured", true);

  check(
    "auth.json 落盘且为 pi 格式（key 匹配，不打印）",
    (() => {
      if (!existsSync(authPath)) return false;
      const doc = JSON.parse(readFileSync(authPath, "utf8"));
      return (
        doc?.openrouter?.type === "api_key" && doc?.openrouter?.key === KEY
      );
    })(),
  );

  // design 模型指派：openrouter + 首个模型 + 保存
  await page
    .locator('[data-test-id="pi-design-provider-select"]')
    .selectOption("openrouter");
  const modelSelect = page.locator('[data-test-id="pi-design-model-select"]');
  await modelSelect.waitFor({ timeout: 5000 });
  const firstModel = await modelSelect
    .locator("option")
    .first()
    .getAttribute("value");
  check(
    "design 模型下拉已随 provider 填充",
    typeof firstModel === "string" && firstModel.length > 0,
  );
  await page.locator('[data-test-id="pi-design-save"]').click();

  // 关掉设置 → 聊天输入框标签显示所指派模型
  await page.keyboard.press("Escape");
  const chatLabel = page.locator('[data-test-id="chat-pi-model-label"]');
  await chatLabel.waitFor({ timeout: 10000 });
  const labelText = (await chatLabel.textContent()) ?? "";
  check(
    "聊天输入框标签显示所指派模型",
    typeof firstModel === "string" && labelText.includes(firstModel),
    labelText.slice(0, 80),
  );

  // 清理：清除 openrouter stored key（env key 仍会让状态灯保持
  // configured，故清理断言只看 auth.json 文件；等 DELETE 回包再读盘——
  // 与存 key 段同一竞态，固定 1.5s 等待在慢机器上不可靠）
  await page.locator('[data-test-id="provider-settings-trigger"]').click();
  await page
    .locator('[data-test-id="pi-provider-row"][data-provider-id="openrouter"]')
    .click();
  const clearResponse = page.waitForResponse(
    (res) =>
      res.url().includes("/api/pi/credentials") &&
      res.request().method() === "DELETE",
    { timeout: 15000 },
  );
  await page.locator('[data-test-id="pi-key-clear"]').click();
  await clearResponse;
  check(
    "清理：UI 清除 key 后 auth.json 不再含 openrouter",
    (() => {
      if (!existsSync(authPath)) return true;
      return (
        JSON.parse(readFileSync(authPath, "utf8"))?.openrouter === undefined
      );
    })(),
  );

  const fatal = consoleErrors.filter(
    (e) => !/canvaskit|webgpu|font|WebGL|swiftshader|deprecat/i.test(e),
  );
  check("无致命 console 错误", fatal.length === 0, fatal[0]);
} finally {
  await browser.close();
}

if (failures.length) {
  console.error(`\nFAIL ${failures.length} 项：${failures.join(" / ")}`);
  process.exit(1);
}
console.log("\nT21 设置 UI 冒烟全过");
