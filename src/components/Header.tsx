import React, { memo, useState } from 'react'
import {
  Box,
  Switch,
  Button,
  Flex,
  Link,
  Stack,
  FormLabel,
  DarkMode,
  FormControl,
  Popover,
  PopoverTrigger,
  PopoverContent,
  PopoverArrow,
  PopoverCloseButton,
  PopoverHeader,
  PopoverBody,
  LightMode,
  PopoverFooter,
  Tooltip,
  HStack,
  Input,
  Text,
} from '@chakra-ui/react'
import { ExternalLinkIcon, SmallCloseIcon, CheckIcon } from '@chakra-ui/icons'
import { DiGithubBadge } from 'react-icons/di'
import { AiFillThunderbolt } from 'react-icons/ai'
import useDispatch from '~hooks/useDispatch'
import { useSelector } from 'react-redux'
import { getComponents } from '~core/selectors/components'
import { getShowLayout, getShowCode } from '~core/selectors/app'
import HeaderMenu from '~components/headerMenu/HeaderMenu'

const PublishButton = () => {
  const components = useSelector(getComponents)
  const [isLoading, setIsLoading] = useState(false)
  const [appId, setAppId] = useState('')
  const [ait, setAit] = useState('')
  const [error, setError] = useState('')
  const [result, setResult] = useState<{
    url: string
    directUrl: string
    release: number
  } | null>(null)

  const publish = async () => {
    setIsLoading(true)
    setError('')
    setResult(null)
    try {
      const res = await fetch('/api/publish', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ components, appId, ait: ait || undefined }),
      })
      const body = await res.json()
      if (!res.ok) throw new Error(body.error || res.statusText)
      setResult(body)
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setIsLoading(false)
    }
  }

  return (
    <Popover>
      <PopoverTrigger>
        <Button
          rightIcon={<ExternalLinkIcon path="" />}
          variant="ghost"
          size="xs"
        >
          Publish
        </Button>
      </PopoverTrigger>

      <LightMode>
        <PopoverContent zIndex={100} bg="white" width="22rem">
          <PopoverArrow />
          <PopoverCloseButton />
          <PopoverHeader>Publish application</PopoverHeader>
          <PopoverBody fontSize="sm">
            <Stack spacing={2}>
              <Input
                size="sm"
                placeholder="app id (e.g. my-first-app)"
                value={appId}
                onChange={e => setAppId(e.target.value.toLowerCase())}
              />
              <Input
                size="sm"
                placeholder="AIT (optional)"
                value={ait}
                onChange={e => setAit(e.target.value.toLowerCase())}
              />
              {error && (
                <Text color="red.500" fontSize="xs" whiteSpace="pre-wrap">
                  {error}
                </Text>
              )}
              {result && (
                <Text fontSize="xs">
                  Release {result.release} is running:{' '}
                  <Link
                    href={
                      result.url.startsWith('http')
                        ? result.url
                        : result.directUrl
                    }
                    isExternal
                    color="teal.500"
                  >
                    open application
                  </Link>
                </Text>
              )}
            </Stack>
          </PopoverBody>
          <PopoverFooter display="flex" justifyContent="flex-end">
            <Button
              size="sm"
              colorScheme="teal"
              isLoading={isLoading}
              loadingText="Building"
              isDisabled={appId.length < 3}
              onClick={publish}
            >
              Publish
            </Button>
          </PopoverFooter>
        </PopoverContent>
      </LightMode>
    </Popover>
  )
}

const Header = () => {
  const showLayout = useSelector(getShowLayout)
  const showCode = useSelector(getShowCode)
  const dispatch = useDispatch()

  return (
    <DarkMode>
      <Flex
        justifyContent="space-between"
        bg="#1a202c"
        as="header"
        height="3rem"
        px="1rem"
      >
        <Flex
          width="14rem"
          height="100%"
          backgroundColor="#1a202c"
          color="white"
          as="a"
          fontSize="xl"
          flexDirection="row"
          alignItems="center"
          aria-label="Chakra UI, Back to homepage"
        >
          <Box fontSize="2xl" as={AiFillThunderbolt} mr={1} color="teal.100" />{' '}
          <Box fontWeight="bold">open</Box>chakra
        </Flex>

        <Flex flexGrow={1} justifyContent="space-between" alignItems="center">
          <HStack spacing={4} justify="center" align="center">
            <Box>
              <HeaderMenu />
            </Box>
            <FormControl flexDirection="row" display="flex" alignItems="center">
              <Tooltip
                zIndex={100}
                hasArrow
                bg="yellow.100"
                aria-label="Builder mode help"
                label="Builder mode adds extra padding/borders"
              >
                <FormLabel
                  cursor="help"
                  color="gray.200"
                  fontSize="xs"
                  htmlFor="preview"
                  pb={0}
                  mb={0}
                  mr={2}
                  whiteSpace="nowrap"
                >
                  Builder mode
                </FormLabel>
              </Tooltip>
              <LightMode>
                <Switch
                  isChecked={showLayout}
                  colorScheme="teal"
                  size="sm"
                  onChange={() => dispatch.app.toggleBuilderMode()}
                  id="preview"
                />
              </LightMode>
            </FormControl>

            <FormControl display="flex" flexDirection="row" alignItems="center">
              <FormLabel
                color="gray.200"
                fontSize="xs"
                mr={2}
                mb={0}
                htmlFor="code"
                pb={0}
                whiteSpace="nowrap"
              >
                Code panel
              </FormLabel>
              <LightMode>
                <Switch
                  isChecked={showCode}
                  id="code"
                  colorScheme="teal"
                  onChange={() => dispatch.app.toggleCodePanel()}
                  size="sm"
                />
              </LightMode>
            </FormControl>
          </HStack>

          <Stack direction="row">
            <PublishButton />
            <Popover>
              {({ onClose }) => (
                <>
                  <PopoverTrigger>
                    <Button
                      ml={4}
                      rightIcon={<SmallCloseIcon path="" />}
                      size="xs"
                      variant="ghost"
                    >
                      Clear
                    </Button>
                  </PopoverTrigger>
                  <LightMode>
                    <PopoverContent zIndex={100} bg="white">
                      <PopoverArrow />
                      <PopoverCloseButton />
                      <PopoverHeader>Are you sure?</PopoverHeader>
                      <PopoverBody fontSize="sm">
                        Do you really want to remove all components on the
                        editor?
                      </PopoverBody>
                      <PopoverFooter display="flex" justifyContent="flex-end">
                        <Button
                          size="sm"
                          variant="ghost"
                          colorScheme="red"
                          rightIcon={<CheckIcon path="" />}
                          onClick={() => {
                            dispatch.components.reset()
                            if (onClose) {
                              onClose()
                            }
                          }}
                        >
                          Yes, clear
                        </Button>
                      </PopoverFooter>
                    </PopoverContent>
                  </LightMode>
                </>
              )}
            </Popover>
          </Stack>
        </Flex>

        <Stack
          justifyContent="flex-end"
          width="13rem"
          align="center"
          direction="row"
          spacing="2"
        >
          <Link isExternal href="https://github.com/premieroctet/openchakra">
            <Box as={DiGithubBadge} size={32} color="gray.200" />
          </Link>
          <Box lineHeight="shorter" color="white" fontSize="xs">
            by{' '}
            <Link isExternal href="https://premieroctet.com" color="teal.100">
              Premier Octet
            </Link>
          </Box>
        </Stack>
      </Flex>
    </DarkMode>
  )
}

export default memo(Header)
