import type {
  FastifyInstance,
} from 'fastify'

import {
  createReadStream,
} from 'node:fs'

import {
  stat,
} from 'node:fs/promises'

import {
  extname,
  resolve,
  sep,
} from 'node:path'

function getContentType(
  path: string,
) {
  switch (
    extname(path).toLowerCase()
  ) {
    case '.jpg':
    case '.jpeg':
    case '.jfif':
      return 'image/jpeg'

    case '.png':
      return 'image/png'

    case '.webp':
      return 'image/webp'

    case '.gif':
      return 'image/gif'

    case '.avif':
      return 'image/avif'

    default:
      return 'application/octet-stream'
  }
}

export async function mediaRoutes(
  app: FastifyInstance,
) {
  const outputRoot =
    process.env.PARSER_OUTPUT_ROOT ??
    '/home/matatik/afisha-data/output'

  const imagesRoot =
    resolve(
      outputRoot,
      'images',
    )

  app.get(
    '/events/*',
    async (
      request,
      reply,
    ) => {
      const params =
        request.params as {
          '*': string
        }

      let relativePath =
        params['*'] ?? ''

      try {
        relativePath =
          decodeURIComponent(
            relativePath,
          )
      } catch {
        return reply
          .status(400)
          .send({
            error:
              'INVALID_MEDIA_PATH',
          })
      }

      relativePath =
        relativePath
          .replace(/\\/g, '/')
          .replace(/^\/+/, '')

      if (
        !relativePath ||
        relativePath.includes('\0') ||
        relativePath
          .split('/')
          .includes('..')
      ) {
        return reply
          .status(404)
          .send({
            error:
              'MEDIA_NOT_FOUND',
          })
      }

      const filePath =
        resolve(
          imagesRoot,
          relativePath,
        )

      if (
        !filePath.startsWith(
          `${imagesRoot}${sep}`,
        )
      ) {
        return reply
          .status(404)
          .send({
            error:
              'MEDIA_NOT_FOUND',
          })
      }

      try {
        const info =
          await stat(
            filePath,
          )

        if (
          !info.isFile()
        ) {
          throw new Error(
            'NOT_FILE',
          )
        }
      } catch {
        return reply
          .status(404)
          .send({
            error:
              'MEDIA_NOT_FOUND',
          })
      }

      reply.header(
        'Content-Type',
        getContentType(
          filePath,
        ),
      )

      reply.header(
        'Cache-Control',
        'public, max-age=604800, immutable',
      )

      return reply.send(
        createReadStream(
          filePath,
        ),
      )
    },
  )
}
