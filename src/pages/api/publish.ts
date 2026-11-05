import type { NextApiRequest, NextApiResponse } from 'next'
import { publish, PublishError } from '~server/publisher'

export const config = {
  api: { bodyParser: { sizeLimit: '5mb' } },
}

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse,
) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST')
    return res.status(405).json({ error: 'POST only' })
  }

  const { components, appId, ait, name, envNamespaces } = req.body || {}
  if (!components?.root) {
    return res.status(400).json({ error: 'components with a root is required' })
  }

  try {
    const result = await publish(components, {
      appId,
      ait: ait || process.env.DEFAULT_AIT || 'default',
      name,
      envNamespaces,
    })
    return res.status(200).json(result)
  } catch (e) {
    const status = e instanceof PublishError ? e.status : 500
    return res.status(status).json({ error: (e as Error).message })
  }
}
