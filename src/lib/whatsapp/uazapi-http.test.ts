import { describe, expect, it } from 'vitest'
import { throwUazapiError, uazapiUrl } from './uazapi-http'

describe('uazapiUrl', () => {
  it('joins a server URL without a trailing slash', () => {
    expect(uazapiUrl('https://free.uazapi.com', '/send/text')).toBe(
      'https://free.uazapi.com/send/text',
    )
  })

  it('strips a trailing slash from the server URL before joining', () => {
    expect(uazapiUrl('https://free.uazapi.com/', '/send/text')).toBe(
      'https://free.uazapi.com/send/text',
    )
  })
})

describe('throwUazapiError', () => {
  it('throws the flat `error` string from the response body', async () => {
    const response = {
      json: async () => ({ error: 'Invalid token' }),
    } as Response

    await expect(throwUazapiError(response, 'fallback')).rejects.toThrow(
      'Invalid token',
    )
  })

  it('falls back when the body is not JSON', async () => {
    const response = {
      json: async () => {
        throw new Error('not json')
      },
    } as unknown as Response

    await expect(throwUazapiError(response, 'UAZAPI error: 500')).rejects.toThrow(
      'UAZAPI error: 500',
    )
  })
})
