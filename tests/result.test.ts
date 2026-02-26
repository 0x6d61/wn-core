import { describe, it, expect } from 'vitest'
import { ok, err } from '../src/result.js'
import type { Result } from '../src/result.js'

describe('Result', () => {
  describe('ok()', () => {
    it('ok: true と data を持つオブジェクトを返す', () => {
      const result = ok(42)
      expect(result).toStrictEqual({ ok: true, data: 42 })
    })

    it('data に任意の型を格納できる', () => {
      const result = ok({ name: 'test', values: [1, 2, 3] })
      expect(result.ok).toBe(true)
      if (result.ok) {
        expect(result.data).toStrictEqual({ name: 'test', values: [1, 2, 3] })
      }
    })

    it('data に undefined を格納できる', () => {
      const result = ok(undefined)
      expect(result).toStrictEqual({ ok: true, data: undefined })
    })
  })

  describe('err()', () => {
    it('ok: false と error を持つオブジェクトを返す', () => {
      const result = err('something went wrong')
      expect(result).toStrictEqual({ ok: false, error: 'something went wrong' })
    })

    it('カスタムエラー型を使用できる', () => {
      const result = err({ code: 404, message: 'not found' })
      expect(result.ok).toBe(false)
      if (!result.ok) {
        expect(result.error).toStrictEqual({ code: 404, message: 'not found' })
      }
    })
  })

  describe('型の絞り込み', () => {
    it('ok チェックで data にアクセスでき、error にはアクセスできない', () => {
      const result: Result<number> = ok(42)
      if (result.ok) {
        // result.data にアクセスできる（型エラーなし）
        expect(result.data).toBe(42)
      } else {
        // result.error にアクセスできる（型エラーなし）
        expect(result.error).toBeTypeOf('string')
      }
    })
  })
})
