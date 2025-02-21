/**
 * Copyright (c) Streamlit Inc. (2018-2022) Snowflake Inc. (2022-2025)
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import axios from "axios"
import { default as WS } from "vitest-websocket-mock"
import zip from "lodash/zip"

import { BackMsg } from "@streamlit/protobuf"

import { ConnectionState } from "./ConnectionState"
import { Args, WebsocketConnection } from "./WebsocketConnection"
import { CORS_ERROR_MESSAGE_DOCUMENTATION_LINK } from "./constants"
import { doInitPings } from "./DoInitPings"
import { mockEndpoints } from "./testUtils"

const MOCK_ALLOWED_ORIGINS_CONFIG = {
  allowedOrigins: ["list", "of", "allowed", "origins"],
  useExternalAuthToken: false,
}

const MOCK_HOST_CONFIG_RESPONSE = {
  data: MOCK_ALLOWED_ORIGINS_CONFIG,
}

const MOCK_HEALTH_RESPONSE = { status: "ok" }

/** Create mock WebsocketConnection arguments */
function createMockArgs(overrides?: Partial<Args>): Args {
  return {
    getLastSessionId: () => undefined,
    endpoints: mockEndpoints(),
    baseUriPartsList: [
      {
        hostname: "localhost",
        port: "1234",
        pathname: "/",
      } as URL,
    ],
    onMessage: vi.fn(),
    onConnectionStateChange: vi.fn(),
    onRetry: vi.fn(),
    claimHostAuthToken: () => Promise.resolve(undefined),
    resetHostAuthToken: vi.fn(),
    onHostConfigResp: vi.fn(),
    ...overrides,
  }
}

describe("doInitPings", () => {
  const MOCK_PING_DATA = {
    uri: [
      { hostname: "not.a.real.host", port: "3000", pathname: "/" },
      { hostname: "not.a.real.host", port: "3001", pathname: "/" },
    ] as URL[],
    timeoutMs: 10,
    maxTimeoutMs: 100,
    retryCallback: vi.fn(),
    setAllowedOrigins: vi.fn(),
  }

  let originalAxiosGet: any

  beforeEach(() => {
    originalAxiosGet = axios.get
    MOCK_PING_DATA.retryCallback = vi.fn()
    MOCK_PING_DATA.setAllowedOrigins = vi.fn()
  })

  afterEach(() => {
    axios.get = originalAxiosGet
  })

  it("calls the /_stcore/health endpoint when pinging server", async () => {
    axios.get = vi
      .fn()
      .mockResolvedValueOnce(MOCK_HEALTH_RESPONSE)
      .mockResolvedValueOnce(MOCK_HOST_CONFIG_RESPONSE)

    const uriIndex = await doInitPings(
      MOCK_PING_DATA.uri,
      MOCK_PING_DATA.timeoutMs,
      MOCK_PING_DATA.maxTimeoutMs,
      MOCK_PING_DATA.retryCallback,
      MOCK_PING_DATA.setAllowedOrigins
    )
    expect(uriIndex).toEqual(0)
    expect(MOCK_PING_DATA.setAllowedOrigins).toHaveBeenCalledWith(
      MOCK_ALLOWED_ORIGINS_CONFIG
    )
  })

  it("returns the uri index and sets hostConfig for the first successful ping (0)", async () => {
    axios.get = vi
      .fn()
      .mockResolvedValueOnce("")
      .mockResolvedValueOnce(MOCK_HOST_CONFIG_RESPONSE)

    const uriIndex = await doInitPings(
      MOCK_PING_DATA.uri,
      MOCK_PING_DATA.timeoutMs,
      MOCK_PING_DATA.maxTimeoutMs,
      MOCK_PING_DATA.retryCallback,
      MOCK_PING_DATA.setAllowedOrigins
    )
    expect(uriIndex).toEqual(0)
    expect(MOCK_PING_DATA.setAllowedOrigins).toHaveBeenCalledWith(
      MOCK_ALLOWED_ORIGINS_CONFIG
    )
  })

  it("returns the uri index and sets hostConfig for the first successful ping (1)", async () => {
    axios.get = vi
      .fn()
      // First Connection attempt
      .mockRejectedValueOnce(new Error(""))
      .mockResolvedValueOnce(MOCK_HOST_CONFIG_RESPONSE)
      // Second Connection attempt
      .mockResolvedValueOnce("")
      .mockResolvedValueOnce(MOCK_HOST_CONFIG_RESPONSE)

    const uriIndex = await doInitPings(
      MOCK_PING_DATA.uri,
      MOCK_PING_DATA.timeoutMs,
      MOCK_PING_DATA.maxTimeoutMs,
      MOCK_PING_DATA.retryCallback,
      MOCK_PING_DATA.setAllowedOrigins
    )
    expect(uriIndex).toEqual(1)
    expect(MOCK_PING_DATA.setAllowedOrigins).toHaveBeenCalledWith(
      MOCK_ALLOWED_ORIGINS_CONFIG
    )
  })

  it("calls retry with the corresponding error message if there was an error", async () => {
    const TEST_ERROR_MESSAGE = "ERROR_MESSAGE"

    axios.get = vi
      .fn()
      // First Connection attempt
      .mockRejectedValueOnce(new Error(TEST_ERROR_MESSAGE))
      .mockResolvedValueOnce(MOCK_HOST_CONFIG_RESPONSE)
      // Second Connection attempt
      .mockResolvedValueOnce("")
      .mockResolvedValueOnce(MOCK_HOST_CONFIG_RESPONSE)

    await doInitPings(
      MOCK_PING_DATA.uri,
      MOCK_PING_DATA.timeoutMs,
      MOCK_PING_DATA.maxTimeoutMs,
      MOCK_PING_DATA.retryCallback,
      MOCK_PING_DATA.setAllowedOrigins
    )

    expect(MOCK_PING_DATA.retryCallback).toHaveBeenCalledWith(
      1,
      TEST_ERROR_MESSAGE,
      expect.anything()
    )
  })

  it("calls retry with 'Connection timed out.' when the error code is `ECONNABORTED`", async () => {
    const TEST_ERROR = { code: "ECONNABORTED" }

    axios.get = vi
      .fn()
      // First Connection attempt
      .mockRejectedValueOnce(TEST_ERROR)
      .mockResolvedValueOnce(MOCK_HOST_CONFIG_RESPONSE)
      // Second Connection attempt
      .mockResolvedValueOnce("")
      .mockResolvedValueOnce(MOCK_HOST_CONFIG_RESPONSE)

    await doInitPings(
      MOCK_PING_DATA.uri,
      MOCK_PING_DATA.timeoutMs,
      MOCK_PING_DATA.maxTimeoutMs,
      MOCK_PING_DATA.retryCallback,
      MOCK_PING_DATA.setAllowedOrigins
    )

    expect(MOCK_PING_DATA.retryCallback).toHaveBeenCalledWith(
      1,
      "Connection timed out.",
      expect.anything()
    )
  })

  it("calls retry with 'Connection failed with status 0.' when there is no response", async () => {
    const TEST_ERROR = {
      response: {
        status: 0,
      },
    }

    axios.get = vi
      .fn()
      // First Connection attempt
      .mockRejectedValueOnce(TEST_ERROR)
      .mockResolvedValueOnce(MOCK_HOST_CONFIG_RESPONSE)
      // Second Connection attempt
      .mockResolvedValueOnce("")
      .mockResolvedValueOnce(MOCK_HOST_CONFIG_RESPONSE)

    await doInitPings(
      MOCK_PING_DATA.uri,
      MOCK_PING_DATA.timeoutMs,
      MOCK_PING_DATA.maxTimeoutMs,
      MOCK_PING_DATA.retryCallback,
      MOCK_PING_DATA.setAllowedOrigins
    )

    expect(MOCK_PING_DATA.retryCallback).toHaveBeenCalledWith(
      1,
      "Connection failed with status 0.",
      expect.anything()
    )
  })

  it("calls retry with 'Connection failed with status 0.' when the request was made but no response was received", async () => {
    const TEST_ERROR = {
      request: {},
    }

    axios.get = vi
      .fn()
      // First Connection attempt
      .mockRejectedValueOnce(TEST_ERROR)
      .mockResolvedValueOnce(MOCK_HOST_CONFIG_RESPONSE)
      // Second Connection attempt
      .mockResolvedValueOnce("")
      .mockResolvedValueOnce(MOCK_HOST_CONFIG_RESPONSE)

    await doInitPings(
      MOCK_PING_DATA.uri,
      MOCK_PING_DATA.timeoutMs,
      MOCK_PING_DATA.maxTimeoutMs,
      MOCK_PING_DATA.retryCallback,
      MOCK_PING_DATA.setAllowedOrigins
    )

    expect(MOCK_PING_DATA.retryCallback).toHaveBeenCalledWith(
      1,
      "Connection failed with status 0.",
      expect.anything()
    )
  })

  it("calls retry with corresponding fragment when there is no response from localhost", async () => {
    const MOCK_PING_DATA_LOCALHOST = {
      ...MOCK_PING_DATA,
      uri: [
        { hostname: "localhost", port: "3000", pathname: "/" },
        { hostname: "localhost", port: "3001", pathname: "/" },
      ] as URL[],
    }

    const TEST_ERROR = {
      response: {
        status: 0,
      },
    }

    axios.get = vi
      .fn()
      // First Connection attempt
      .mockRejectedValueOnce(TEST_ERROR)
      .mockResolvedValueOnce(MOCK_HOST_CONFIG_RESPONSE)
      // Second Connection attempt
      .mockResolvedValueOnce("")
      .mockResolvedValueOnce(MOCK_HOST_CONFIG_RESPONSE)

    await doInitPings(
      MOCK_PING_DATA_LOCALHOST.uri,
      MOCK_PING_DATA_LOCALHOST.timeoutMs,
      MOCK_PING_DATA.maxTimeoutMs,
      MOCK_PING_DATA_LOCALHOST.retryCallback,
      MOCK_PING_DATA.setAllowedOrigins
    )

    expect(MOCK_PING_DATA_LOCALHOST.retryCallback).toHaveBeenCalledWith(
      1,
      expect.anything(),
      expect.anything()
    )
  })

  it("calls retry with corresponding fragment when the status is 403 (forbidden)", async () => {
    const TEST_ERROR = {
      response: {
        status: 403,
      },
    }

    const forbiddenMarkdown = `Cannot connect to Streamlit (HTTP status: 403).

If you are trying to access a Streamlit app running on another server, this could be due to the app's [CORS](${CORS_ERROR_MESSAGE_DOCUMENTATION_LINK}) settings.`

    axios.get = vi
      .fn()
      // First Connection attempt
      .mockRejectedValueOnce(TEST_ERROR)
      .mockResolvedValueOnce(MOCK_HOST_CONFIG_RESPONSE)
      // Second Connection attempt
      .mockResolvedValueOnce("")
      .mockResolvedValueOnce(MOCK_HOST_CONFIG_RESPONSE)

    await doInitPings(
      MOCK_PING_DATA.uri,
      MOCK_PING_DATA.timeoutMs,
      MOCK_PING_DATA.maxTimeoutMs,
      MOCK_PING_DATA.retryCallback,
      MOCK_PING_DATA.setAllowedOrigins
    )

    expect(MOCK_PING_DATA.retryCallback).toHaveBeenCalledWith(
      1,
      forbiddenMarkdown,
      expect.anything()
    )
  })

  it("calls retry with 'Connection failed with status ...' for any status code other than 0, 403, and 2xx", async () => {
    const TEST_ERROR = {
      response: {
        status: 500,
        data: "TEST_DATA",
      },
    }

    axios.get = vi
      .fn()
      // First Connection attempt
      .mockRejectedValueOnce(TEST_ERROR)
      .mockResolvedValueOnce(MOCK_HOST_CONFIG_RESPONSE)
      // Second Connection attempt
      .mockResolvedValueOnce("")
      .mockResolvedValueOnce(MOCK_HOST_CONFIG_RESPONSE)

    await doInitPings(
      MOCK_PING_DATA.uri,
      MOCK_PING_DATA.timeoutMs,
      MOCK_PING_DATA.maxTimeoutMs,
      MOCK_PING_DATA.retryCallback,
      MOCK_PING_DATA.setAllowedOrigins
    )

    expect(MOCK_PING_DATA.retryCallback).toHaveBeenCalledWith(
      1,
      `Connection failed with status ${TEST_ERROR.response.status}, and response "${TEST_ERROR.response.data}".`,
      expect.anything()
    )
  })

  it("calls retry with correct total tries", async () => {
    const TEST_ERROR_MESSAGE = "TEST_ERROR_MESSAGE"

    axios.get = vi
      .fn()
      // First Connection attempt
      .mockRejectedValueOnce(TEST_ERROR_MESSAGE)
      .mockResolvedValueOnce(MOCK_HOST_CONFIG_RESPONSE)
      // Second Connection attempt
      .mockRejectedValueOnce(TEST_ERROR_MESSAGE)
      .mockResolvedValueOnce(MOCK_HOST_CONFIG_RESPONSE)
      // Third Connection attempt
      .mockRejectedValueOnce(TEST_ERROR_MESSAGE)
      .mockResolvedValueOnce(MOCK_HOST_CONFIG_RESPONSE)
      // Fourth Connection attempt
      .mockRejectedValueOnce(TEST_ERROR_MESSAGE)
      .mockResolvedValueOnce(MOCK_HOST_CONFIG_RESPONSE)
      // Fifth Connection attempt
      .mockRejectedValueOnce(TEST_ERROR_MESSAGE)
      .mockResolvedValueOnce(MOCK_HOST_CONFIG_RESPONSE)
      // Final Attempt (to avoid infinite loop)
      .mockResolvedValueOnce("")
      .mockResolvedValueOnce(MOCK_HOST_CONFIG_RESPONSE)

    await doInitPings(
      MOCK_PING_DATA.uri,
      MOCK_PING_DATA.timeoutMs,
      MOCK_PING_DATA.maxTimeoutMs,
      MOCK_PING_DATA.retryCallback,
      MOCK_PING_DATA.setAllowedOrigins
    )

    expect(MOCK_PING_DATA.retryCallback).toHaveBeenCalledTimes(5)
  })

  it("has increasing but capped retry backoff", async () => {
    const TEST_ERROR_MESSAGE = "TEST_ERROR_MESSAGE"

    axios.get = vi
      .fn()
      // First Connection attempt
      .mockRejectedValueOnce(TEST_ERROR_MESSAGE)
      .mockResolvedValueOnce(MOCK_HOST_CONFIG_RESPONSE)
      // Second Connection attempt
      .mockRejectedValueOnce(TEST_ERROR_MESSAGE)
      .mockResolvedValueOnce(MOCK_HOST_CONFIG_RESPONSE)
      // Third Connection attempt
      .mockRejectedValueOnce(TEST_ERROR_MESSAGE)
      .mockResolvedValueOnce(MOCK_HOST_CONFIG_RESPONSE)
      // Fourth Connection attempt
      .mockRejectedValueOnce(TEST_ERROR_MESSAGE)
      .mockResolvedValueOnce(MOCK_HOST_CONFIG_RESPONSE)
      // Fifth Connection attempt
      .mockRejectedValueOnce(TEST_ERROR_MESSAGE)
      .mockResolvedValueOnce(MOCK_HOST_CONFIG_RESPONSE)
      // Final Attempt (to avoid infinite loop)
      .mockResolvedValueOnce("")
      .mockResolvedValueOnce(MOCK_HOST_CONFIG_RESPONSE)

    const timeouts: number[] = []
    const callback = (
      _times: number,
      _errorNode: React.ReactNode,
      timeout: number
    ): void => {
      timeouts.push(timeout)
    }

    await doInitPings(
      [
        {
          hostname: "not.a.real.host",
          port: "3000",
          pathname: "/",
        } as URL,
      ],
      MOCK_PING_DATA.timeoutMs,
      MOCK_PING_DATA.maxTimeoutMs,
      callback,
      MOCK_PING_DATA.setAllowedOrigins
    )

    expect(timeouts.length).toEqual(5)
    expect(timeouts[0]).toEqual(10)
    expect(timeouts[4]).toEqual(100)
    // timeouts should be monotonically increasing until they hit the cap
    expect(
      zip(timeouts.slice(0, -1), timeouts.slice(1)).every(
        // @ts-expect-error
        timePair => timePair[0] < timePair[1] || timePair[0] === 100
      )
    ).toEqual(true)
  })

  it("backs off independently for each target url", async () => {
    const TEST_ERROR_MESSAGE = "TEST_ERROR_MESSAGE"

    axios.get = vi
      .fn()
      // First Connection attempt
      .mockRejectedValueOnce(TEST_ERROR_MESSAGE)
      .mockResolvedValueOnce(MOCK_HOST_CONFIG_RESPONSE)
      // Second Connection attempt
      .mockRejectedValueOnce(TEST_ERROR_MESSAGE)
      .mockResolvedValueOnce(MOCK_HOST_CONFIG_RESPONSE)
      // Third Connection attempt
      .mockRejectedValueOnce(TEST_ERROR_MESSAGE)
      .mockResolvedValueOnce(MOCK_HOST_CONFIG_RESPONSE)
      // Fourth Connection attempt
      .mockRejectedValueOnce(TEST_ERROR_MESSAGE)
      .mockResolvedValueOnce(MOCK_HOST_CONFIG_RESPONSE)
      // Fifth Connection attempt
      .mockRejectedValueOnce(TEST_ERROR_MESSAGE)
      .mockResolvedValueOnce(MOCK_HOST_CONFIG_RESPONSE)
      // Final Attempt (to avoid infinite loop)
      .mockResolvedValueOnce("")
      .mockResolvedValueOnce(MOCK_HOST_CONFIG_RESPONSE)

    const timeouts: number[] = []
    const callback = (
      _times: number,
      _errorNode: React.ReactNode,
      timeout: number
    ): void => {
      timeouts.push(timeout)
    }

    await doInitPings(
      MOCK_PING_DATA.uri,
      MOCK_PING_DATA.timeoutMs,
      MOCK_PING_DATA.maxTimeoutMs,
      callback,
      MOCK_PING_DATA.setAllowedOrigins
    )

    expect(timeouts.length).toEqual(5)
    expect(timeouts[0]).toEqual(10)
    expect(timeouts[1]).toEqual(10)
    expect(timeouts[2]).toBeGreaterThan(timeouts[0])
    expect(timeouts[3]).toBeGreaterThan(timeouts[1])
  })

  it("resets timeout each ping call", async () => {
    const TEST_ERROR_MESSAGE = "TEST_ERROR_MESSAGE"

    axios.get = vi
      .fn()
      // First Connection attempt
      .mockRejectedValueOnce(TEST_ERROR_MESSAGE)
      .mockResolvedValueOnce(MOCK_HOST_CONFIG_RESPONSE)
      // Second Connection attempt
      .mockRejectedValueOnce(TEST_ERROR_MESSAGE)
      .mockResolvedValueOnce(MOCK_HOST_CONFIG_RESPONSE)
      // Third Connection attempt (successful)
      .mockResolvedValueOnce("")
      .mockResolvedValueOnce(MOCK_HOST_CONFIG_RESPONSE)
      // Fourth Connection attempt
      .mockRejectedValueOnce(TEST_ERROR_MESSAGE)
      .mockResolvedValueOnce(MOCK_HOST_CONFIG_RESPONSE)
      // Fifth Connection attempt
      .mockRejectedValueOnce(TEST_ERROR_MESSAGE)
      .mockResolvedValueOnce(MOCK_HOST_CONFIG_RESPONSE)
      // Final Attempt (to avoid infinite loop)
      .mockResolvedValueOnce("")
      .mockResolvedValueOnce(MOCK_HOST_CONFIG_RESPONSE)

    const timeouts: number[] = []
    const callback = (
      _times: number,
      _errorNode: React.ReactNode,
      timeout: number
    ): void => {
      timeouts.push(timeout)
    }

    await doInitPings(
      [
        {
          hostname: "not.a.real.host",
          port: "3000",
          pathname: "/",
        } as URL,
      ],
      MOCK_PING_DATA.timeoutMs,
      MOCK_PING_DATA.maxTimeoutMs,
      callback,
      MOCK_PING_DATA.setAllowedOrigins
    )

    const timeouts2: number[] = []
    const callback2 = (
      _times: number,
      _errorNode: React.ReactNode,
      timeout: number
    ): void => {
      timeouts2.push(timeout)
    }

    await doInitPings(
      [
        {
          hostname: "not.a.real.host",
          port: "3000",
          pathname: "/",
        } as URL,
      ],
      MOCK_PING_DATA.timeoutMs,
      MOCK_PING_DATA.maxTimeoutMs,
      callback2,
      MOCK_PING_DATA.setAllowedOrigins
    )

    expect(timeouts[0]).toEqual(10)
    expect(timeouts[1]).toBeGreaterThan(timeouts[0])
    expect(timeouts2[0]).toEqual(10)
  })
})

describe("WebsocketConnection", () => {
  let client: WebsocketConnection
  let server: WS
  let originalAxiosGet: any

  beforeEach(() => {
    server = new WS("ws://localhost:1234/_stcore/stream")

    originalAxiosGet = axios.get
    axios.get = vi
      .fn()
      .mockResolvedValueOnce("")
      .mockResolvedValueOnce(MOCK_HOST_CONFIG_RESPONSE)

    client = new WebsocketConnection(createMockArgs())
  })

  afterEach(async () => {
    axios.get = originalAxiosGet

    // @ts-expect-error
    if (client.websocket) {
      // @ts-expect-error
      client.websocket.close()
    }
    server.close()
  })

  it("disconnect closes connection and sets state to DISCONNECTED_FOREVER", () => {
    client.disconnect()

    // @ts-expect-error
    expect(client.state).toBe(ConnectionState.DISCONNECTED_FOREVER)
    // @ts-expect-error
    expect(client.websocket).toBe(undefined)
  })

  it("increments message cache run count", () => {
    const incrementRunCountSpy = vi.spyOn(
      // @ts-expect-error
      client.cache,
      "incrementRunCount"
    )

    const TEST_MAX_MESSAGE_AGE = 10
    client.incrementMessageCacheRunCount(TEST_MAX_MESSAGE_AGE)

    expect(incrementRunCountSpy).toHaveBeenCalledWith(TEST_MAX_MESSAGE_AGE)
  })

  it("sends message with correct arguments", async () => {
    await server.connected
    // @ts-expect-error
    const sendSpy = vi.spyOn(client.websocket, "send")

    const TEST_BACK_MSG = {}
    client.sendMessage(TEST_BACK_MSG)

    const msg = BackMsg.create(TEST_BACK_MSG)
    const buffer = BackMsg.encode(msg).finish()

    expect(sendSpy).toHaveBeenCalledWith(buffer)
  })

  describe("getBaseUriParts", () => {
    it("returns correct base uri parts when ConnectionState == Connected", () => {
      // @ts-expect-error
      client.state = ConnectionState.CONNECTED

      expect(client.getBaseUriParts()).toEqual(
        createMockArgs().baseUriPartsList[0]
      )
    })

    it("returns undefined when ConnectionState != Connected", () => {
      expect(client.getBaseUriParts()).toBeUndefined()
    })
  })
})

describe("WebsocketConnection auth token handling", () => {
  let originalAxiosGet: any
  let websocketSpy: any
  let server: WS

  beforeEach(() => {
    server = new WS("ws://localhost:1234/_stcore/stream")
    websocketSpy = vi.spyOn(window, "WebSocket")

    originalAxiosGet = axios.get
    axios.get = vi.fn()
  })

  afterEach(() => {
    axios.get = originalAxiosGet

    server.close()
  })

  it("always sets first Sec-WebSocket-Protocol option to 'streamlit'", async () => {
    const resetHostAuthToken = vi.fn()
    const ws = new WebsocketConnection(createMockArgs({ resetHostAuthToken }))

    // Set correct state for this action
    // @ts-expect-error
    ws.state = ConnectionState.CONNECTING
    // @ts-expect-error
    await ws.connectToWebSocket()

    expect(websocketSpy).toHaveBeenCalledWith(
      "ws://localhost:1234/_stcore/stream",
      ["streamlit", "PLACEHOLDER_AUTH_TOKEN"]
    )
    expect(resetHostAuthToken).toHaveBeenCalledTimes(1)
  })

  it("sets second Sec-WebSocket-Protocol option to value from claimHostAuthToken", async () => {
    const resetHostAuthToken = vi.fn()
    const ws = new WebsocketConnection(
      createMockArgs({
        claimHostAuthToken: () => Promise.resolve("iAmAnAuthToken"),
        resetHostAuthToken,
      })
    )

    // Set correct state for this action
    // @ts-expect-error
    ws.state = ConnectionState.CONNECTING
    // @ts-expect-error
    await ws.connectToWebSocket()

    expect(websocketSpy).toHaveBeenCalledWith(
      "ws://localhost:1234/_stcore/stream",
      ["streamlit", "iAmAnAuthToken"]
    )
  })

  it("sets third Sec-WebSocket-Protocol option to lastSessionId if available", async () => {
    const ws = new WebsocketConnection(
      createMockArgs({ getLastSessionId: () => "lastSessionId" })
    )

    // Set correct state for this action
    // @ts-expect-error
    ws.state = ConnectionState.CONNECTING
    // @ts-expect-error
    await ws.connectToWebSocket()

    // "lastSessionId" should be the WebSocket's session token
    expect(websocketSpy).toHaveBeenCalledWith(
      "ws://localhost:1234/_stcore/stream",
      ["streamlit", "PLACEHOLDER_AUTH_TOKEN", "lastSessionId"]
    )
  })

  it("sets both host provided auth token and lastSessionId if both set", async () => {
    const resetHostAuthToken = vi.fn()
    const ws = new WebsocketConnection(
      createMockArgs({
        getLastSessionId: () => "lastSessionId",
        claimHostAuthToken: () => Promise.resolve("iAmAnAuthToken"),
        resetHostAuthToken,
      })
    )

    // Set correct state for this action
    // @ts-expect-error
    ws.state = ConnectionState.CONNECTING

    // @ts-expect-error
    await ws.connectToWebSocket()

    expect(websocketSpy).toHaveBeenCalledWith(
      "ws://localhost:1234/_stcore/stream",
      ["streamlit", "iAmAnAuthToken", "lastSessionId"]
    )
    expect(resetHostAuthToken).toHaveBeenCalledTimes(1)
  })
})
