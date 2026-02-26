import { describe, it, expect } from 'vitest'
import { requireString, optionalString, optionalNumber } from '../../src/tools/validate.js'

describe('requireString', () => {
  it('有効な非空文字列で { value } を返す', () => {
    const result = requireString({ name: 'hello' }, 'name')
    expect(result).toStrictEqual({ value: 'hello' })
  })

  it('undefined の場合 { error } を返す', () => {
    const result = requireString({}, 'name')
    expect(result).toHaveProperty('error')
    if ('error' in result) {
      expect(result.error.ok).toBe(false)
      expect(result.error.error).toContain('name')
    }
  })

  it('空文字列の場合 { error } を返す', () => {
    const result = requireString({ name: '' }, 'name')
    expect(result).toHaveProperty('error')
    if ('error' in result) {
      expect(result.error.ok).toBe(false)
      expect(result.error.error).toContain('name')
    }
  })

  it('文字列以外の型（number）の場合 { error } を返す', () => {
    const result = requireString({ name: 42 }, 'name')
    expect(result).toHaveProperty('error')
    if ('error' in result) {
      expect(result.error.ok).toBe(false)
      expect(result.error.error).toContain('name')
    }
  })
})

describe('optionalString', () => {
  it('有効な文字列の場合その文字列を返す', () => {
    const result = optionalString({ dir: '/tmp' }, 'dir')
    expect(result).toBe('/tmp')
  })

  it('undefined の場合 undefined を返す', () => {
    const result = optionalString({}, 'dir')
    expect(result).toBeUndefined()
  })

  it('文字列以外の型の場合 undefined を返す', () => {
    const result = optionalString({ dir: 123 }, 'dir')
    expect(result).toBeUndefined()
  })
})

describe('optionalNumber', () => {
  it('有効な数値で { value } を返す', () => {
    const result = optionalNumber({ timeout: 5000 }, 'timeout')
    expect(result).toStrictEqual({ value: 5000 })
  })

  it('undefined の場合 { value: undefined } を返す', () => {
    const result = optionalNumber({}, 'timeout')
    expect(result).toStrictEqual({ value: undefined })
  })

  it('数値以外の型の場合 { error } を返す', () => {
    const result = optionalNumber({ timeout: 'abc' }, 'timeout')
    expect(result).toHaveProperty('error')
    if ('error' in result) {
      expect(result.error.ok).toBe(false)
      expect(result.error.error).toContain('timeout')
    }
  })

  it('min より小さい値の場合 { error } を返す', () => {
    const result = optionalNumber({ timeout: -1 }, 'timeout', 0)
    expect(result).toHaveProperty('error')
    if ('error' in result) {
      expect(result.error.ok).toBe(false)
      expect(result.error.error).toContain('timeout')
    }
  })
})
