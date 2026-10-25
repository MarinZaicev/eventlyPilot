import {
  createHmac,
  timingSafeEqual,
} from 'node:crypto'

export type VerifiedMaxUser = {
  id: number
  first_name: string
  last_name?: string | null
  username?: string | null
  photo_url?: string | null
}

export function verifyMaxInitData(
  initData: string,
  botToken: string,
): VerifiedMaxUser | null {
  if (!initData || !botToken) {
    return null
  }

  try {
    const parts =
      initData
        .split('&')
        .map((part) => {
          const index =
            part.indexOf('=')

          if (index === -1) {
            return [
              part,
              '',
            ] as const
          }

          return [
            part.slice(0, index),
            part.slice(index + 1),
          ] as const
        })

    const hashes =
      parts.filter(
        ([key]) =>
          key === 'hash',
      )

    if (hashes.length !== 1) {
      return null
    }

    const originalHash =
      decodeURIComponent(
        hashes[0][1],
      )

    if (
      !/^[a-f0-9]{64}$/i.test(
        originalHash,
      )
    ) {
      return null
    }

    const decoded =
      parts
        .filter(
          ([key]) =>
            key !== 'hash',
        )
        .map(
          ([key, value]) =>
            [
              key,
              decodeURIComponent(
                value,
              ),
            ] as const,
        )
        .sort(
          (a, b) =>
            a[0].localeCompare(
              b[0],
            ),
        )

    const launchParams =
      decoded
        .map(
          ([key, value]) =>
            `${key}=${value}`,
        )
        .join('\n')

    const secretKey =
      createHmac(
        'sha256',
        'WebAppData',
      )
        .update(botToken)
        .digest()

    const calculatedHash =
      createHmac(
        'sha256',
        secretKey,
      )
        .update(launchParams)
        .digest('hex')

    const expected =
      Buffer.from(
        calculatedHash,
        'hex',
      )

    const received =
      Buffer.from(
        originalHash,
        'hex',
      )

    if (
      expected.length !==
        received.length ||
      !timingSafeEqual(
        expected,
        received,
      )
    ) {
      return null
    }

    const data =
      new Map(decoded)

    const authDate =
      Number(
        data.get('auth_date'),
      )

    if (
      !Number.isFinite(
        authDate,
      )
    ) {
      return null
    }

    // MAX рекомендует примерно
    // час жизни initData.
    const ageSeconds =
      Math.floor(
        Date.now() / 1000,
      ) - authDate

    if (
      ageSeconds < -300 ||
      ageSeconds > 3600
    ) {
      return null
    }

    const rawUser =
      data.get('user')

    if (!rawUser) {
      return null
    }

    const user =
      JSON.parse(
        rawUser,
      ) as VerifiedMaxUser

    if (
      typeof user.id !==
        'number' ||
      typeof user.first_name !==
        'string'
    ) {
      return null
    }

    return user
  } catch {
    return null
  }
}
