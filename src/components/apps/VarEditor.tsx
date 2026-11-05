import React from 'react'
import { Box, Button, HStack, Input, Tag, Text } from '@chakra-ui/react'

export type Row = { name: string; value: string }

/** The `set` and `unset` the env API expects, from the rows and removals made in the editor. */
export const toChanges = (rows: Row[], removed: string[]) => {
  const set = Object.fromEntries(
    rows.filter(r => r.name.trim()).map(r => [r.name.trim(), r.value]),
  )
  return {
    set,
    // a name that is also set again is an overwrite, not a removal
    unset: removed.filter(k => !(k in set)),
  }
}

export const hasChanges = (rows: Row[], removed: string[]) => {
  const { set, unset } = toChanges(rows, removed)
  return Object.keys(set).length > 0 || unset.length > 0
}

type Props = {
  /** names of the variables that exist now. Their values are never sent to the browser */
  keys: string[]
  rows: Row[]
  onRows: (rows: Row[]) => void
  removed: string[]
  onRemoved: (removed: string[]) => void
}

const VarEditor = ({ keys, rows, onRows, removed, onRemoved }: Props) => (
  <Box>
    {keys.length === 0 && rows.length === 0 && (
      <Text fontSize="sm" color="gray.500" mb={2}>
        No variables yet.
      </Text>
    )}

    {keys.map(key => {
      const gone = removed.includes(key)
      return (
        <HStack key={key} mb={1} spacing={2}>
          <Tag
            size="md"
            colorScheme={gone ? 'red' : 'gray'}
            textDecoration={gone ? 'line-through' : 'none'}
            fontFamily="mono"
          >
            {key}
          </Tag>
          <Text fontSize="xs" color="gray.500">
            {gone ? 'will be removed' : 'value hidden'}
          </Text>
          <Button
            size="xs"
            variant="ghost"
            onClick={() =>
              onRemoved(
                gone ? removed.filter(k => k !== key) : [...removed, key],
              )
            }
          >
            {gone ? 'Undo' : 'Remove'}
          </Button>
          {!gone && (
            <Button
              size="xs"
              variant="ghost"
              onClick={() =>
                onRows([
                  ...rows.filter(r => r.name !== key),
                  { name: key, value: '' },
                ])
              }
            >
              Change value
            </Button>
          )}
        </HStack>
      )
    })}

    {rows.map((row, i) => (
      <HStack key={i} mb={1} spacing={2}>
        <Input
          size="sm"
          maxW="14rem"
          fontFamily="mono"
          placeholder="NAME"
          value={row.name}
          onChange={e =>
            onRows(
              rows.map((r, j) =>
                j === i ? { ...r, name: e.target.value.replace(/\s/g, '') } : r,
              ),
            )
          }
        />
        <Input
          size="sm"
          type="password"
          autoComplete="new-password"
          placeholder="value"
          value={row.value}
          onChange={e =>
            onRows(
              rows.map((r, j) =>
                j === i ? { ...r, value: e.target.value } : r,
              ),
            )
          }
        />
        <Button
          size="xs"
          variant="ghost"
          onClick={() => onRows(rows.filter((_, j) => j !== i))}
        >
          ✕
        </Button>
      </HStack>
    ))}

    <Button
      size="xs"
      mt={1}
      onClick={() => onRows([...rows, { name: '', value: '' }])}
    >
      + Add variable
    </Button>
  </Box>
)

export default VarEditor
