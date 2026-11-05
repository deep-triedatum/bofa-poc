import type { NextApiRequest, NextApiResponse } from 'next'
import { deleteNamespace, getNamespace, saveNamespace } from '~server/env'
import { PublishError } from '~server/publisher'

// GET reads a namespace (names only). PUT { ait, shared?, set?, unset? } creates it or changes it.
// DELETE removes it unless an app still uses it.
export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse,
) {
  const name = String(req.query.namespace)
  try {
    if (req.method === 'GET') {
      return res.status(200).json(await getNamespace(name))
    }
    if (req.method === 'PUT') {
      return res.status(200).json(await saveNamespace(name, req.body || {}))
    }
    if (req.method === 'DELETE') {
      await deleteNamespace(name)
      return res.status(200).json({ deleted: true })
    }
    res.setHeader('Allow', 'GET, PUT, DELETE')
    return res.status(405).json({ error: 'GET, PUT or DELETE only' })
  } catch (e) {
    const status = e instanceof PublishError ? e.status : 500
    return res.status(status).json({ error: (e as Error).message })
  }
}
