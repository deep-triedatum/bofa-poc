import type { NextApiRequest, NextApiResponse } from 'next'
import { listApps } from '~server/apps'

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
    return res.status(200).json({ apps: await listApps({ ait }) })
  } catch (e) {
    return res.status(500).json({ error: (e as Error).message })
  }
}
