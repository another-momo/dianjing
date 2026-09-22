/**
 * MCP 连接编辑器表单状态（脏检查 / busy 守卫 / 部分保存 partial /
 * 并发写队列 / 名称即 slug 校验（非空/≤80/不含 '/'/唯一）/ URL 安全校验）。
 *
 * 数据来源切换：上游拷改版本接 localStorage + 凭据服务层；本仓新数据层接
 * fetch client（见 ./client）。字段适配：上游单档 streamable-http → 本仓
 * transport 双档（http/stdio），新增 headers/env 键值对表，状态徽章由后端
 * 健康检查回写。
 */

import * as v from 'valibot'
import { useForm } from 'vee-validate'
import { computed, reactive, ref, watch, type Ref } from 'vue'

import type { MCPConnectionDraft, MCPConnectionFieldErrors } from './types'
import {
  createEmptyMCPConnectionDraft,
  MCP_CONNECTION_NAME_MAX_LENGTH,
  parseMCPConnectionArgs,
  validateMCPConnectionCommand,
  validateMCPConnectionName,
  validateMCPConnectionURL
} from './types'

export interface MCPConnectionFormMessages {
  requiredField: string
  connectionNameInvalid: string
  duplicateName: string
  serverURLHint: string
  commandInvalid: string
  argsInvalid: string
}

export type ConnectionExistsCheck = (name: string, excludeSlug: string | null) => boolean

export function useMCPConnectionForm(
  messages: Readonly<Ref<MCPConnectionFormMessages>>,
  exists: ConnectionExistsCheck
) {
  const id = ref<MCPConnectionDraft['id']>(null)

  const schema = computed(() =>
    v.pipe(
      v.object({
        name: v.pipe(
          v.string(),
          v.minLength(1, messages.value.requiredField),
          v.maxLength(MCP_CONNECTION_NAME_MAX_LENGTH, messages.value.connectionNameInvalid),
          v.check((name) => {
            try {
              validateMCPConnectionName(name)
              return true
            } catch {
              return false
            }
          }, messages.value.connectionNameInvalid),
          v.check((name) => !exists(name.trim(), id.value), messages.value.duplicateName)
        ),
        url: v.optional(
          v.pipe(
            v.string(),
            v.check((value) => {
              try {
                validateMCPConnectionURL(value)
                return true
              } catch {
                return false
              }
            }, messages.value.serverURLHint)
          )
        ),
        command: v.optional(
          v.pipe(
            v.string(),
            v.check((value) => {
              try {
                validateMCPConnectionCommand(value)
                return true
              } catch {
                return false
              }
            }, messages.value.commandInvalid)
          )
        ),
        argsText: v.optional(
          v.pipe(
            v.string(),
            v.check((value) => {
              try {
                parseMCPConnectionArgs(value)
                return true
              } catch {
                return false
              }
            }, messages.value.argsInvalid)
          )
        ),
        transport: v.picklist(['http', 'stdio']),
        headers: v.array(v.object({ key: v.string(), value: v.string() })),
        env: v.array(v.object({ key: v.string(), value: v.string() }))
      }),
      v.forward(
        v.partialCheck(
          [['transport'], ['url']],
          (value) => value.transport !== 'http' || Boolean(value.url?.trim()),
          messages.value.requiredField
        ),
        ['url']
      ),
      v.forward(
        v.partialCheck(
          [['transport'], ['command']],
          (value) => value.transport !== 'stdio' || Boolean(value.command?.trim()),
          messages.value.requiredField
        ),
        ['command']
      )
    )
  )

  const form = useForm({
    initialValues: createEmptyMCPConnectionDraft(),
    validationSchema: schema
  })

  const config = (state: { errors: string[] }) => ({
    validateOnModelUpdate: state.errors.length > 0,
    validateOnChange: false,
    validateOnInput: false
  })

  const [name] = form.defineField('name', config)
  const [url] = form.defineField('url', config)
  const [command] = form.defineField('command', config)
  const [argsText] = form.defineField('argsText', config)
  const [transport] = form.defineField('transport', config)
  const headersField = form.defineField('headers', config)
  const envField = form.defineField('env', config)
  const headers = headersField[0] as Ref<MCPConnectionDraft['headers']>
  const env = envField[0] as Ref<MCPConnectionDraft['env']>

  // schema 里 url/command/argsText 是 v.optional → ref 值型为 string | undefined；
  // 草稿契约是纯 string（空串占位）——包一层归一化 computed 保双向写回
  function stringDraftRef(source: Ref<string | undefined>): Ref<string> {
    return computed({
      get: () => source.value ?? '',
      set: (value: string) => {
        source.value = value
      }
    })
  }

  const fields = reactive({
    id,
    name,
    url: stringDraftRef(url),
    command: stringDraftRef(command),
    argsText: stringDraftRef(argsText),
    transport,
    headers,
    env
  })

  const draft = computed<MCPConnectionDraft>({
    get: () => fields,
    set: (values: MCPConnectionDraft) => {
      id.value = values.id
      form.resetForm({ values: { ...createEmptyMCPConnectionDraft(), ...values } })
    }
  })

  watch(
    () => [transport.value, url.value, command.value, argsText.value, name.value],
    () => {
      const errCount = Object.keys(form.errors.value).length
      if (errCount > 0) void form.validate()
    }
  )

  const fieldErrors = computed<MCPConnectionFieldErrors>(() => {
    const errs = form.errors.value
    return {
      name: typeof errs.name === 'string' ? errs.name : undefined,
      url: typeof errs.url === 'string' ? errs.url : undefined,
      command: typeof errs.command === 'string' ? errs.command : undefined,
      args: typeof errs.argsText === 'string' ? errs.argsText : undefined
    }
  })

  return {
    draft,
    dirty: computed(() => form.meta.value.dirty),
    isSubmitting: form.isSubmitting,
    fieldErrors,
    blur: (field: 'name' | 'url' | 'command' | 'argsText') => form.validateField(field),
    handleSubmit: form.handleSubmit
  }
}
