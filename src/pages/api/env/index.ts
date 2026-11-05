import type { NextApiRequest, NextApiResponse } from 'next'
import { listNamespaces } from '~server/env'
import { PublishError } from '~server/publisher'

// GET /api/env or /api/env?ait=<ait>: the namespaces that AIT can attach (names of variables only)
export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse,
) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET')
    return res.status(405).json({ error: 'GET only' })
  }
  const ait = typeof req.query.ait === 'string' ? req.query.ait : undefined
  try {
    return res.status(200).json({ namespaces: await listNamespaces({ ait }) })
  } catch (e) {
    const status = e instanceof PublishError ? e.status : 500
    return res.status(status).json({ error: (e as Error).message })
  }
}
