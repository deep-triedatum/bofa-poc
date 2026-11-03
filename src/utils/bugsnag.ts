import React from 'react'
import bugsnag from '@bugsnag/js'
import bugsnagReact from '@bugsnag/plugin-react'

export const bugsnagClient = bugsnag({
  apiKey: process.env.NEXT_PUBLIC_BUGSNAG_API_KEY as string,
  releaseStage: process.env.NODE_ENV,
  // PoC: never report to the external Bugsnag service from the bank environment
  notifyReleaseStages: [],
})
bugsnagClient.use(bugsnagReact, React)

export const ErrorBoundary = bugsnagClient.getPlugin('react')
