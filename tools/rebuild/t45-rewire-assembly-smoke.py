"""T45: rewire prompt-assembly-smoke.mjs from brand seed to studio registry."""
import io

p = 'spikes/s-pi/backend-smoke/t24/prompt-assembly-smoke.mjs'
s = io.open(p, encoding='utf-8').read()

subs = [
    # header
    (' *  C2 picked profile → Active style profile 段 + 种子 markdown；bogus id →\n *     re-pick 段；无种子后端 → fallback 段；ui 模式带 pickedProfileId 仍零 overlay',
     ' *  C2 picked profile → Active style profile 段 + profile 正文；bogus id →\n *     re-pick 段；无资产后端 → fallback 段；ui 模式带 pickedProfileId 仍零 overlay'),
    (' *  路由 GET /api/pi/brand/manifest 形状 + 脱敏（无 markdown）+ 405',
     ' *  路由 GET /api/pi/studio/manifest 形状 + 脱敏（无正文/无绝对路径）+ 405\n *\n * T45（S4 W1 / T-A3）改源：种子 config.yaml → studio 文件注册表（workflows/\n * + profiles/ 复制进 tempRoot）；端点更名 /api/pi/studio/manifest，契约改为\n * modes（展开 types）+ profiles（摘要）+ failures（相对路径）。'),
    # layoutRoot
    ('// ── fixture 布置：真实 prompt 段 + brand 种子复制进 tempRoot\nfunction layoutRoot(withBrandSeed) {',
     '// ── fixture 布置：真实 prompt 段 + studio 资产集复制进 tempRoot（T45 改源）\nfunction layoutRoot(withStudioAssets) {'),
    ('''  if (withBrandSeed) {
    mkdirSync(join(tempRoot, 'src/app/ai/pi-backend/brand'), { recursive: true })
    copyFileSync(
      join(repoRoot, 'src/app/ai/pi-backend/brand/config.yaml'),
      join(tempRoot, 'src/app/ai/pi-backend/brand/config.yaml')
    )
  }''',
     '''  if (withStudioAssets) {
    for (const sub of ['workflows', 'profiles']) {
      const srcDir = join(repoRoot, 'src/app/ai/pi-backend/studio', sub)
      mkdirSync(join(tempRoot, 'src/app/ai/pi-backend/studio', sub), { recursive: true })
      for (const f of readdirSync(srcDir)) {
        copyFileSync(join(srcDir, f), join(tempRoot, 'src/app/ai/pi-backend/studio', sub, f))
      }
    }
  }'''),
    ('const tempRoot = layoutRoot(true)\nconst emptySeedRoot = layoutRoot(false)',
     'const tempRoot = layoutRoot(true)\nconst emptyAssetsRoot = layoutRoot(false)'),
    # endpoints
    ('const noAuth = await fetch(`${BASE}/api/pi/brand/manifest`)',
     'const noAuth = await fetch(`${BASE}/api/pi/studio/manifest`)'),
    ('const manifestRes = await fetch(`${BASE}/api/pi/brand/manifest`, { headers: authHeaders(token) })',
     'const manifestRes = await fetch(`${BASE}/api/pi/studio/manifest`, { headers: authHeaders(token) })'),
    # manifest assertions
    ("  check('路由 manifest：200 + 种子名称', manifestRes.ok && manifest.name === '默认品牌库', JSON.stringify(manifest).slice(0, 120))",
     """  check(
    '路由 manifest：modes = general（空 types）+ longform（三 type 展开）',
    manifestRes.ok &&
      Array.isArray(manifest.modes) &&
      manifest.modes[0]?.id === 'general' && manifest.modes[0]?.types?.length === 0 &&
      manifest.modes[1]?.id === 'longform' && manifest.modes[1]?.types?.length === 3 &&
      manifest.modes[1].types.some((t) => t.id === 'ecommerce_detail' && t.size === '750x'),
    JSON.stringify(manifest).slice(0, 160)
  )"""),
    ("""  check(
    '路由 manifest：types 七条齐（wechat_moments 等）',
    Array.isArray(manifest.types) && manifest.types.length === 7 &&
      manifest.types.some((t) => t.id === 'wechat_moments' && t.label === '朋友圈广告')
  )""",
     """  check(
    '路由 manifest：failures 数据面——base 缺失（base.md 相对路径，无绝对路径泄漏）',
    Array.isArray(manifest.failures) &&
      manifest.failures.some((f) => f.kind === 'base' && f.path === 'base.md') &&
      manifest.failures.every((f) => !f.path.includes(':') && !f.path.startsWith('/'))
  )"""),
    ("""  check(
    '路由 manifest：profiles 含 casual_v1 且带 applicableTo',
    Array.isArray(manifest.profiles) &&
      manifest.profiles.some((p) => p.id === 'casual_v1' && p.label === '休闲活泼' && Array.isArray(p.applicableTo))
  )""",
     """  check(
    '路由 manifest：profiles 三精品摘要含 watercolor_poster_v3（applicableTo=[longform]）',
    Array.isArray(manifest.profiles) && manifest.profiles.length === 3 &&
      manifest.profiles.some((p) => p.id === 'watercolor_poster_v3' && p.label === '水彩海报 v3' &&
        Array.isArray(p.applicableTo) && p.applicableTo[0] === 'longform')
  )"""),
    ("""  check(
    '路由 manifest：脱敏——任何 profile 不带 markdown 正文',
    Array.isArray(manifest.profiles) && manifest.profiles.every((p) => !('markdown' in p))
  )""",
     """  check(
    '路由 manifest：脱敏——任何 profile 不带 body/markdown 正文',
    Array.isArray(manifest.profiles) &&
      manifest.profiles.every((p) => !('body' in p) && !('markdown' in p))
  )"""),
    ('const manifest405 = await fetch(`${BASE}/api/pi/brand/manifest`, {',
     'const manifest405 = await fetch(`${BASE}/api/pi/studio/manifest`, {'),
    ('const emptyManifest = await (\n    await fetch(`${BASE2}/api/pi/brand/manifest`, { headers: authHeaders(token2) })\n  ).json()',
     'const emptyManifest = await (\n    await fetch(`${BASE2}/api/pi/studio/manifest`, { headers: authHeaders(token2) })\n  ).json()'),
    ("""  check(
    '路由 manifest：无种子后端 → 空 types/profiles 降级',
    Array.isArray(emptyManifest.types) && emptyManifest.types.length === 0 &&
      Array.isArray(emptyManifest.profiles) && emptyManifest.profiles.length === 0
  )""",
     """  check(
    '路由 manifest：无资产后端 → general 恒在 + 空 profiles + failures 非空（含整体态）',
    Array.isArray(emptyManifest.modes) && emptyManifest.modes.length === 1 &&
      emptyManifest.modes[0]?.id === 'general' &&
      Array.isArray(emptyManifest.profiles) && emptyManifest.profiles.length === 0 &&
      Array.isArray(emptyManifest.failures) &&
      emptyManifest.failures.some((f) => f.kind === 'studio')
  )"""),
    # overlay assertions
    ("  check('C1 marketing：含种子 type 条目（wechat_moments）', mktProbe.includes('- wechat_moments (朋友圈广告)'))",
     "  check('C1 marketing：含注册表 type 条目（ecommerce_detail，含尺寸）', mktProbe.includes('- ecommerce_detail (电商详情页) — 750x'))"),
    ("""    pickedProfileId: 'casual_v1'
  }, token)
  const pickedProbe = probeText(tempRoot) ?? ''
  check('C2 picked：含 Active style profile: casual_v1 段', pickedProbe.includes(`${PROFILE_MARKER} casual_v1`))
  check('C2 picked：含种子 profile markdown 正文（休闲活泼风格）', pickedProbe.includes('# 休闲活泼风格'))""",
     """    pickedProfileId: 'watercolor_poster_v3'
  }, token)
  const pickedProbe = probeText(tempRoot) ?? ''
  check('C2 picked：含 Active style profile: watercolor_poster_v3 段', pickedProbe.includes(`${PROFILE_MARKER} watercolor_poster_v3`))
  check('C2 picked：含 profile 正文（水彩海报）', pickedProbe.includes('# 水彩海报'))"""),
    ("""  check(
    'C2 bogus id：输出 (not in brand config) re-pick 段',
    bogusProbe.includes(`${PROFILE_MARKER} (not in brand config)`) && bogusProbe.includes('bogus_profile')
  )""",
     """  check(
    'C2 bogus id：输出 (not in studio registry) re-pick 段',
    bogusProbe.includes(`${PROFILE_MARKER} (not in studio registry)`) && bogusProbe.includes('bogus_profile')
  )"""),
    ("    chatMode: 'ui',\n    pickedProfileId: 'casual_v1'",
     "    chatMode: 'ui',\n    pickedProfileId: 'watercolor_poster_v3'"),
    # emptySeedRoot → emptyAssetsRoot
    ('const token2 = readBackendToken(emptySeedRoot)', 'const token2 = readBackendToken(emptyAssetsRoot)'),
    ('// 无种子后端（fallback 断言）：同仓库代码、另一端口、另一 rootDir',
     '// 无资产后端（fallback 断言）：同仓库代码、另一端口、另一 rootDir'),
    ("  DIANJING_PI_BACKEND_PORT: String(PORT2),\n  PI_PROMPT_PROBE_DIR: join(emptySeedRoot, 'probe')",
     "  DIANJING_PI_BACKEND_PORT: String(PORT2),\n  PI_PROMPT_PROBE_DIR: join(emptyAssetsRoot, 'probe')"),
    ('  cwd: emptySeedRoot,', '  cwd: emptyAssetsRoot,'),
    ("  const emptyProbe = probeText(emptySeedRoot) ?? ''", "  const emptyProbe = probeText(emptyAssetsRoot) ?? ''"),
    ("  check('C2 无种子：overlay 输出 fallback 引导段', emptyProbe.includes('No material types available'))",
     "  check('C2 无资产：overlay 输出 fallback 引导段', emptyProbe.includes('No material types available'))"),
    ("  check('C2 无种子：工作流段仍在（种子缺失只降级 overlay）', emptyProbe.includes(MARKETING_MARKER))",
     "  check('C2 无资产：工作流段仍在（资产缺失只降级 overlay）', emptyProbe.includes(MARKETING_MARKER))"),
    ('  for (const dir of [tempRoot, emptySeedRoot]) {', '  for (const dir of [tempRoot, emptyAssetsRoot]) {'),
    # readdirSync import
    ("import {\n  copyFileSync,\n  existsSync,\n  mkdirSync,\n  mkdtempSync,\n  readFileSync,\n  rmSync,\n  writeFileSync\n} from 'node:fs'",
     "import {\n  copyFileSync,\n  existsSync,\n  mkdirSync,\n  mkdtempSync,\n  readFileSync,\n  readdirSync,\n  rmSync,\n  writeFileSync\n} from 'node:fs'"),
]

for old, new in subs:
    assert s.count(old) == 1, 'anchor miss: ' + old[:60]
    s = s.replace(old, new)

io.open(p, 'w', encoding='utf-8', newline='').write(s)
print('prompt-assembly-smoke updated:', len(subs), 'substitutions')
