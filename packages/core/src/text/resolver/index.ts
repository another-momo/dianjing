import type { FontFallbackScript } from '#core/text/fallbacks'
import { fontManager } from '#core/text/fonts'
import { FontResolver } from '#core/text/resolver/resolver'
import type {
  FontResolutionCandidate,
  FontResolutionDemand,
  FontResolutionLoader
} from '#core/text/resolver/types'

export * from './coverage'
export * from './resolver'
export * from './types'

function faceCandidate(
  family: string,
  style: string,
  source: FontResolutionCandidate['source']
): FontResolutionCandidate {
  return { id: `${source}:${family}:${style}`, family, style, source }
}

export function fontFaceDemandKey(family: string, style: string): string {
  return `face:${family.trim().toLocaleLowerCase()}:${style.toLocaleLowerCase()}`
}

export function fontFaceDemand(
  family: string,
  style: string,
  characters = ''
): FontResolutionDemand {
  return {
    key: fontFaceDemandKey(family, style),
    characters,
    candidates: [
      faceCandidate(family, style, 'registered'),
      faceCandidate(family, style, 'cache'),
      faceCandidate(family, style, 'fallback')
    ]
  }
}

export function fontRemoteCoverageDemand(
  family: string,
  style: string,
  characters: readonly string[]
): FontResolutionDemand {
  const coverageKey = [...new Set(characters)].sort((a, b) => a.localeCompare(b)).join('')
  return {
    key: `remote-coverage:${family.trim().toLocaleLowerCase()}:${style.toLocaleLowerCase()}:${coverageKey}`,
    characters: coverageKey,
    candidates: [faceCandidate(family, style, 'remote')]
  }
}

export function fontCoverageDemand(
  script: FontFallbackScript,
  characters: readonly string[] = []
): FontResolutionDemand {
  const codePoints = characters.flatMap((character) => {
    const codePoint = character.codePointAt(0)
    return codePoint === undefined ? [] : [codePoint.toString(16)]
  })
  const coverageKey = [...new Set(codePoints)].sort((a, b) => a.localeCompare(b)).join(',')
  return {
    key: `coverage:${script}:${coverageKey}`,
    characters: characters.join(''),
    candidates: [
      {
        id: `fallback:${script}`,
        family: script,
        style: 'Regular',
        source: 'fallback'
      }
    ]
  }
}

const productionFontLoader: FontResolutionLoader = async (candidate, demand) => {
  switch (candidate.source) {
    case 'registered':
      return fontManager.isStyleLoaded(candidate.family, candidate.style)
    case 'cache':
      return false
    case 'remote':
      return false
    case 'fallback': {
      const script = candidate.family as FontFallbackScript
      const families = await fontManager.ensureFallbackPack([script], demand.characters)
      return (families[script]?.length ?? 0) > 0
    }
  }
  return false
}

export const fontResolver = new FontResolver(productionFontLoader)

// T40 S1 逐出联动：FontManager 内存逐出某 family|style 时，必须同步复位 resolver
// 条目——否则残留 'loaded' 快照使 demand 直接返回旧 demand，字体永不重载。
fontManager.onFontEvicted((family, style) => {
  fontResolver.reset(fontFaceDemandKey(family, style))
})
