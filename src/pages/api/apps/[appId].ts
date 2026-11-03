import type { NextApiRequest, NextApiResponse } from 'next'
import { deleteApp, startApp, stopApp } from '~server/apps'
import { PublishError } from '~server/publisher'

// POST { action: 'stop' | 'start' } and DELETE act on one app
export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse,
) {
  const appId = String(req.query.appId)

  try {
    if (req.method === 'DELETE') {
      return res.status(200).json(await deleteApp(appId))
    }
    if (req.method === 'POST') {
      const action = req.body?.action
      if (action === 'stop') await stopApp(appId)
      else if (action === 'start') await startApp(appId)
      else return res.status(400).json({ error: 'action must be stop or start' })
      return res.status(200).json({ ok: true })
    }
    res.setHeader('Allow', 'POST, DELETE')
    return res.status(405).json({ error: 'POST or DELETE only' })
  } catch (e) {
    const status = e instanceof PublishError ? e.status : 500
    return res.status(status).json({ error: (e as Error).message })
  }
}
