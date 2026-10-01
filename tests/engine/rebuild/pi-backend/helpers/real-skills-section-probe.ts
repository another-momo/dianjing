/**
 * 真 SDK skills 探针——须在干净子进程内运行（父测试进程的同 specifier
 * mock.module 注册表不遗传给子进程），按生产镜像选项装配真
 * DefaultResourceLoader 真扫 skills fixture，stdout 回传 JSON：
 * { names: 扫描到的 skill 名清单, section: formatSkillsForPrompt 产物 }。
 *
 * 存在的理由：bun 模块注册表按解析路径去重，mock 生效后同进程内任何
 * specifier / file URL / createRequire 通路拿到的都是桩（2026-10-01 实证），
 * 想钉真 SDK 行为只能换进程。
 *
 * 用法：bun real-skills-section-probe.ts <workspaceDir> <agentDir> <skillsDir>
 */
import {
  DefaultResourceLoader,
  formatSkillsForPrompt,
  SettingsManager
} from '@earendil-works/pi-coding-agent'

const [workspaceDir, agentDir, skillsDir] = process.argv.slice(2)
if (!workspaceDir || !agentDir || !skillsDir) {
  throw new Error('usage: bun real-skills-section-probe.ts <workspaceDir> <agentDir> <skillsDir>')
}

// 选项镜像 session/assembly.ts 生产装配（trust 关 + 上下文/模板/扩展全关 +
// 单源 additionalSkillPaths）——漂移时由测试侧断言暴露
const settingsManager = SettingsManager.create(workspaceDir, agentDir, { projectTrusted: false })
settingsManager.applyOverrides({ enableInstallTelemetry: false })
const loader = new DefaultResourceLoader({
  cwd: workspaceDir,
  agentDir,
  systemPrompt: '',
  settingsManager,
  noContextFiles: true,
  noSkills: false,
  noPromptTemplates: true,
  noExtensions: true,
  additionalSkillPaths: [skillsDir]
})
await loader.reload()
const skills = loader.getSkills().skills
process.stdout.write(
  JSON.stringify({
    names: skills.map((skill) => skill.name),
    section: formatSkillsForPrompt(skills)
  })
)
