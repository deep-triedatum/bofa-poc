import React, { useState } from 'react'
import {
  Badge,
  Box,
  Button,
  Checkbox,
  FormControl,
  FormHelperText,
  FormLabel,
  Heading,
  HStack,
  Input,
  Text,
} from '@chakra-ui/react'
import { call, Namespace } from './api'
import VarEditor, { hasChanges, Row, toChanges } from './VarEditor'

type Props = {
  /** the namespace being edited, or null to create one */
  namespace: Namespace | null
  defaultAit: string
  onDone: () => void
}

const NamespaceEditor = ({ namespace, defaultAit, onDone }: Props) => {
  const creating = !namespace
  const [name, setName] = useState(namespace?.name || '')
  const [ait, setAit] = useState(namespace?.ait || defaultAit)
  const [shared, setShared] = useState(namespace?.shared || false)
  const [rows, setRows] = useState<Row[]>([])
  const [removed, setRemoved] = useState<string[]>([])
  const [error, setError] = useState('')
  const [saving, setSaving] = useState(false)

  const dirty =
    creating || shared !== namespace?.shared || hasChanges(rows, removed)
  const usedBy = namespace?.usedBy || []

  const save = async () => {
    setSaving(true)
    try {
      const { set, unset } = toChanges(rows, removed)
      await call(`/api/env/${name}`, 'PUT', {
        ...(creating ? { ait } : {}),
        shared,
        set,
        unset,
      })
      onDone()
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setSaving(false)
    }
  }

  return (
    <Box>
      <Button size="xs" variant="ghost" mb={2} onClick={onDone}>
        ← Back
      </Button>
      <Heading size="sm" mb={3}>
        {creating ? 'New namespace' : `Namespace ${namespace?.name}`}
      </Heading>

      <HStack align="flex-start" spacing={4} mb={3}>
        <FormControl maxW="16rem" isDisabled={!creating}>
          <FormLabel fontSize="sm">Name</FormLabel>
          <Input
            size="sm"
            placeholder="payments"
            value={name}
            onChange={e => setName(e.target.value.toLowerCase())}
          />
          <FormHelperText fontSize="xs">3-40: a-z, 0-9, dashes</FormHelperText>
        </FormControl>
        <FormControl maxW="16rem" isDisabled={!creating}>
          <FormLabel fontSize="sm">AIT</FormLabel>
          <Input
            size="sm"
            placeholder="default"
            value={ait}
            onChange={e => setAit(e.target.value.toLowerCase())}
          />
          <FormHelperText fontSize="xs">
            Only this AIT can change it
          </FormHelperText>
        </FormControl>
      </HStack>

      <Checkbox
        isChecked={shared}
        onChange={e => setShared(e.target.checked)}
        mb={3}
      >
        <Text fontSize="sm">Let apps of other AITs attach this namespace</Text>
      </Checkbox>

      {usedBy.length > 0 && (
        <Box mb={3} fontSize="sm">
          Used by{' '}
          {usedBy.map(a => (
            <Badge key={a} mr={1}>
              {a}
            </Badge>
          ))}
          <Text fontSize="xs" color="gray.500">
            Changing a value restarts these apps, each on its own VM, within a
            few seconds.
          </Text>
        </Box>
      )}

      <Text fontSize="sm" fontWeight="bold" mb={1}>
        Variables
      </Text>
      <VarEditor
        keys={namespace?.keys || []}
        rows={rows}
        onRows={setRows}
        removed={removed}
        onRemoved={setRemoved}
      />

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
          isDisabled={!dirty || !name || (creating && !ait)}
          onClick={save}
        >
          {creating ? 'Create' : 'Save'}
        </Button>
        <Button size="sm" variant="ghost" onClick={onDone}>
          Cancel
        </Button>
      </HStack>
    </Box>
  )
}

export default NamespaceEditor
