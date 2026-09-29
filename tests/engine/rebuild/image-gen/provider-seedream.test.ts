/**
 * T77 P6：Seedream 兼容 provider mock fetch 钉请求形状 + 注册表/分派钉扎。
 *
 * 镜像 provider.test.ts 的 fetchImpl 注入夹具形态——本测试钉的是：
 * 1. 文生图：POST `{baseUrl}/images/generations`、Bearer 头、body 含
 *    `watermark: false` + `background: 'opaque'` + `output_format` 缺省 'png'
 *    + 无 `response_format` 键（T77 P3 共用约定）。
 * 2. 图生图 multipart：`form.get('watermark')==='false'`、
 *    `background==='opaque'`、image[] 带文件名、无 response_format。
 * 3. name === `seedream(${model})`。
 * 4. req 传 `background: 'auto'` → 线路恒 'opaque'（P7 固定覆盖钉扎）。
 * 5. 注册表钉扎：`isImageGenProviderType('seedream')` true、两族 id 精确集；
 *    防止 provider-types.ts 注册表与 ImageGenProviderType 联合偏离
 *    （联合改手写字面量——编译器无法校验二者一致性，靠本测试兜底）。
 * 6. `createProviderFor` 分派钉扎：seedream 凭证 → seedream provider（name
 *    断言）；openai-compatible → openai provider。
 */

import { describe, expect, test } from 'bun:test'

import { fromUint8Array } from 'js-base64'

import { createProviderFor } from '@/app/ai/pi-backend/image-gen/factory'
import { createSeedreamImageGenProvider } from '@/app/ai/pi-backend/image-gen/provider-seedream'
import {
  IMAGE_GEN_PROVIDER_TYPES,
  isImageGenProviderType
} from '@/app/ai/pi-backend/image-gen/provider-types'

import { mockFetch } from './helpers'

const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47])

const SEEDREAM_CREDENTIALS = {
  providerType: 'seedream' as const,
  baseUrl: 'https://ark.cn-beijing.volces.com/api/v3',
  model: 'doubao-seedream-5-0-lite',
  apiKey: 'sk-test-seedream-key'
}

const B64_RESPONSE = { data: [{ b64_json: fromUint8Array(PNG_BYTES) }] }

/** Seedream /images/generations 请求体（钉扎用命名类型）。
 * T77 P3 共用约定：无 response_format 字段。 */
interface SeedreamGenerationsRequestBody {
  model?: string
  prompt?: string
  size?: string
  n?: number
  quality?: string
  output_format?: string
  output_compression?: number
  background?: string
  moderation?: string
  watermark?: boolean
}

describe('provider-seedream 请求形状', () => {
  test('文生图：POST /images/generations JSON（watermark:false + background:opaque + 无 response_format）', async () => {
    const { calls, fetchImpl } = mockFetch(B64_RESPONSE)
    const provider = createSeedreamImageGenProvider({
      credentials: SEEDREAM_CREDENTIALS,
      fetchImpl
    })
    const result = await provider.generate({
      prompt: 'hero shot',
      width: 1024,
      height: 1024,
      quality: 'high',
      outputFormat: 'png',
      background: 'auto'
    })

    expect(calls).toHaveLength(1)
    const call = calls[0]
    expect(call.url).toBe('https://ark.cn-beijing.volces.com/api/v3/images/generations')
    expect(call.method).toBe('POST')
    const headers = new Headers(call.headers)
    expect(headers.get('authorization')).toBe('Bearer sk-test-seedream-key')
    expect(headers.get('content-type')).toBe('application/json')
    const body = JSON.parse(String(call.body)) as SeedreamGenerationsRequestBody
    expect(body).toEqual({
      model: 'doubao-seedream-5-0-lite',
      prompt: 'hero shot',
      size: '1024x1024',
      n: 1,
      quality: 'high',
      output_format: 'png',
      background: 'opaque',
      moderation: 'auto',
      watermark: false
    })
    // T77 P3 反向钉扎：Seedream 族同样不发送 response_format
    expect('response_format' in body).toBe(false)
    expect(call.signal).toBeInstanceOf(AbortSignal)
    expect([...result.bytes]).toEqual([...PNG_BYTES])
    expect(result.width).toBe(1024)
  })

  test('图生图：POST /images/edits multipart（watermark=false + background=opaque + 无 response_format）', async () => {
    const { calls, fetchImpl } = mockFetch(B64_RESPONSE)
    const provider = createSeedreamImageGenProvider({
      credentials: SEEDREAM_CREDENTIALS,
      fetchImpl
    })
    const refA = new Uint8Array([1, 1, 1])
    const refB = new Uint8Array([2, 2, 2])
    await provider.generate({ prompt: 'edit', width: 1024, height: 1024 }, [refA, refB])

    const call = calls[0]
    expect(call.url).toBe('https://ark.cn-beijing.volces.com/api/v3/images/edits')
    expect(call.body).toBeInstanceOf(FormData)
    const form = call.body as FormData
    expect(form.get('model')).toBe('doubao-seedream-5-0-lite')
    expect(form.get('prompt')).toBe('edit')
    expect(form.get('size')).toBe('1024x1024')
    expect(form.get('n')).toBe('1')
    expect(form.get('quality')).toBe('auto')
    expect(form.get('output_format')).toBe('png')
    expect(form.get('background')).toBe('opaque')
    expect(form.get('moderation')).toBe('auto')
    expect(form.get('watermark')).toBe('false')
    // T77 P3 反向钉扎：multipart 不带 response_format
    expect(form.get('response_format')).toBeNull()
    const images = form.getAll('image[]')
    expect(images).toHaveLength(2)
    expect((images[0] as File).name).toBe('input-1.png')
    expect((images[1] as File).name).toBe('input-2.png')
    expect(new Uint8Array(await (images[0] as File).arrayBuffer())).toEqual(refA)
    // multipart 不手设 content-type（fetch 自动带 boundary）
    const headers = new Headers(call.headers)
    expect(headers.get('content-type')).toBeNull()
  })

  test('name 为 seedream(<model>) 形状', () => {
    const provider = createSeedreamImageGenProvider({ credentials: SEEDREAM_CREDENTIALS })
    expect(provider.name).toBe('seedream(doubao-seedream-5-0-lite)')
  })

  test('T77 P7 固定覆盖：req.background: auto 仍 → 线路 background: opaque', async () => {
    const { calls, fetchImpl } = mockFetch(B64_RESPONSE)
    const provider = createSeedreamImageGenProvider({
      credentials: SEEDREAM_CREDENTIALS,
      fetchImpl
    })
    await provider.generate({
      prompt: 'a',
      width: 1024,
      height: 1024,
      background: 'auto'
    })
    const body = JSON.parse(String(calls[0].body)) as SeedreamGenerationsRequestBody
    expect(body.background).toBe('opaque')
  })
})

describe('provider 注册表钉扎（防注册表 ↔ ImageGenProviderType 联合偏离）', () => {
  test('isImageGenProviderType 接受 seedream', () => {
    expect(isImageGenProviderType('seedream')).toBe(true)
    expect(isImageGenProviderType('openai-compatible')).toBe(true)
    expect(isImageGenProviderType('not-a-provider')).toBe(false)
  })

  test('注册表 id 精确集与 ImageGenProviderType 联合一一对应', () => {
    const ids = IMAGE_GEN_PROVIDER_TYPES.map((entry) => entry.id).sort()
    expect(ids).toEqual(['openai-compatible', 'seedream'])
  })

  test('Seedream 注册条目携带占位字段', () => {
    const entry = IMAGE_GEN_PROVIDER_TYPES.find((e) => e.id === 'seedream')
    expect(entry?.baseUrlPlaceholder).toBe('https://ark.cn-beijing.volces.com/api/v3')
    expect(entry?.modelPlaceholder).toBe('doubao-seedream-5-0-lite')
  })
})

describe('createProviderFor 分派', () => {
  test('seedream 凭证 → seedream provider（name 断言）', () => {
    const provider = createProviderFor(SEEDREAM_CREDENTIALS)
    expect(provider.name).toBe('seedream(doubao-seedream-5-0-lite)')
  })

  test('openai-compatible 凭证 → openai 兼容 provider（name 断言）', () => {
    const provider = createProviderFor({
      providerType: 'openai-compatible',
      baseUrl: 'https://api.example.com/v1',
      model: 'gpt-image-1',
      apiKey: 'sk-test'
    })
    expect(provider.name).toBe('openai-compatible(gpt-image-1)')
  })

  test('options（fetchImpl）透传至底层工厂', async () => {
    const { calls, fetchImpl } = mockFetch(B64_RESPONSE)
    const provider = createProviderFor(SEEDREAM_CREDENTIALS, { fetchImpl })
    await provider.generate({ prompt: 'a', width: 1024, height: 1024 })
    expect(calls).toHaveLength(1)
  })
})
