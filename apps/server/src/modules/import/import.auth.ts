import type {
  FastifyReply,
  FastifyRequest,
} from 'fastify'

export async function requireImportApiKey(
  request: FastifyRequest,
  reply: FastifyReply,
) {
  const expectedKey = process.env.IMPORT_API_KEY

  if (!expectedKey) {
    request.log.error('IMPORT_API_KEY is not configured')

    return reply.status(500).send({
      error: 'IMPORT_API_KEY_NOT_CONFIGURED',
    })
  }

  const providedKey = request.headers['x-import-api-key']

  if (
    typeof providedKey !== 'string' ||
    providedKey !== expectedKey
  ) {
    return reply.status(401).send({
      error: 'UNAUTHORIZED',
    })
  }
}
