export type OpenAIChatRequest = {
  model?: string
  messages?: unknown[]
  tools?: unknown[]
  [key: string]: unknown
}

export type MockOpenAIRequest = {
  request: Request
  body: OpenAIChatRequest
}

export type MockOpenAIHandler = (input: MockOpenAIRequest) => Response | Promise<Response>

export type MockOpenAI = {
  readonly baseURL: string
  readonly requests: OpenAIChatRequest[]
  close(): void
}

export function createMockOpenAI(handler: MockOpenAIHandler): MockOpenAI {
  const requests: OpenAIChatRequest[] = []
  const server = Bun.serve({
    port: 0,
    async fetch(request) {
      if (new URL(request.url).pathname !== "/v1/chat/completions") {
        return new Response("Not found", { status: 404 })
      }
      const body = (await request.json()) as OpenAIChatRequest
      requests.push(body)
      return handler({ request, body })
    },
  })

  return {
    baseURL: `http://127.0.0.1:${server.port}/v1`,
    requests,
    close: () => server.stop(true),
  }
}

export function openAIStream(
  chunks: readonly Record<string, unknown>[],
  options: { status?: number; headers?: Record<string, string> } = {},
): Response {
  const payload = [...chunks.map((chunk) => `data: ${JSON.stringify(chunk)}`), "data: [DONE]", ""].join("\n\n")
  return new Response(payload, {
    status: options.status ?? 200,
    headers: {
      "content-type": "text/event-stream",
      ...options.headers,
    },
  })
}

export function openAIText(text: string, model = "deterministic"): Response {
  return openAIStream([
    {
      id: "mock-openai",
      object: "chat.completion.chunk",
      created: 1,
      model,
      choices: [{ index: 0, delta: { role: "assistant", content: text }, finish_reason: null }],
    },
    {
      id: "mock-openai",
      object: "chat.completion.chunk",
      created: 1,
      model,
      choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    },
  ])
}

export function openAIToolCall(
  name: string,
  input: unknown,
  options: { id?: string; model?: string } = {},
): Response {
  const id = options.id ?? "mock-tool-call"
  const model = options.model ?? "deterministic"
  return openAIStream([
    {
      id: "mock-openai",
      object: "chat.completion.chunk",
      created: 1,
      model,
      choices: [
        {
          index: 0,
          delta: {
            role: "assistant",
            tool_calls: [{ index: 0, id, type: "function", function: { name, arguments: JSON.stringify(input) } }],
          },
          finish_reason: "tool_calls",
        },
      ],
    },
    {
      id: "mock-openai",
      object: "chat.completion.chunk",
      created: 1,
      model,
      choices: [],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    },
  ])
}

export function openAIError(status: number, message: string, code = "mock_error"): Response {
  return Response.json({ error: { message, type: "invalid_request_error", code } }, { status })
}
