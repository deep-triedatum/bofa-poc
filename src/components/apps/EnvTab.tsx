import React, { useCallback, useEffect, useState } from 'react'
import {
  Badge,
  Box,
  Button,
  HStack,
  Table,
  Tbody,
  Td,
  Text,
  Th,
  Thead,
  Tr,
} from '@chakra-ui/react'
import { call, Namespace } from './api'
import NamespaceEditor from './NamespaceEditor'

/** The "Environment" tab: namespaces of variables that apps can share. */
const EnvTab = ({ ait, active }: { ait: string; active: boolean }) => {
  const [namespaces, setNamespaces] = useState<Namespace[]>([])
  const [editing, setEditing] = useState<Namespace | 'new' | null>(null)
  const [error, setError] = useState('')

  const load = useCallback(async () => {
    try {
      const body = await call<{ namespaces: Namespace[] }>(
        '/api/env' + (ait ? `?ait=${encodeURIComponent(ait)}` : ''),
      )
      setNamespaces(body.namespaces)
      setError('')
    } catch (e) {
      setError((e as Error).message)
    }
  }, [ait])

  // not while editing, so the form is not replaced under the user
  useEffect(() => {
    if (!active || editing) return
    load()
    const timer = setInterval(load, 3000)
    return () => clearInterval(timer)
  }, [active, editing, load])

  const remove = async (ns: Namespace) => {
    if (!window.confirm(`Delete namespace "${ns.name}" and its variables?`))
      return
    try {
      await call(`/api/env/${ns.name}`, 'DELETE')
      load()
    } catch (e) {
      setError((e as Error).message)
    }
  }

  if (editing) {
    return (
      <NamespaceEditor
        namespace={editing === 'new' ? null : editing}
        defaultAit={ait}
        onDone={() => {
          setEditing(null)
          load()
        }}
      />
    )
  }

  return (
    <Box>
      <HStack mb={2} justify="space-between">
        <Text fontSize="sm" color="gray.600" maxW="40rem">
          A namespace is a named set of environment variables. Attach it to any
          number of apps (button <b>Env</b> on the Applications tab). Values are
          write-only: they are never shown again.
        </Text>
        <Button size="sm" colorScheme="teal" onClick={() => setEditing('new')}>
          New namespace
        </Button>
      </HStack>

      {error && (
        <Text color="red.500" fontSize="sm" mb={2} whiteSpace="pre-wrap">
          {error}
        </Text>
      )}

      {namespaces.length === 0 && !error ? (
        <Text fontSize="sm" color="gray.500">
          No namespaces{ait ? ` for AIT "${ait}"` : ''} yet.
        </Text>
      ) : (
        <Table size="sm">
          <Thead>
            <Tr>
              <Th>Namespace</Th>
              <Th>AIT</Th>
              <Th>Variables</Th>
              <Th>Used by</Th>
              <Th>Actions</Th>
            </Tr>
          </Thead>
          <Tbody>
            {namespaces.map(ns => (
              <Tr key={ns.name}>
                <Td>
                  {ns.name}
                  {ns.shared && (
                    <Badge ml={2} colorScheme="purple">
                      shared
                    </Badge>
                  )}
                </Td>
                <Td>{ns.ait}</Td>
                <Td
                  fontSize="xs"
                  fontFamily="mono"
                  maxW="22rem"
                  whiteSpace="normal"
                >
                  {ns.keys.join(', ') || '-'}
                </Td>
                <Td fontSize="xs">{ns.usedBy.join(', ') || '-'}</Td>
                <Td>
                  <HStack spacing={1}>
                    <Button size="xs" onClick={() => setEditing(ns)}>
                      Edit
                    </Button>
                    <Button
                      size="xs"
                      colorScheme="red"
                      variant="outline"
                      isDisabled={ns.usedBy.length > 0}
                      title={
                        ns.usedBy.length
                          ? 'Detach it from its apps first'
                          : undefined
                      }
                      onClick={() => remove(ns)}
                    >
                      Delete
                    </Button>
                  </HStack>
                </Td>
              </Tr>
            ))}
          </Tbody>
        </Table>
      )}
    </Box>
  )
}

export default EnvTab
