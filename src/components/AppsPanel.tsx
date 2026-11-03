import React, { useCallback, useEffect, useState } from 'react'
import {
  Badge,
  Button,
  HStack,
  Input,
  LightMode,
  Link,
  Modal,
  ModalBody,
  ModalCloseButton,
  ModalContent,
  ModalHeader,
  ModalOverlay,
  Table,
  Tbody,
  Td,
  Text,
  Th,
  Thead,
  Tr,
  useDisclosure,
} from '@chakra-ui/react'

const STATUS_COLOR: Record<string, string> = {
  running: 'green',
  starting: 'yellow',
  stopped: 'gray',
  deleting: 'red',
  failed: 'red',
}

type Action = 'stop' | 'start' | 'delete'

// what GET /api/apps returns (see src/server/apps.ts); kept separate so no server code reaches the browser
type AppInfo = {
  appId: string
  ait: string
  status: 'running' | 'stopped' | 'starting' | 'deleting' | 'failed'
  vm: string
  port: number
  release: number
  restarts?: number
  url: string
  directUrl: string
  healthy: boolean
}

const AppsPanel = () => {
  const { isOpen, onOpen, onClose } = useDisclosure()
  const [apps, setApps] = useState<AppInfo[]>([])
  const [ait, setAit] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState('')

  const load = useCallback(async () => {
    try {
      const res = await fetch(
        '/api/apps' + (ait ? `?ait=${encodeURIComponent(ait)}` : ''),
      )
      const body = await res.json()
      if (!res.ok) throw new Error(body.error || res.statusText)
      setApps(body.apps)
      setError('')
    } catch (e) {
      setError((e as Error).message)
    }
  }, [ait])

  // refresh while the panel is open: apps change state on their own VM, a few seconds after a click
  useEffect(() => {
    if (!isOpen) return
    load()
    const timer = setInterval(load, 3000)
    return () => clearInterval(timer)
  }, [isOpen, load])

  const act = async (app: AppInfo, action: Action) => {
    if (
      action === 'delete' &&
      !window.confirm(
        `Delete "${app.appId}"? This stops it and removes all its releases. It cannot be undone.`,
      )
    ) {
      return
    }
    setBusy(app.appId)
    try {
      const res =
        action === 'delete'
          ? await fetch(`/api/apps/${app.appId}`, { method: 'DELETE' })
          : await fetch(`/api/apps/${app.appId}`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ action }),
            })
      if (!res.ok) throw new Error((await res.json()).error || res.statusText)
      setError('')
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy('')
      load()
    }
  }

  return (
    <>
      <Button ml={4} size="xs" variant="ghost" onClick={onOpen}>
        My apps
      </Button>

      <Modal
        isOpen={isOpen}
        onClose={onClose}
        size="6xl"
        scrollBehavior="inside"
      >
        <ModalOverlay />
        <LightMode>
          <ModalContent bg="white" color="gray.800">
            <ModalHeader>Published applications</ModalHeader>
            <ModalCloseButton />
            <ModalBody pb={6}>
              <HStack mb={3}>
                <Input
                  size="sm"
                  maxW="16rem"
                  placeholder="Filter by AIT (empty: all)"
                  value={ait}
                  onChange={e => setAit(e.target.value.toLowerCase())}
                />
                <Text fontSize="xs" color="gray.500">
                  Refreshes every 3 seconds
                </Text>
              </HStack>

              {error && (
                <Text
                  color="red.500"
                  fontSize="sm"
                  mb={2}
                  whiteSpace="pre-wrap"
                >
                  {error}
                </Text>
              )}

              {apps.length === 0 && !error ? (
                <Text fontSize="sm" color="gray.500">
                  No published applications{ait ? ` for AIT "${ait}"` : ''} yet.
                  Use Publish to create one.
                </Text>
              ) : (
                <Table size="sm">
                  <Thead>
                    <Tr>
                      <Th>App</Th>
                      <Th>AIT</Th>
                      <Th>Status</Th>
                      <Th>Runs on</Th>
                      <Th isNumeric>Release</Th>
                      <Th isNumeric>Restarts</Th>
                      <Th>Actions</Th>
                    </Tr>
                  </Thead>
                  <Tbody>
                    {apps.map(app => {
                      const disabled = busy === app.appId
                      const open = app.url.startsWith('http')
                        ? app.url
                        : app.directUrl
                      return (
                        <Tr key={app.appId}>
                          <Td>
                            {app.status === 'running' && app.healthy ? (
                              <Link href={open} isExternal color="teal.600">
                                {app.appId}
                              </Link>
                            ) : (
                              app.appId
                            )}
                          </Td>
                          <Td>{app.ait}</Td>
                          <Td>
                            <Badge colorScheme={STATUS_COLOR[app.status]}>
                              {app.status}
                            </Badge>
                            {app.status === 'running' && !app.healthy && (
                              <Badge ml={1} colorScheme="orange">
                                not answering
                              </Badge>
                            )}
                          </Td>
                          <Td fontSize="xs">
                            {app.vm} :{app.port}
                          </Td>
                          <Td isNumeric>{app.release}</Td>
                          <Td isNumeric>{app.restarts || 0}</Td>
                          <Td>
                            <HStack spacing={1}>
                              {app.status === 'running' ||
                              app.status === 'starting' ? (
                                <Button
                                  size="xs"
                                  isDisabled={
                                    disabled || app.status === 'starting'
                                  }
                                  onClick={() => act(app, 'stop')}
                                >
                                  Stop
                                </Button>
                              ) : (
                                <Button
                                  size="xs"
                                  colorScheme="teal"
                                  isDisabled={
                                    disabled || app.status === 'deleting'
                                  }
                                  onClick={() => act(app, 'start')}
                                >
                                  Start
                                </Button>
                              )}
                              <Button
                                size="xs"
                                colorScheme="red"
                                variant="outline"
                                isDisabled={
                                  disabled || app.status === 'deleting'
                                }
                                onClick={() => act(app, 'delete')}
                              >
                                Delete
                              </Button>
                            </HStack>
                          </Td>
                        </Tr>
                      )
                    })}
                  </Tbody>
                </Table>
              )}
            </ModalBody>
          </ModalContent>
        </LightMode>
      </Modal>
    </>
  )
}

export default AppsPanel
