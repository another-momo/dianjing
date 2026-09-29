import fsd from '@feature-sliced/steiger-plugin'
import { defineConfig } from 'steiger'

import { openPencilArchitecturePlugin } from './tools/architecture/src/steiger-rules/index.ts'

// OpenPencil is not laid out as canonical Feature-Sliced Design layers.
// Keep Steiger focused on project-specific architecture boundaries instead of
// enabling fsd.configs.recommended, which treats src/ and packages/ as FSD layer typos.
export default defineConfig([
  fsd.plugin,
  openPencilArchitecturePlugin,
  {
    ignores: [
      '.claude/**',
      'node_modules/**',
      'dist/**',
      'desktop/**',
      'public/**',
      'scratch/**',
      'demo-recordings/**'
    ]
  },
  {
    rules: {
      'open-pencil/prefer-domain-folders-over-filename-prefixes': 'error',
      'open-pencil/strict-test-file-placement': 'error',
      'open-pencil/no-engine-only-assertions-in-e2e': 'error',
      'open-pencil/no-e2e-imports-in-engine-tests': 'error',
      'open-pencil/no-root-markdown-clutter': 'error',
      'open-pencil/no-prototype-or-generated-imports': 'error',
      'open-pencil/no-property-panel-imports-in-canvas': 'error',
      'open-pencil/no-app-imports-in-workspace-packages': 'error',
      'open-pencil/no-package-internals-in-app': 'error',
      'open-pencil/no-foreign-package-local-aliases': 'error',
      'open-pencil/no-app-imports-components-or-views': 'error',
      'open-pencil/no-components-import-views': 'error',
      'open-pencil/no-views-imported-outside-entry': 'error',
      'open-pencil/no-non-ui-imports-in-shared-ui': 'error',
      'open-pencil/no-app-imports-in-shared-ui': 'error',
      'open-pencil/no-property-panel-internals-outside-panel': 'error',
      'open-pencil/no-production-test-ids-in-shared-layers': 'error',
      'open-pencil/no-native-title-attributes-in-vue': 'error',
      'open-pencil/no-ui-imports-in-core': 'error',
      'open-pencil/scripts-are-entrypoint-shims': 'error',
      'open-pencil/strict-tools-layout': 'error',
      // T27：规则 drift 收口（实现 28 条 vs 原注册 20 条）——以下 5 条实测零违规，补注册：
      'open-pencil/no-cross-package-reexport-shims': 'error',
      'open-pencil/no-misplaced-engine-test-domain-paths': 'error',
      'open-pencil/no-kitchen-sink-engine-basic-tests': 'error',
      'open-pencil/no-production-test-ids-in-shared-layers': 'error',
      'open-pencil/no-vue-template-ui-hooks-or-svg': 'error'
      // T27：余下 3 条已实现但暂不注册（2026-08-25 实测有存量违规，启用需专项整改，
      // 非本任务范围）：
      //   no-dynamic-tailwind-state-classes   — 17 处（properties/libraries/settings UI）
      //   no-shortcut-text-in-labels          — 4 处（i18n messages）
      //   no-hardcoded-macos-shortcut-glyphs  — 1 处（packages/vue primitives demo）
    }
  }
])
