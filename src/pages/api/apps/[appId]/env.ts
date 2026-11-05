import type { NextApiRequest, NextApiResponse } from 'next'
import { getAppEnv, saveAppEnv } from '~server/env'
import { PublishError } from '~server/publisher'

// GET: the namespaces attached to an app and the names of its variables.
// PUT { namespaces?, set?, unset? }: attach namespaces (replaces the list) and/or change the app's own variables.
export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse,
) {
  const appId = String(req.query.appId)
  try {
    if (req.method === 'GET') return res.status(200).json(await getAppEnv(appId))
    if (req.method === 'PUT') {
      return res.status(200).json(await saveAppEnv(appId, req.body || {}))
    }
    res.setHeader('Allow', 'GET, PUT')
    return res.status(405).json({ error: 'GET or PUT only' })
  } catch (e) {
    const status = e instanceof PublishError ? e.status : 500
    return res.status(status).json({ error: (e as Error).message })
  }
}
