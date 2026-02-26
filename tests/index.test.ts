import { describe, it, expect } from 'vitest'
import { VERSION } from '../src/index.js'

describe('wn-core', () => {
  it('バージョンが定義されている', () => {
    expect(VERSION).toBe('0.1.0')
  })
})
