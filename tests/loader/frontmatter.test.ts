import { describe, it, expect } from 'vitest'
import { parseFrontmatter } from '../../src/loader/frontmatter.js'

describe('parseFrontmatter', () => {
  it('frontmatter 付きの文字列からキー・値とボディを抽出する', () => {
    const input = '---\nname: test\ndescription: hello world\n---\nThis is the body.'
    const result = parseFrontmatter(input)
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.data.attributes).toStrictEqual({
        name: 'test',
        description: 'hello world',
      })
      expect(result.data.body).toBe('This is the body.')
    }
  })

  it('インライン配列を string[] としてパースする', () => {
    const input = '---\ntools: [shell, read]\n---\nbody'
    const result = parseFrontmatter(input)
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.data.attributes).toStrictEqual({
        tools: ['shell', 'read'],
      })
      expect(result.data.body).toBe('body')
    }
  })

  it('frontmatter がない場合、全体をボディとして返す', () => {
    const input = 'Just plain text\nwith multiple lines.'
    const result = parseFrontmatter(input)
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.data.attributes).toStrictEqual({})
      expect(result.data.body).toBe('Just plain text\nwith multiple lines.')
    }
  })

  it('空の frontmatter（--- のみ）を正しく扱う', () => {
    const input = '---\n---\nbody'
    const result = parseFrontmatter(input)
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.data.attributes).toStrictEqual({})
      expect(result.data.body).toBe('body')
    }
  })

  it('ボディが空の場合、空文字列を返す', () => {
    const input = '---\nname: test\n---'
    const result = parseFrontmatter(input)
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.data.attributes).toStrictEqual({ name: 'test' })
      expect(result.data.body).toBe('')
    }
  })

  it('コメント行を無視する', () => {
    const input = '---\n# comment\nname: test\n# another comment\n---\nbody'
    const result = parseFrontmatter(input)
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.data.attributes).toStrictEqual({ name: 'test' })
      expect(result.data.body).toBe('body')
    }
  })

  it('空行を無視する', () => {
    const input = '---\nname: test\n\ndescription: hello\n\n---\nbody'
    const result = parseFrontmatter(input)
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.data.attributes).toStrictEqual({
        name: 'test',
        description: 'hello',
      })
      expect(result.data.body).toBe('body')
    }
  })

  it('値の前後の空白をトリムする', () => {
    const input = '---\nname:  hello \n---\nbody'
    const result = parseFrontmatter(input)
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.data.attributes).toStrictEqual({ name: 'hello' })
    }
  })

  it('キーにハイフンを含む場合を正しくパースする', () => {
    const input = '---\nmy-skill: value\n---\nbody'
    const result = parseFrontmatter(input)
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.data.attributes).toStrictEqual({ 'my-skill': 'value' })
    }
  })

  it('空の配列 [] を空配列として返す', () => {
    const input = '---\ntools: []\n---\nbody'
    const result = parseFrontmatter(input)
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.data.attributes).toStrictEqual({ tools: [] })
    }
  })

  it('配列内の要素の前後空白をトリムする', () => {
    const input = '---\ntools: [ shell , read ]\n---\nbody'
    const result = parseFrontmatter(input)
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.data.attributes).toStrictEqual({
        tools: ['shell', 'read'],
      })
    }
  })

  it('Windows 改行コード（CRLF）を正しく扱う', () => {
    const input = '---\r\nname: test\r\n---\r\nbody'
    const result = parseFrontmatter(input)
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.data.attributes).toStrictEqual({ name: 'test' })
      expect(result.data.body).toBe('body')
    }
  })

  it('開始デリミタがあるが終了デリミタがない場合にエラーを返す', () => {
    const input = '---\nname: test\nno closing delimiter'
    const result = parseFrontmatter(input)
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error.code).toBe('PARSE_ERROR')
      expect(result.error.message).toContain('closing delimiter')
    }
  })
})
