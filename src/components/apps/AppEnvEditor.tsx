import React, { useCallback, useEffect, useState } from 'react'
import { Badge, Box, Button, Heading, HStack, Text } from '@chakra-ui/react'
import { AppEnv, call, Namespace } from './api'
import VarEditor, { hasChanges, Row, toChanges } from './VarEditor'

type Props = {
  appId: string
  ait: string
  onBack: () => void
}

/** Which namespaces an app uses, in what order, and its own variables. */
const AppEnvEditor = ({ appId, ait, onBack }: Props) => {
  const [info, setInfo] = useState<AppEnv | null>(null)
  const [available, setAvailable] = useState<Namespace[]>([])
  const [selected, setSelected] = useState<string[]>([])
  const [rows, setRows] = useState<Row[]>([])
  const [removed, setRemoved] = useState<string[]>([])
  const [error, setError] = useState('')
  const [saving, setSaving] = useState(false)

  // the form is filled once and after a save; the status keeps refreshing on its own
  const loadForm = useCallback(async () => {
    try {
      const [env, list] = await Promise.all([
        call<AppEnv>(`/api/apps/${appId}/env`),
        call<{ namespaces: Namespace[] }>(
          `/api/env?ait=${encodeURIComponent(ait)}`,
        ),
      ])
      setInfo(env)
      setAvailable(list.namespaces)
      setSelected(env.namespaces)
      setRows([])
      setRemoved([])
      setError('')
    } catch (e) {
      setError((e as Error).message)
    }
  }, [appId, ait])

  useEffect(() => {
    loadForm()
  }, [loadForm])

  useEffect(() => {
    const timer = setInterval(async () => {
      try {
        setInfo(await call<AppEnv>(`/api/apps/${appId}/env`))
      } catch {}
    }, 3000)
    return () => clearInterval(timer)
  }, [appId])

  const listChanged =
    !!info && JSON.stringify(selected) !== JSON.stringify(info.namespaces)
  const dirty = listChanged || hasChanges(rows, removed)

  const move = (i: number, by: number) => {
    const next = [...selected]
    const [item] = next.splice(i, 1)
    next.splice(i + by, 0, item)
    setSelected(next)
  }

  const save = async () => {
    setSaving(true)
    try {
      const { set, unset } = toChanges(rows, removed)
      await call(`/api/apps/${appId}/env`, 'PUT', {
        ...(listChanged ? { namespaces: selected } : {}),
        ...(Object.keys(set).length ? { set } : {}),
        ...(unset.length ? { unset } : {}),
      })
      await loadForm()
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setSaving(false)
    }
  }

  const unattached = available.filter(n => !selected.includes(n.name))

  return (
    <Box>
      <Button size="xs" variant="ghost" mb={2} onClick={onBack}>
        ← Back to applications
      </Button>
      <HStack mb={3}>
        <Heading size="sm">Environment of {appId}</Heading>
        {info &&
          (info.applied ? (
            <Badge colorScheme="green">applied</Badge>
          ) : (
            <Badge colorScheme="orange">restart pending</Badge>
          ))}
      </HStack>
      {info && !info.applied && (
        <Text fontSize="xs" color="gray.500" mb={2}>
          The VM that runs the app restarts it within a few seconds to pick up
          the new variables. A stopped app picks them up when it is started.
        </Text>
      )}

      <Text fontSize="sm" fontWeight="bold" mb={1}>
        Namespaces, in order (later ones win)
      </Text>
      {selected.length === 0 && (
        <Text fontSize="sm" color="gray.500" mb={1}>
          None attached.
        </Text>
      )}
      {selected.map((name, i) => {
        const ns = available.find(n => n.name === name)
        const missing = info?.missing.includes(name)
        const denied = info?.denied.includes(name)
        return (
          <HStack key={name} mb={1} spacing={2}>
            <Text fontSize="sm" w="11rem" noOfLines={1}>
              {i + 1}. {name}
            </Text>
            <Text
              fontSize="xs"
              fontFamily="mono"
              color="gray.500"
              maxW="22rem"
              noOfLines={1}
            >
              {ns ? ns.keys.join(', ') : ''}
            </Text>
            {missing && <Badge colorScheme="red">does not exist</Badge>}
            {denied && <Badge colorScheme="red">not allowed</Badge>}
            <Button
              size="xs"
              variant="ghost"
              isDisabled={i === 0}
              onClick={() => move(i, -1)}
            >
              ↑
            </Button>
            <Button
              size="xs"
              variant="ghost"
              isDisabled={i === selected.length - 1}
              onClick={() => move(i, 1)}
            >
              ↓
            </Button>
            <Button
              size="xs"
              variant="ghost"
              onClick={() => setSelected(selected.filter(n => n !== name))}
            >
              Detach
            </Button>
          </HStack>
        )
      })}
      {unattached.length > 0 && (
        <HStack mt={1} spacing={1} wrap="wrap">
          <Text fontSize="xs" color="gray.500">
            Attach:
          </Text>
          {unattached.map(n => (
            <Button
              key={n.name}
              size="xs"
              variant="outline"
              onClick={() => setSelected([...selected, n.name])}
            >
              + {n.name}
              {n.ait !== ait ? ` (${n.ait})` : ''}
            </Button>
          ))}
        </HStack>
      )}

      <Text fontSize="sm" fontWeight="bold" mt={5} mb={1}>
        This app&apos;s own variables (win over its namespaces)
      </Text>
      <VarEditor
        keys={info?.keys || []}
        rows={rows}
        onRows={setRows}
        removed={removed}
        onRemoved={setRemoved}
      />

      {info && (
        <Text fontSize="xs" color="gray.500" mt={4}>
          The app starts with:{' '}
          <span style={{ fontFamily: 'monospace' }}>
            {info.effectiveKeys.join(', ') || 'no extra variables'}
          </span>
          , plus PORT and BASE_PATH from the platform.
        </Text>
      )}
      {error && (
        <Text color="red.500" fontSize="sm" mt={3} whiteSpace="pre-wrap">
          {error}
        </Text>
      )}
      <HStack mt={4}>
        <Button
          size="sm"
          colorScheme="teal"
          isLoading={saving}
          isDisabled={!dirty}
          onClick={save}
        >
          Save
        </Button>
        <Button
          size="sm"
          variant="ghost"
          onClick={loadForm}
          isDisabled={!dirty}
        >
          Discard changes
        </Button>
      </HStack>
    </Box>
  )
}

export default AppEnvEditor
