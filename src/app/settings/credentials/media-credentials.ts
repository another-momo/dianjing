/**
 * 媒体类 credential ref 叶子模块（pexels/unsplash）——独立成叶是为了让
 * persistence.ts（remember 开关聚合）与 media.ts（状态+惰性注入）都能引用
 * 而不成环（T25 手术拆分实证）。
 */

import { credentialRef } from '@/app/settings/credentials/reference'

export const PEXELS_CREDENTIAL = credentialRef('pexels', 'api-key')
export const UNSPLASH_CREDENTIAL = credentialRef('unsplash', 'access-key')
