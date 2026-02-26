/**
 * rpc/protocol モジュール テスト
 *
 * JSON-RPC 2.0 のエンコード / デコード / 型ガード関数の検証。
 */
import { describe, it, expect } from 'vitest'
import {
  isJsonRpcRequest,
  isJsonRpcNotification,
  isJsonRpcIncoming,
  decodeJsonRpc,
  encodeNotification,
  encodeSuccessResponse,
  encodeErrorResponse,
  encodeParseError,
  encodeMethodNotFound,
  encodeInternalError,
} from '../../src/rpc/protocol.js'

// ─── isJsonRpcRequest ───

describe('rpc/protocol', () => {
  describe('isJsonRpcRequest', () => {
    it('valid request を true と判定する', () => {
      const msg = { jsonrpc: '2.0', id: 1, method: 'foo', params: {} }
      expect(isJsonRpcRequest(msg)).toBe(true)
    })

    it('id が文字列の valid request を true と判定する', () => {
      const msg = { jsonrpc: '2.0', id: 'abc', method: 'bar' }
      expect(isJsonRpcRequest(msg)).toBe(true)
    })

    it('id が欠落している場合は false', () => {
      const msg = { jsonrpc: '2.0', method: 'foo' }
      expect(isJsonRpcRequest(msg)).toBe(false)
    })

    it('method が欠落している場合は false', () => {
      const msg = { jsonrpc: '2.0', id: 1 }
      expect(isJsonRpcRequest(msg)).toBe(false)
    })

    it('jsonrpc が 2.0 でない場合は false', () => {
      const msg = { jsonrpc: '1.0', id: 1, method: 'foo' }
      expect(isJsonRpcRequest(msg)).toBe(false)
    })

    it('非オブジェクト (string) の場合は false', () => {
      expect(isJsonRpcRequest('hello')).toBe(false)
    })

    it('null の場合は false', () => {
      expect(isJsonRpcRequest(null)).toBe(false)
    })

    it('配列の場合は false', () => {
      expect(isJsonRpcRequest([1, 2, 3])).toBe(false)
    })

    it('id が boolean の場合は false', () => {
      const msg = { jsonrpc: '2.0', id: true, method: 'foo' }
      expect(isJsonRpcRequest(msg)).toBe(false)
    })
  })

  // ─── isJsonRpcNotification ───

  describe('isJsonRpcNotification', () => {
    it('valid notification を true と判定する', () => {
      const msg = { jsonrpc: '2.0', method: 'update', params: [1] }
      expect(isJsonRpcNotification(msg)).toBe(true)
    })

    it('params なしの valid notification を true と判定する', () => {
      const msg = { jsonrpc: '2.0', method: 'ping' }
      expect(isJsonRpcNotification(msg)).toBe(true)
    })

    it('id を持つ場合は false（request であり notification ではない）', () => {
      const msg = { jsonrpc: '2.0', id: 1, method: 'foo' }
      expect(isJsonRpcNotification(msg)).toBe(false)
    })

    it('method が欠落している場合は false', () => {
      const msg = { jsonrpc: '2.0' }
      expect(isJsonRpcNotification(msg)).toBe(false)
    })

    it('method が文字列でない場合は false', () => {
      const msg = { jsonrpc: '2.0', method: 123 }
      expect(isJsonRpcNotification(msg)).toBe(false)
    })
  })

  // ─── isJsonRpcIncoming ───

  describe('isJsonRpcIncoming', () => {
    it('request を true と判定する', () => {
      const msg = { jsonrpc: '2.0', id: 1, method: 'foo' }
      expect(isJsonRpcIncoming(msg)).toBe(true)
    })

    it('notification を true と判定する', () => {
      const msg = { jsonrpc: '2.0', method: 'bar' }
      expect(isJsonRpcIncoming(msg)).toBe(true)
    })

    it('response（result フィールドあり・method なし）を false と判定する', () => {
      const msg = { jsonrpc: '2.0', id: 1, result: 42 }
      expect(isJsonRpcIncoming(msg)).toBe(false)
    })

    it('error response を false と判定する', () => {
      const msg = { jsonrpc: '2.0', id: 1, error: { code: -32600, message: 'bad' } }
      expect(isJsonRpcIncoming(msg)).toBe(false)
    })
  })

  // ─── decodeJsonRpc ───

  describe('decodeJsonRpc', () => {
    it('valid request 文字列を ok でデコードする', () => {
      const line = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'test', params: { a: 1 } })
      const result = decodeJsonRpc(line)
      expect(result.ok).toBe(true)
      if (result.ok) {
        expect(result.data).toEqual({ jsonrpc: '2.0', id: 1, method: 'test', params: { a: 1 } })
      }
    })

    it('valid notification 文字列を ok でデコードする', () => {
      const line = JSON.stringify({ jsonrpc: '2.0', method: 'notify' })
      const result = decodeJsonRpc(line)
      expect(result.ok).toBe(true)
      if (result.ok) {
        expect(result.data).toEqual({ jsonrpc: '2.0', method: 'notify' })
      }
    })

    it('不正な JSON を err で返す', () => {
      const result = decodeJsonRpc('{invalid json}')
      expect(result.ok).toBe(false)
      if (!result.ok) {
        expect(result.error).toContain('parse')
      }
    })

    it('valid JSON だが JSON-RPC ではない場合は err で返す', () => {
      const result = decodeJsonRpc(JSON.stringify({ hello: 'world' }))
      expect(result.ok).toBe(false)
      if (!result.ok) {
        expect(result.error).toContain('Invalid')
      }
    })

    it('空文字列を err で返す', () => {
      const result = decodeJsonRpc('')
      expect(result.ok).toBe(false)
    })

    it('response オブジェクトを err で返す（incoming ではない）', () => {
      const line = JSON.stringify({ jsonrpc: '2.0', id: 1, result: 'ok' })
      const result = decodeJsonRpc(line)
      expect(result.ok).toBe(false)
    })
  })

  // ─── encodeNotification ───

  describe('encodeNotification', () => {
    it('params ありの通知を NDJSON 文字列にエンコードする', () => {
      const encoded = encodeNotification('update', { value: 42 })
      const parsed = JSON.parse(encoded) as Record<string, unknown>
      expect(parsed).toEqual({
        jsonrpc: '2.0',
        method: 'update',
        params: { value: 42 },
      })
    })

    it('params なしの通知は params キーを含まない', () => {
      const encoded = encodeNotification('ping')
      const parsed = JSON.parse(encoded) as Record<string, unknown>
      expect(parsed).toEqual({
        jsonrpc: '2.0',
        method: 'ping',
      })
      expect(encoded).not.toContain('"params"')
    })

    it('エンコード結果は単一行（改行なし）である', () => {
      const encoded = encodeNotification('test', { x: 1 })
      expect(encoded).not.toContain('\n')
    })
  })

  // ─── encodeSuccessResponse ───

  describe('encodeSuccessResponse', () => {
    it('result ありの成功レスポンスをエンコードする', () => {
      const encoded = encodeSuccessResponse(1, { data: 'hello' })
      const parsed = JSON.parse(encoded) as Record<string, unknown>
      expect(parsed).toEqual({
        jsonrpc: '2.0',
        id: 1,
        result: { data: 'hello' },
      })
    })

    it('result が null の場合も正しくエンコードする', () => {
      const encoded = encodeSuccessResponse('abc', null)
      const parsed = JSON.parse(encoded) as Record<string, unknown>
      expect(parsed).toEqual({
        jsonrpc: '2.0',
        id: 'abc',
        result: null,
      })
    })

    it('エンコード結果は単一行である', () => {
      const encoded = encodeSuccessResponse(1, 'ok')
      expect(encoded).not.toContain('\n')
    })
  })

  // ─── encodeErrorResponse ───

  describe('encodeErrorResponse', () => {
    it('data ありのエラーレスポンスをエンコードする', () => {
      const encoded = encodeErrorResponse(1, -32600, 'Invalid Request', {
        detail: 'missing method',
      })
      const parsed = JSON.parse(encoded) as Record<string, unknown>
      expect(parsed).toEqual({
        jsonrpc: '2.0',
        id: 1,
        error: {
          code: -32600,
          message: 'Invalid Request',
          data: { detail: 'missing method' },
        },
      })
    })

    it('data なしのエラーレスポンスは data キーを含まない', () => {
      const encoded = encodeErrorResponse(2, -32603, 'Internal error')
      const parsed = JSON.parse(encoded) as Record<string, unknown>
      expect(parsed).toEqual({
        jsonrpc: '2.0',
        id: 2,
        error: {
          code: -32603,
          message: 'Internal error',
        },
      })
      expect(encoded).not.toContain('"data"')
    })

    it('id が null のエラーレスポンスをエンコードできる', () => {
      const encoded = encodeErrorResponse(null, -32700, 'Parse error')
      const parsed = JSON.parse(encoded) as Record<string, unknown>
      expect(parsed).toEqual({
        jsonrpc: '2.0',
        id: null,
        error: {
          code: -32700,
          message: 'Parse error',
        },
      })
    })
  })

  // ─── encodeParseError ───

  describe('encodeParseError', () => {
    it('id が null、code が -32700 のエラーレスポンスを返す', () => {
      const encoded = encodeParseError()
      const parsed = JSON.parse(encoded) as Record<string, unknown>
      expect(parsed).toEqual({
        jsonrpc: '2.0',
        id: null,
        error: {
          code: -32700,
          message: 'Parse error',
        },
      })
    })

    it('data を付加できる', () => {
      const encoded = encodeParseError('raw input')
      const parsed = JSON.parse(encoded) as Record<string, unknown>
      expect(parsed).toEqual({
        jsonrpc: '2.0',
        id: null,
        error: {
          code: -32700,
          message: 'Parse error',
          data: 'raw input',
        },
      })
    })
  })

  // ─── encodeMethodNotFound ───

  describe('encodeMethodNotFound', () => {
    it('code が -32601 で、message にメソッド名を含むエラーレスポンスを返す', () => {
      const encoded = encodeMethodNotFound(5, 'unknownMethod')
      const parsed = JSON.parse(encoded) as Record<string, unknown>
      expect(parsed).toHaveProperty('jsonrpc', '2.0')
      expect(parsed).toHaveProperty('id', 5)
      const error = (parsed as { error: { code: number; message: string } }).error
      expect(error.code).toBe(-32601)
      expect(error.message).toContain('unknownMethod')
    })
  })

  // ─── encodeInternalError ───

  describe('encodeInternalError', () => {
    it('code が -32603 のエラーレスポンスを返す', () => {
      const encoded = encodeInternalError(10, 'something went wrong')
      const parsed = JSON.parse(encoded) as Record<string, unknown>
      expect(parsed).toEqual({
        jsonrpc: '2.0',
        id: 10,
        error: {
          code: -32603,
          message: 'something went wrong',
        },
      })
    })
  })
})
